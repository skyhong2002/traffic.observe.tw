import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { authenticate, serviceTokens } from './auth.ts';
import { type Pool, rows } from './db.ts';
import { type CodeExchange, loginConfig, registerLogin } from './login.ts';
import { availableMonths, monthView, ranking, type SiteMonth, topicSummary } from './metrics.ts';
import { html, loginPage, rankingPage, type SitePage, sitePage, statusPage, topicsPage, watchPage, whoSlot } from './pages.ts';
import { lastRadarRun, loadRadar } from './radar.ts';
import { addWatches, fetchStates, lookupResults, MANUAL, removeWatch, setWatchList, submitLookup, watchList } from './requests.ts';
import { runConfig } from './scheduler.ts';
import { aiShare, publicDomain, searchShare, type TrafficProfile, taiwanShare } from './similarweb.ts';
import { serviceStatus } from './status.ts';
import { loadTraffic } from './store.ts';

const CACHE_MS = 60_000;
const MAX_TRAFFIC_DOMAINS = 2000;

export function buildApp(
  pool: Pool,
  {
    tokens = serviceTokens(),
    config = runConfig(),
    login = loginConfig(),
    exchange,
    logger = true,
  }: {
    tokens?: Map<string, Buffer>;
    config?: ReturnType<typeof runConfig>;
    login?: ReturnType<typeof loginConfig>;
    exchange?: CodeExchange;
    logger?: boolean;
  } = {},
) {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024, trustProxy: false });
  // Reject /internal/* before the body is read, so outsiders get the same 404
  // whatever they send and never learn which routes exist.
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/internal/') && !authenticate(request, reply, tokens)) return reply;
  });
  // HTML forms on /watch/.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  const editors = registerLogin(app, pool, login, { exchange });
  // Every page's header shows the sign-in state; pages themselves stay unaware of it.
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string' || !payload.includes('<!--who-->')) return payload;
    const editor = await editors.currentEditor(request);
    if (editor) reply.header('cache-control', 'private, no-store');
    return payload.replace('<!--who-->', whoSlot(editor, editors.enabled, request.url));
  });

  // monthView reads a few thousand rows; pages and the API share one short-lived copy per month.
  const views = new Map<string, { at: number; view: Promise<SiteMonth[]> }>();
  const view = (month: string) => {
    const hit = views.get(month);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.view;
    const fresh = { at: Date.now(), view: monthView(pool, month) };
    fresh.view.catch(() => views.delete(month));
    views.set(month, fresh);
    return fresh.view;
  };
  const pickMonth = async (raw: unknown) => {
    const months = await availableMonths(pool);
    const month = typeof raw === 'string' && months.includes(raw) ? raw : (months[0] ?? null);
    return { months, month };
  };
  const topicList = (list: SiteMonth[]) =>
    topicSummary(list)
      .map((t) => ({ topic: t.topic, sites: t.sites }))
      .sort((a, b) => b.sites - a.sites);
  const rankingFor = async (query: { month?: string; topic?: string }) => {
    const { months, month } = await pickMonth(query.month);
    if (!month) return null;
    const list = await view(month);
    const topics = topicList(list);
    const topic = topics.some((t) => t.topic === query.topic) ? (query.topic as string) : null;
    return { months, month, topics, topic, list: ranking(list, topic) };
  };

  app.get('/healthz', async () => ({ ok: true }));

  // Pages.
  app.get<{ Querystring: { month?: string; topic?: string } }>('/', async (request, reply) => {
    const r = await rankingFor(request.query);
    reply.type('text/html; charset=utf-8');
    return r ? rankingPage(r.month, r.months, r.topics, r.topic, r.list) : rankingPage('', [], [], null, []);
  });
  app.get<{ Querystring: { month?: string } }>('/topics/', async (request, reply) => {
    const { months, month } = await pickMonth(request.query.month);
    reply.type('text/html; charset=utf-8');
    return topicsPage(month ?? '', months, month ? topicSummary(await view(month)) : []);
  });
  app.get<{ Params: { domain: string } }>('/site/:domain/', async (request, reply) => {
    const domain = publicDomain(request.params.domain);
    const site = domain ? await siteData(pool, domain) : null;
    reply.type('text/html; charset=utf-8');
    if (!site) return reply.code(404).send(`<!doctype html><p>沒有 ${html(request.params.domain)} 的資料。<a href="/">回月排行</a></p>`);
    return sitePage(site);
  });
  app.get<{ Querystring: { error?: string } }>('/login/', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return loginPage(request.query.error, editors.enabled);
  });
  // Editors (TRAFFIC_ADMIN_EMAILS) add and remove domains by hand.
  app.get<{ Querystring: { added?: string; refused?: string; removed?: string; error?: string } }>('/watch/', async (request, reply) => {
    const [editor, manual, others] = await Promise.all([
      editors.currentEditor(request),
      watchList(pool, MANUAL),
      rows<{ requester: string; domains: number }>(
        pool,
        'SELECT requester, COUNT(DISTINCT domain) AS domains FROM watches WHERE requester <> ? GROUP BY requester ORDER BY requester',
        [MANUAL],
      ),
    ]);
    const q = request.query;
    const flash =
      q.error === 'invalid'
        ? '沒有可以加入的網域。請輸入像 example.com.tw 的網域或完整網址。'
        : q.added !== undefined
          ? `已加入 ${Number(q.added) || 0} 個網域${Number(q.refused) ? `，${Number(q.refused)} 行看不懂而略過` : ''}。下一輪抓取會先處理。`
          : q.removed
            ? `已停止追蹤 ${q.removed}。已抓到的資料會保留。`
            : null;
    reply.type('text/html; charset=utf-8');
    return watchPage({
      editor,
      loginEnabled: editors.enabled,
      manual,
      others: others.map((o) => ({ ...o, domains: Number(o.domains) })),
      flash,
    });
  });
  const editorPost = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    if (!editors.sameOrigin(request)) {
      reply.code(403).send({ error: 'same-origin requests only' });
      return null;
    }
    const editor = await editors.currentEditor(request);
    if (!editor) reply.redirect('/auth/google?next=/watch/', 303);
    return editor;
  };
  app.post<{ Body: { domains?: string; refreshDays?: string; note?: string } }>('/watch/', async (request, reply) => {
    const editor = await editorPost(request, reply);
    if (!editor) return reply;
    const lines = String(request.body?.domains ?? '')
      .split(/[\s,]+/)
      .filter(Boolean);
    const r = lines.length
      ? await addWatches(pool, MANUAL, lines, Number(request.body?.refreshDays ?? 7), {
          by: editor.email,
          note: request.body?.note ?? null,
        })
      : { error: 'invalid_domains' as const };
    if ('error' in r || !r.added.length) return reply.redirect('/watch/?error=invalid', 303);
    request.log.info({ by: editor.email, added: r.added }, 'manual watch added');
    return reply.redirect(`/watch/?added=${r.added.length}&refused=${r.refused.length}`, 303);
  });
  app.post<{ Body: { domain?: string } }>('/watch/remove', async (request, reply) => {
    const editor = await editorPost(request, reply);
    if (!editor) return reply;
    const r = await removeWatch(pool, MANUAL, request.body?.domain, { by: editor.email });
    if ('error' in r) return reply.redirect('/watch/?error=invalid', 303);
    request.log.info({ by: editor.email, domain: r.domain }, 'manual watch removed');
    return reply.redirect(`/watch/?removed=${encodeURIComponent(r.domain)}`, 303);
  });
  app.get('/status/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return statusPage(await serviceStatus(pool, config));
  });

  // Public, read-only API.
  app.get('/api/v1/', async () => ({
    service: 'traffic.observe.tw',
    source: 'Similarweb extension estimates (monthly visits per domain, in millions) plus the GeneHong sheet for months Similarweb lacks',
    endpoints: {
      'GET /api/v1/months': 'months with data, newest first',
      'GET /api/v1/rankings?month=YYYYMM&topic=': 'one month, ranked by visits; topic optional',
      'GET /api/v1/rankings.csv?month=YYYYMM&topic=': 'the same as CSV',
      'GET /api/v1/topics?month=YYYYMM': 'per-topic growth and search/AI shares',
      'GET /api/v1/sites/:domain': 'every month for one domain',
      'GET /api/v1/status': 'worker state',
    },
  }));
  app.get('/api/v1/months', async () => ({ months: await availableMonths(pool) }));
  app.get<{ Querystring: { month?: string; topic?: string } }>('/api/v1/rankings', async (request, reply) => {
    const r = await rankingFor(request.query);
    if (!r) return reply.code(404).send({ error: 'no_data' });
    return { month: r.month, topic: r.topic, topics: r.topics, sites: r.list };
  });
  app.get<{ Querystring: { month?: string; topic?: string } }>('/api/v1/rankings.csv', async (request, reply) => {
    const r = await rankingFor(request.query);
    if (!r) return reply.code(404).send({ error: 'no_data' });
    const cell = (v: unknown) =>
      v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const head = [
      '名次',
      '網站名',
      '網域',
      '群組',
      '分類',
      '流量(百萬)',
      '成長',
      '上月名次',
      '搜尋S',
      'AI',
      '搜尋占比',
      'AI占比',
      '台灣占比',
      '來源',
    ];
    const body = r.list.map((s) =>
      [
        s.rank,
        s.name,
        s.domain,
        s.group,
        s.topics.join(', '),
        s.visits,
        s.growth,
        s.prevRank,
        s.searchVisits,
        s.aiVisits,
        s.searchShare,
        s.aiShare,
        s.taiwanShare,
        s.visitsSource,
      ]
        .map(cell)
        .join(','),
    );
    reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="traffic-${r.month}${r.topic ? `-${encodeURIComponent(r.topic)}` : ''}.csv"`);
    return `﻿${[head.join(','), ...body].join('\n')}\n`;
  });
  app.get<{ Querystring: { month?: string } }>('/api/v1/topics', async (request, reply) => {
    const { month } = await pickMonth(request.query.month);
    if (!month) return reply.code(404).send({ error: 'no_data' });
    return { month, topics: topicSummary(await view(month)) };
  });
  app.get<{ Params: { domain: string } }>('/api/v1/sites/:domain', async (request, reply) => {
    const domain = publicDomain(request.params.domain);
    const site = domain ? await siteData(pool, domain) : null;
    if (!site) return reply.code(404).send({ error: 'not_found' });
    return site;
  });
  app.get('/api/v1/status', async () => serviceStatus(pool, config));

  // Services on this machine (auth.ts). The /internal/similarweb pair keeps the
  // contract tag served, so blog's client works unchanged.
  app.post<{ Body: { domain?: unknown; kind?: unknown } }>('/internal/similarweb/requests', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const r = await submitLookup(pool, requester, request.body?.domain, request.body?.kind ?? 'similar_sites', { config });
    if ('error' in r) return reply.code(r.error === 'daily_limit' ? 429 : 400).send({ error: r.error });
    return reply.code(r.created ? 202 : 200).send(r);
  });
  app.get<{ Querystring: { domain?: string } }>('/internal/similarweb/results', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const domain = publicDomain(request.query.domain);
    if (!domain) return reply.code(400).send({ error: 'invalid_domain' });
    const result = await lookupResults(pool, requester, domain);
    if (!result.requests.length) return reply.code(404).send({ error: 'not_requested', domain });
    return result;
  });
  // { domains: [...], refreshDays } → the requester's standing list, replaced.
  app.put<{ Body: { domains?: unknown; refreshDays?: unknown } }>('/internal/v1/watch', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const r = await setWatchList(pool, requester, request.body?.domains, Number(request.body?.refreshDays ?? 7));
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return r;
  });
  // { domains: [...], refreshDays, note? } → added to the requester's standing list; the rest of the list stays.
  app.post<{ Body: { domains?: unknown; refreshDays?: unknown; note?: unknown } }>('/internal/v1/watch/add', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const note = typeof request.body?.note === 'string' ? request.body.note : null;
    const r = await addWatches(pool, requester, request.body?.domains, Number(request.body?.refreshDays ?? 7), { by: requester, note });
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return r;
  });
  // { domain } → removed from the requester's standing list (stored data stays).
  app.post<{ Body: { domain?: unknown } }>('/internal/v1/watch/remove', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const r = await removeWatch(pool, requester, request.body?.domain, { by: requester });
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return r;
  });
  // { domains: [...] } → every stored Cloudflare Radar period, for services that mirror the ranking.
  app.post<{ Body: { domains?: unknown } }>('/internal/v1/radar', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const raw = request.body?.domains;
    if (!Array.isArray(raw) || raw.length > MAX_TRAFFIC_DOMAINS) return reply.code(400).send({ error: 'invalid_domains' });
    const domains = [...new Set(raw.map(publicDomain).filter((d): d is string => !!d))];
    const [periods, run] = await Promise.all([loadRadar(pool, domains), lastRadarRun(pool)]);
    return {
      source: 'cloudflare-radar',
      scope: 'global',
      lastRun: run
        ? {
            startedAt: run.started_at.toISOString(),
            finishedAt: run.finished_at?.toISOString() ?? null,
            sent: run.sent,
            ok: run.ok,
            failed: run.failed,
            blocked: !!run.blocked,
            note: run.note,
          }
        : null,
      domains: Object.fromEntries(periods),
    };
  });
  // { domains: [...] } → every stored month and profile, plus fetch state, for services that mirror the data.
  app.post<{ Body: { domains?: unknown } }>('/internal/v1/traffic', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const raw = request.body?.domains;
    if (!Array.isArray(raw) || raw.length > MAX_TRAFFIC_DOMAINS) return reply.code(400).send({ error: 'invalid_domains' });
    const domains = [...new Set(raw.map(publicDomain).filter((d): d is string => !!d))];
    const [traffic, states, [run]] = await Promise.all([
      loadTraffic(pool, domains),
      fetchStates(pool, domains),
      rows<{ started_at: Date; refused: number; sent: number; ok: number; failed: number; note: string | null }>(
        pool,
        'SELECT started_at, refused, sent, ok, failed, note FROM runs ORDER BY id DESC LIMIT 1',
      ),
    ]);
    return {
      source: 'similarweb-extension',
      lastRun: run
        ? {
            startedAt: run.started_at.toISOString(),
            refused: !!run.refused,
            sent: run.sent,
            ok: run.ok,
            failed: run.failed,
            note: run.note,
          }
        : null,
      domains: [...traffic.values()].filter((d) => d.monthly.length),
      state: Object.fromEntries(
        [...states].map(([domain, s]) => [
          domain,
          {
            lastAttemptAt: s.last_attempt_at?.toISOString() ?? null,
            lastSuccessAt: s.last_success_at?.toISOString() ?? null,
            failures: s.failures,
            nextAttemptAt: s.next_attempt_at?.toISOString() ?? null,
          },
        ]),
      ),
    };
  });

  return app;
}

export async function siteData(pool: Pool, domain: string): Promise<SitePage | null> {
  const [traffic, labels, watchers, [state], radar] = await Promise.all([
    loadTraffic(pool, [domain]),
    rows<{
      month: string;
      group_label: string | null;
      topics: string | null;
      name: string;
      visits: number | null;
      adjusted: number;
      search_share: number | null;
      ai_share: number | null;
      taiwan_share: number | null;
    }>(
      pool,
      'SELECT month, group_label, topics, name, visits, adjusted, search_share, ai_share, taiwan_share FROM sheet_rows WHERE domain = ? ORDER BY month, row_no',
      [domain],
    ),
    rows<{ requester: string; kind: string; requested_at: Date }>(
      pool,
      'SELECT requester, kind, requested_at FROM watches WHERE domain = ?',
      [domain],
    ),
    rows<{
      last_success_at: Date | null;
      last_attempt_at: Date | null;
      next_attempt_at: Date | null;
      failures: number;
      last_error: string | null;
    }>(pool, 'SELECT last_success_at, last_attempt_at, next_attempt_at, failures, last_error FROM fetch_state WHERE domain = ?', [domain]),
    loadRadar(pool, [domain]),
  ]);
  const t = traffic.get(domain);
  if (!t && !labels.length && !watchers.length && !radar.size) return null;
  const sheetByMonth = new Map<string, (typeof labels)[number]>();
  for (const l of labels) if (!sheetByMonth.has(l.month) || sheetByMonth.get(l.month)?.adjusted) sheetByMonth.set(l.month, l);
  const months = [...new Set([...(t?.monthly.map((m) => m.month) ?? []), ...sheetByMonth.keys()])].sort();
  const profiles = (t?.profiles ?? {}) as Record<string, TrafficProfile>;
  return {
    domain,
    name: labels.at(-1)?.name ?? domain,
    labels: [...sheetByMonth.values()].map((l) => ({
      month: l.month,
      group: l.group_label,
      topics: l.topics,
      name: l.name,
      visits: l.visits,
      adjusted: !!l.adjusted,
    })),
    months: months.map((month) => {
      const sw = t?.monthly.find((m) => m.month === month);
      const sh = sheetByMonth.get(month);
      const p = profiles[month];
      return {
        month,
        similarweb: sw ? sw.visits / 1e6 : null,
        sheet: sh && !sh.adjusted ? sh.visits : null,
        searchShare: p ? searchShare(p) : (sh?.search_share ?? null),
        aiShare: p ? aiShare(p) : (sh?.ai_share ?? null),
        taiwanShare: p ? taiwanShare(p) : (sh?.taiwan_share ?? null),
      };
    }),
    watchers: watchers.map((w) => ({ requester: w.requester, kind: w.kind, requestedAt: w.requested_at.toISOString() })),
    radar: radar.get(domain) ?? [],
    state: state
      ? {
          lastSuccessAt: state.last_success_at?.toISOString() ?? null,
          lastAttemptAt: state.last_attempt_at?.toISOString() ?? null,
          nextAttemptAt: state.next_attempt_at?.toISOString() ?? null,
          failures: state.failures,
          lastError: state.last_error,
        }
      : null,
  };
}
