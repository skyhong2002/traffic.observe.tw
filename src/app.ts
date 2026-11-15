import { readFileSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { apiDocsPage, apiIndex, openApi } from './api-docs.ts';
import { authenticate, serviceTokens } from './auth.ts';
import { BRAND_HEAD, registerBrand } from './brand.ts';
import {
  collectionMonth,
  collectionMonths,
  loadCollection,
  publicCollection,
  setCollectionPriority,
  syncCollections,
  validCollectionMonth,
} from './collection.ts';
import { collectionPage, validCollectionSort, validCollectionSource } from './collection-pages.ts';
import {
  cleanTag,
  loadCrowd,
  overridesOf,
  RESERVED_TAGS,
  resolveTags,
  setAiTags,
  TagError,
  tagAction,
  voterOf,
  voterStats,
  votesOf,
} from './crowd.ts';
import { type Pool, rows } from './db.ts';
import { fetchPolicy } from './fetch-policy.ts';
import { buildHistory, type History } from './history.ts';
import { iconStore } from './icons.ts';
import { type CodeExchange, loginConfig, registerLogin } from './login.ts';
import {
  loadManualMonths,
  manualProfile,
  parseManualChannels,
  parseManualDetails,
  parseShare,
  parseVisits,
  recentMonths,
  setManualMonth,
} from './manual.ts';
import { ManualInputError } from './manual-input.ts';
import { registerManualOcr } from './manual-ocr.ts';
import { EditError, editSites, loadMetadata, type ManagedSite, managedSites } from './metadata.ts';
import { editSitePage, type ManualForm, manageSitesPage, manualPage, tagsByUse } from './metadata-pages.ts';
import { availableMonths, monthView, ranking, type SiteMonth, topicSummary } from './metrics.ts';
import { publicOrigin, registerLegacyOrigin } from './origin.ts';
import {
  discoverPage,
  JS_FLAG,
  loginPage,
  METHOD_LINK,
  methodPart,
  notFoundPage,
  rankingPage,
  SITE_CARD_SCRIPT,
  type SitePage,
  sectionTabs,
  similarPage,
  siteFooter,
  siteHeader,
  sitePage,
  sourceOf,
  statusPage,
  TRAFFIC_METHOD,
  topicsPage,
  watchPage,
  whoSlot,
} from './pages.ts';
import { lastRadarRun, loadRadar } from './radar.ts';
import { addWatches, fetchStates, lookupResults, MANUAL, removeWatch, setWatchList, submitLookup, watchList } from './requests.ts';
import { fetchProblems, runConfig } from './scheduler.ts';
import { registerSeo } from './seo.ts';
import { candidates, similarListing } from './similarsites.ts';
import { aiShare, estimated, publicDomain, searchShare, type TrafficChannel, type TrafficProfile, taiwanShare } from './similarweb.ts';
import { loadQueue, serviceStatus } from './status.ts';
import { loadTraffic } from './store.ts';
import { STYLE, STYLE_HREF, TABLES_HREF, TABLES_SCRIPT } from './style.ts';
import { latestTopics } from './tags.ts';
import { activeRules, PRODUCTS } from './tech.ts';
import { browserFetcher } from './tech-browser.ts';
import { techDomainPage, techOverview, techPage, techSection } from './tech-pages.ts';
import { checkNow, knownTechDomains, lastTechRun, loadTech, type TechRecord } from './tech-scan.ts';
import { aggregateTopics } from './topics.ts';
import { limitedTraffic, limitRows, publicTraffic, trafficAccess, twoDigits, visibleChannel } from './traffic-access.ts';

const CACHE_MS = 60_000;
/** /api/v1/history reads every month; it changes at most hourly (a Similarweb batch). */
const HISTORY_MS = 10 * 60_000;
// The report page (/): static HTML that reads /api/v1/history and draws everything client-side.
const REPORT = readFileSync(new URL('./report.html', import.meta.url), 'utf8')
  .replace('<!--brand-head-->', BRAND_HEAD)
  .replace('<!--style-->', STYLE_HREF)
  .replace('<!--tables-->', TABLES_HREF)
  .replace('<!--js-->', JS_FLAG)
  .replace('<!--tabs-->', sectionTabs('report'))
  .replace('<!--method-->', METHOD_LINK)
  .replace('<!--header-->', siteHeader('report'))
  .replace('</body>', `${SITE_CARD_SCRIPT}</body>`)
  .replace(
    '<!--footer-->',
    siteFooter(
      null,
      `${TRAFFIC_METHOD}${methodPart(
        '排名軌跡',
        '<p>同一標籤的網站依當月流量排名（所有符合條件的網站；選了來源時只算該來源追蹤的網域）。灰線是最新月份的前 10 或前 20 名，橘線是選取的網站（點線或下方表格列）。斷開處是沒有資料的月份，不補線。</p>',
      )}`,
    ),
  );
const MAX_TRAFFIC_DOMAINS = 2000;
/** Every Similarweb channel in the CSV, Similarweb's own figures (搜尋占比 and AI占比 may come from the sheet). */
const CSV_CHANNELS: Array<[TrafficChannel, string]> = [
  ['Direct', '直接造訪'],
  ['SearchOrganic', '自然搜尋'],
  ['SearchPaid', '搜尋廣告'],
  ['SocialOrganic', '社群'],
  ['SocialPaid', '社群廣告'],
  ['Referrals', '其他網站連入'],
  ['Mail', '電子郵件'],
  ['DisplayAds', '展示型廣告'],
  ['GenAi', 'AI工具'],
  ['Affiliate', '聯盟行銷'],
];
const PUBLIC_ORIGIN = publicOrigin();
/** Tags the ranking pages leave out until a visitor brings them back. */
const DEFAULT_EXCLUDE = ['非台灣'];

export function buildApp(
  pool: Pool,
  {
    tokens = serviceTokens(),
    config = runConfig(),
    login = loginConfig(),
    exchange,
    logger = true,
    icons = iconStore(),
  }: {
    tokens?: Map<string, Buffer>;
    config?: ReturnType<typeof runConfig>;
    login?: ReturnType<typeof loginConfig>;
    exchange?: CodeExchange;
    icons?: ReturnType<typeof iconStore>;
    logger?: boolean;
  } = {},
) {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024, trustProxy: false });
  // Reject /internal/* before the body is read, so outsiders get the same 404
  // whatever they send and never learn which routes exist.
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/internal/') && !authenticate(request, reply, tokens)) return reply;
  });
  registerLegacyOrigin(app, PUBLIC_ORIGIN);
  registerManualOcr(app);
  // HTML forms on /watch/.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  const editors = registerLogin(app, pool, login, { exchange });
  app.addHook('preHandler', (request, reply, done) => {
    if (request.url.startsWith('/internal/')) return done();
    editors.currentUser(request).then((user) => {
      reply.header('cache-control', 'private, no-store').header('vary', 'Cookie');
      trafficAccess.run(Boolean(user && editors.isEditor(user.email)), done);
    }, done);
  });
  app.addHook('preSerialization', async (_request, _reply, payload) => publicTraffic(payload));
  // Every page's header shows the sign-in state; pages themselves stay unaware of it.
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string' || !payload.includes('<!--who-->')) return payload;
    const user = await editors.currentUser(request);
    if (user) reply.header('cache-control', 'private, no-store');
    return payload.replace('<!--who-->', whoSlot(user, editors.enabled, request.url, Boolean(user && editors.isEditor(user.email))));
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
  // Standing lists per requester (tag's outlets, blog's blogs, the sheet, hand-added), for the source filter.
  let watchedCache: { at: number; lists: Promise<Map<string, Set<string>>> } | null = null;
  const watched = () => {
    if (watchedCache && Date.now() - watchedCache.at < CACHE_MS) return watchedCache.lists;
    const lists = rows<{ requester: string; domain: string }>(
      pool,
      "SELECT DISTINCT requester, domain FROM watches WHERE kind = 'watch'",
    ).then((list) => {
      const out = new Map<string, Set<string>>();
      // Grouped by source as the pages show it: the sheet's domains count as 手動 (sourceOf).
      for (const r of list) {
        const source = sourceOf(r.requester);
        (out.get(source) ?? out.set(source, new Set()).get(source))?.add(r.domain);
      }
      return out;
    });
    lists.catch(() => {
      watchedCache = null;
    });
    watchedCache = { at: Date.now(), lists };
    return lists;
  };
  // All sites participate; topic filters treat every label identically.
  /** One month ranked: only `topic` when given, never the tags in `exclude` (comma-separated), only `source`'s list. */
  const rankingFor = async (query: RankingQuery) => {
    const { months, month } = await pickMonth(query.month);
    if (!month) return null;
    const lists = await watched();
    const order = ['tag', 'blog', 'manual'];
    const sources = [...lists]
      .map(([requester, set]) => ({ requester, domains: set.size }))
      .sort((a, b) => (order.indexOf(a.requester) + 1 || 9) - (order.indexOf(b.requester) + 1 || 9));
    const source = typeof query.source === 'string' && lists.has(query.source) ? query.source : null;
    const all = await view(month);
    const only = source ? lists.get(source) : null;
    const list = only ? all.filter((s) => only.has(s.domain)) : all;
    // Tag chips count before exclusion, so an excluded tag stays on the page to bring back.
    const topics = topicList(list);
    // topic may list several tags (comma-separated); a site must carry all of them.
    const wanted = [...new Set(String(query.topic ?? '').split(','))].filter((t) => topics.some((x) => x.topic === t));
    const topic = wanted.length === 1 ? wanted[0] : null;
    const exclude = [...new Set(String(query.exclude ?? '').split(','))].filter(
      (t) => !wanted.includes(t) && topics.some((x) => x.topic === t),
    );
    const kept = list.filter((s) => wanted.every((t) => s.topics.includes(t)) && !s.topics.some((t) => exclude.includes(t)));
    // The comparison month (the nearest earlier month by default): growth, the earlier rank and every share's change are against it.
    const older = months.filter((m) => m < month);
    const from = typeof query.from === 'string' && older.includes(query.from) ? query.from : (older[0] ?? null);
    const before = new Map((from ? await view(from) : []).map((s) => [s.domain, s]));
    const compared = kept.map((s) => {
      const b = before.get(s.domain);
      return {
        ...s,
        prevVisits: b?.visits ?? null,
        prevSearchShare: b?.searchShare ?? null,
        prevAiShare: b?.aiShare ?? null,
        prevTaiwanShare: b?.taiwanShare ?? null,
        prevTaiwanShareUsed: b?.taiwanShareUsed ?? null,
        prevChannels: b?.channels ?? null,
      };
    });
    const queryText = (query.q ?? '').trim().toLowerCase();
    const placed = limitRows(
      ranking(compared, topic).filter((s) => !queryText || `${s.name} ${s.domain}`.toLowerCase().includes(queryText)),
    );
    const show: 'share' | 'change' = query.show === 'change' && from ? 'change' : 'share';
    const unit: 'share' | 'count' | 'tw' = query.unit === 'count' || query.unit === 'tw' ? query.unit : 'share';
    return { months, month, from, show, unit, topics, topic, exclude, source, sources, list: placed };
  };

  type RankingQuery = {
    q?: string;
    month?: string;
    from?: string;
    show?: string;
    unit?: string;
    topic?: string;
    exclude?: string;
    source?: string;
  };
  let historyCache: { at: number; data: Promise<History> } | null = null;
  const history = () => {
    if (historyCache && Date.now() - historyCache.at < HISTORY_MS) return historyCache.data;
    const data = buildHistory(pool);
    data.catch(() => {
      historyCache = null;
    });
    historyCache = { at: Date.now(), data };
    return data;
  };
  const allTopics = async () => {
    const [traffic, sites] = await Promise.all([history(), managedSites(pool)]);
    return aggregateTopics(traffic, sites);
  };

  /** The tags of known domains: what crowd.ts needs besides the votes. */
  // managedSites reads every domain and sheet row, which is slow when the machine is busy; blog and tag call the tag
  // API on every page, so one copy serves for CACHE_MS. Votes do not change the editors' lists it carries; edits clear it.
  let contextCache: { at: number; context: Promise<{ sites: Map<string, ManagedSite>; known: Set<string> }> } | null = null;
  const tagContext = () => {
    if (contextCache && Date.now() - contextCache.at < CACHE_MS) return contextCache.context;
    const context = managedSites(pool).then((sites) => ({
      sites: new Map(sites.map((s) => [s.domain, s])),
      known: new Set(sites.flatMap((s) => [...s.baseTopics, ...s.topics])),
    }));
    context.catch(() => {
      contextCache = null;
    });
    contextCache = { at: Date.now(), context };
    return context;
  };
  /** Every tag of these domains, shown or not, keyed by domain. */
  const tagsOf = async (domains: string[]) => {
    const [{ sites }, crowd] = await Promise.all([tagContext(), loadCrowd(pool, domains)]);
    return Object.fromEntries(
      domains
        .filter((d) => sites.has(d))
        .map((d) => {
          const site = sites.get(d) as ManagedSite;
          return [d, resolveTags(site.baseTopics, crowd.get(d), site.custom ? 'editor' : 'sheet')];
        }),
    );
  };
  /** One vote, added tag or override; null for a domain this site does not know, { error } for a refused change. */
  const changeTag = async (
    domain: string,
    voter: string,
    via: string,
    kind: 'vote' | 'propose' | 'admin',
    tag: unknown,
    value: unknown,
  ) => {
    const { sites, known } = await tagContext();
    const site = sites.get(domain);
    if (!site) return null;
    try {
      const done = await tagAction(pool, {
        domain,
        base: site.baseTopics,
        known,
        kind,
        tag,
        value,
        voter,
        via,
        admin: editors.isEditor(voter),
      });
      views.clear();
      historyCache = null;
      contextCache = null;
      return { tag: done };
    } catch (error) {
      if (!(error instanceof TagError)) throw error;
      return { error: error.code, status: error.status, message: error.message };
    }
  };

  const requireEditor = async (request: FastifyRequest, reply: FastifyReply, next: string) => {
    reply.header('cache-control', 'private, no-store');
    if (request.method === 'POST' && !editors.sameOrigin(request)) {
      reply.code(403).send({ error: 'same-origin requests only' });
      return null;
    }
    const editor = await editors.currentEditor(request);
    if (!editor) {
      // Signed in without editing rights: say so rather than send them round the sign-in again.
      if (await editors.currentUser(request)) reply.code(403).type('text/html').send(loginPage('not_editor', true));
      else if (editors.enabled) reply.redirect(`/auth/google?next=${encodeURIComponent(next)}`, 303);
      else reply.code(403).type('text/html').send(loginPage(undefined, false));
    }
    return editor;
  };
  const siteFor = async (domain: string) => {
    const sites = await managedSites(pool);
    return { sites, site: sites.find((s) => s.domain === publicDomain(domain)) };
  };
  /** The name and tags page; tags are offered most used first. */
  const editPage = async (domain: string, error = '', draft?: Parameters<typeof editSitePage>[3], message = '') => {
    const { sites, site } = await siteFor(domain);
    return site ? editSitePage(site, tagsByUse(sites), error, draft, message) : null;
  };
  /** The page for months copied from Similarweb's platform, with what the free endpoint last answered. */
  const manualChoices = async (domain: string) =>
    [
      ...new Set([
        ...recentMonths(),
        ...(await rows<{ month: string }>(pool, 'SELECT month FROM collection_domains WHERE domain = ?', [domain])).map((r) => r.month),
      ]),
    ]
      .filter((month) => month < new Date().toISOString().slice(0, 7).replace('-', ''))
      .sort()
      .reverse();
  const manualFor = async (
    domain: string,
    form: Pick<ManualForm, 'message' | 'error' | 'draft' | 'errorFields' | 'selectedMonth' | 'completedMonth'> = {},
  ) => {
    const { site } = await siteFor(domain);
    if (!site) return null;
    const [months, traffic] = await Promise.all([loadManualMonths(pool, { domain: site.domain }), loadTraffic(pool, [site.domain])]);
    const free = (traffic.get(site.domain)?.monthly ?? []).slice(-3).map((m) => ({ month: m.month, estimated: estimated(m.visits) }));
    return manualPage(site, { months, choices: await manualChoices(site.domain), free, ...form });
  };
  const DONE: Record<string, string> = { saved: '已儲存。', deleted: '已刪除這個月份的補登數字。' };
  app.get<{ Params: { domain: string }; Querystring: { saved?: string } }>('/site/:domain/edit/', async (request, reply) => {
    if (!(await requireEditor(request, reply, request.url))) return reply;
    const page = await editPage(request.params.domain, '', undefined, request.query.saved ? DONE.saved : '');
    if (!page) return reply.code(404).send({ error: 'not found' });
    return reply.type('text/html').send(page);
  });
  app.get<{ Params: { domain: string }; Querystring: { done?: string; month?: string } }>(
    '/site/:domain/manual/',
    async (request, reply) => {
      if (!(await requireEditor(request, reply, request.url))) return reply;
      if (!trafficAccess.getStore()) return reply.code(403).send({ error: 'full traffic access required' });
      const message = DONE[request.query.done ?? ''];
      const page = await manualFor(request.params.domain, {
        message,
        selectedMonth: request.query.month,
        completedMonth: message ? request.query.month : undefined,
      });
      if (!page) return reply.code(404).send({ error: 'not found' });
      return reply.type('text/html').send(page);
    },
  );
  app.post<{
    Params: { domain: string };
    Body: Record<string, string | undefined>;
  }>('/site/:domain/manual/', async (request, reply) => {
    const editor = await requireEditor(request, reply, `/site/${request.params.domain}/manual/`);
    if (!editor) return reply;
    if (!trafficAccess.getStore()) return reply.code(403).send({ error: 'full traffic access required' });
    const site = (await managedSites(pool)).find((s) => s.domain === publicDomain(request.params.domain));
    if (!site) return reply.code(404).send({ error: 'not found' });
    const body = request.body ?? {};
    const month = String(body.month ?? '');
    try {
      const remove = body.action === 'delete';
      if (!remove && !(await manualChoices(site.domain)).includes(month))
        throw new ManualInputError('只能補登最近三個月或已建立的月份缺漏清單。', 'month');
      const details = remove ? null : parseManualDetails(body);
      await setManualMonth(
        pool,
        editor.email,
        site.domain,
        month,
        remove
          ? null
          : {
              domain: site.domain,
              month,
              visits: parseVisits(body.visits),
              channels: parseManualChannels(body),
              details,
              searchShare: parseShare(body.search, '自然搜尋占比', 'search'),
              aiShare: parseShare(body.ai, 'Gen AI 占比', 'ai'),
              taiwanShare: parseShare(body.taiwan, '台灣占比', 'taiwan') ?? details?.countries.find((c) => c.code === 'TW')?.share ?? null,
            },
      );
      request.log.info({ by: editor.email, domain: site.domain, month, remove }, 'manual month saved');
      views.clear();
      historyCache = null;
      contextCache = null;
      return reply.redirect(`/site/${site.domain}/manual/?done=${remove ? 'deleted' : 'saved'}&month=${month}`, 303);
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      const errorFields = error instanceof ManualInputError ? error.fields.filter(Boolean) : [];
      request.log.warn({ domain: site.domain, month, reason: error.message, fields: errorFields }, 'manual month validation failed');
      const page = await manualFor(site.domain, { error: error.message, errorFields, draft: body });
      return reply.code(error.status).type('text/html').send(page);
    }
  });
  app.post<{ Params: { domain: string }; Body: { name?: string; topics?: string; revision?: string } }>(
    '/site/:domain/edit/',
    async (request, reply) => {
      const editor = await requireEditor(request, reply, request.url);
      if (!editor) return reply;
      const site = (await managedSites(pool)).find((s) => s.domain === publicDomain(request.params.domain));
      if (!site) return reply.code(404).send({ error: 'not found' });
      const body = request.body;
      try {
        if (typeof body?.name !== 'string' || typeof body.topics !== 'string' || !/^\d+$/.test(String(body.revision)))
          throw new EditError('請填寫網站名稱與標籤。');
        await editSites(pool, editor.email, {
          single: { domain: site.domain, name: body.name, topics: body.topics, revision: Number(body.revision) },
        });
        views.clear();
        historyCache = null;
        contextCache = null;
        return reply.redirect(`/site/${site.domain}/edit/?saved=1`, 303);
      } catch (error) {
        if (!(error instanceof EditError)) throw error;
        return reply
          .code(error.status)
          .type('text/html')
          .send(await editPage(site.domain, error.message, body));
      }
    },
  );
  app.get<{ Querystring: { updated?: string } }>('/sites/', async (request, reply) => {
    if (!(await requireEditor(request, reply, '/sites/'))) return reply;
    return reply
      .type('text/html')
      .send(
        manageSitesPage(await managedSites(pool), request.query.updated ? `已更新 ${Number(request.query.updated) || 0} 個網站。` : ''),
      );
  });
  app.post<{ Body: { domains?: string; add?: string; remove?: string } }>('/sites/', async (request, reply) => {
    const editor = await requireEditor(request, reply, '/sites/');
    if (!editor) return reply;
    try {
      if (typeof request.body?.domains !== 'string') throw new EditError('請選擇網站。');
      const domains = request.body.domains.split(/[\s,]+/).filter(Boolean);
      const count = await editSites(pool, editor.email, { domains, add: request.body.add ?? '', remove: request.body.remove ?? '' });
      views.clear();
      historyCache = null;
      contextCache = null;
      return reply.redirect(`/sites/?updated=${count}`, 303);
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      return reply
        .code(error.status)
        .type('text/html')
        .send(manageSitesPage(await managedSites(pool), error.message, request.body));
    }
  });

  app.get('/healthz', async () => ({ ok: true }));
  // Whether Similarweb fetching works, for status.skyhong.tw: 503 with the problems when it does not.
  app.get('/readyz', async (_request, reply) => {
    const problems = await fetchProblems(pool, config);
    reply.header('cache-control', 'no-store').code(problems.length ? 503 : 200);
    return problems.length ? { status: 'not_ready', problems } : { status: 'ready' };
  });
  // The public API and icons are read-only, so any site may call them from a browser.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/v1/') || request.url.startsWith('/icon/')) reply.header('access-control-allow-origin', '*');
    return payload;
  });
  // Site icons, only for domains this site knows, so the route is not a proxy for arbitrary hosts.
  let known: { at: number; domains: Promise<Set<string>> } | null = null;
  const knownDomains = () => {
    if (!known || Date.now() - known.at > CACHE_MS * 10) {
      // Sites similarsites.com lists as similar are shown as candidates, so they get icons too.
      const domains = Promise.all([
        managedSites(pool),
        rows<{ similar: string }>(pool, 'SELECT DISTINCT similar FROM similarsites_edges'),
      ]).then(([sites, similar]) => new Set([...sites.map((s) => s.domain), ...similar.map((r) => r.similar)]));
      domains.catch(() => {
        known = null;
      });
      known = { at: Date.now(), domains };
    }
    return known.domains;
  };
  app.get<{ Params: { domain: string } }>('/icon/:domain', async (request, reply) => {
    const domain = publicDomain(request.params.domain);
    const found = domain && (await knownDomains()).has(domain) ? await icons(domain) : null;
    if (!found) return reply.code(404).header('cache-control', 'public, max-age=86400').send();
    return reply.type(found.type).header('cache-control', 'public, max-age=604800').send(found.body);
  });
  // The shared stylesheet; pages link it with a content hash (style.ts), so it can be cached for long.
  app.get('/style.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').header('cache-control', 'public, max-age=86400').send(STYLE),
  );
  app.get('/tables.js', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').header('cache-control', 'public, max-age=86400').send(TABLES_SCRIPT),
  );
  registerBrand(app);
  // robots.txt, the sitemap, canonical links, and noindex on everything that is not a public entry page.
  registerSeo(app);

  // Pages.
  // The report: any two months compared, sources and topics filtered, rank trajectories per topic.
  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return REPORT.replace('/*traffic-digits*/4', trafficAccess.getStore() ? '4' : '2').replace(
      '/*limited-traffic*/false',
      String(limitedTraffic()),
    );
  });
  // The same month as a plain server-rendered table (works without JavaScript).
  app.get<{ Querystring: RankingQuery }>('/table/', async (request, reply) => {
    // The page leaves out 非台灣 sites unless the address says otherwise (exclude= keeps them); the API does not.
    const r = publicTraffic(await rankingFor({ ...request.query, exclude: request.query.exclude ?? DEFAULT_EXCLUDE.join(',') }));
    reply.type('text/html; charset=utf-8');
    return r
      ? rankingPage(r.month, r.months, r.topics, r.topic, r.list, r.source, r.sources, r.exclude, {
          from: r.from,
          show: r.show,
          unit: r.unit,
        })
      : rankingPage('', [], [], null, []);
  });
  app.get<{ Querystring: { topic?: string } }>('/tag/', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return topicsPage(publicTraffic(await allTopics()), request.query.topic);
  });
  // /sources/ charted channels across sites for an hour on 2026-10-24; that comparison is the full table's now.
  app.get('/sources/', async (_request, reply) => reply.redirect('/table/', 301));
  // The tags page used to live at /topics/; old links and bookmarks keep working.
  app.get('/topics/', async (request, reply) => reply.redirect(`/tag/${request.url.slice('/topics/'.length)}`, 301));
  // All of one site's similar sites (similarsites.com), public; editors can add the untracked ones.
  app.get<{ Params: { domain: string }; Querystring: { added?: string } }>('/site/:domain/similar/', async (request, reply) => {
    const domain = publicDomain(request.params.domain);
    const [site, editor, listing] = await Promise.all([
      domain ? siteData(pool, domain) : null,
      editors.currentEditor(request),
      domain ? similarListing(pool, domain) : null,
    ]);
    reply.type('text/html; charset=utf-8');
    if (!site || !listing) return reply.code(404).send(notFoundPage(request.params.domain));
    const shown = [...new Set([...listing.similar.map((e) => e.similar), ...listing.listedBy.map((l) => l.domain)])];
    const tracked = new Set((await loadTraffic(pool, shown)).keys());
    const names = new Map((await managedSites(pool)).filter((s) => tracked.has(s.domain)).map((s) => [s.domain, s.name]));
    return similarPage({
      added: Number(request.query.added) || 0,
      site: { domain: site.domain, name: site.name },
      editor,
      loginEnabled: editors.enabled,
      listing,
      tracked,
      names,
    });
  });
  app.get<{ Params: { domain: string }; Querystring: { tags?: string } }>('/site/:domain/', async (request, reply) => {
    const domain = publicDomain(request.params.domain);
    const site = domain ? await siteData(pool, domain) : null;
    reply.type('text/html; charset=utf-8');
    if (!site) return reply.code(404).send(notFoundPage(request.params.domain));
    const user = await editors.currentUser(request);
    const editor = user && editors.isEditor(user.email);
    const tech = (await loadTech(pool, [site.domain])).get(site.domain) ?? null;
    return sitePage(
      publicTraffic(site),
      !!editor,
      {
        loginEnabled: editors.enabled,
        signedIn: !!user,
        admin: !!editor,
        votes: user
          ? ((await (editor ? overridesOf(pool, [site.domain]) : votesOf(pool, user.email, [site.domain])))[site.domain] ?? {})
          : {},
        message: typeof request.query.tags === 'string' ? request.query.tags : undefined,
      },
      techSection(site.domain, tech),
    );
  });
  // Votes, added tags and admin overrides from the site page's tag block; back to the block afterwards.
  app.post<{ Params: { domain: string }; Body: { kind?: string; tag?: string; value?: string } }>(
    '/site/:domain/tags/',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!editors.sameOrigin(request)) return reply.code(403).send({ error: 'same-origin requests only' });
      const domain = publicDomain(request.params.domain);
      const user = await editors.currentUser(request);
      if (!user) return reply.redirect(`/auth/google?next=${encodeURIComponent(`/site/${domain ?? ''}/#tags`)}`, 303);
      const body = request.body ?? {};
      const kind = body.kind === 'vote' || body.kind === 'propose' || body.kind === 'admin' ? body.kind : null;
      const r =
        domain && kind
          ? await changeTag(domain, user.email, 'web', kind, body.tag, kind === 'vote' ? Number(body.value) : body.value)
          : null;
      if (!r) return reply.code(404).send({ error: 'not found' });
      return reply.redirect(`/site/${domain}/?tags=${'error' in r ? r.error : 'done'}#tags`, 303);
    },
  );
  // Technologies on each site's homepage (tech-scan.ts runs in the worker). The overview reads every record, so one
  // copy serves for CACHE_MS; a check from /tech/<domain>/ clears it.
  let techCache: { at: number; data: Promise<{ domains: string[]; names: Map<string, string>; records: Map<string, TechRecord> }> } | null =
    null;
  const techData = () => {
    if (techCache && Date.now() - techCache.at < CACHE_MS) return techCache.data;
    const data = Promise.all([knownTechDomains(pool), tagContext(), loadTech(pool)]).then(([domains, { sites }, records]) => ({
      domains,
      names: new Map([...sites].map(([d, site]) => [d, site.name])),
      records,
    }));
    data.catch(() => {
      techCache = null;
    });
    techCache = { at: Date.now(), data };
    return data;
  };
  type TechQuery = { source?: string; category?: string; technology?: string; status?: string };
  const overview = async (query: TechQuery) => {
    const [{ domains, names, records }, lists] = await Promise.all([techData(), watched()]);
    return techOverview(domains, names, records, lists, query);
  };
  // Checks asked for on /tech/<domain>/: ten an hour per account, so the page is not a free crawler.
  const checks = new Map<string, number[]>();
  const allowCheck = (email: string) => {
    const now = Date.now();
    const recent = (checks.get(email) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= 10) return false;
    checks.set(email, [...recent, now]);
    return true;
  };
  app.get<{ Querystring: TechQuery & { view?: string } }>('/tech/', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return techPage(await overview(request.query), request.query.view);
  });
  app.get<{ Querystring: { domain?: string } }>('/tech/lookup', async (request, reply) => {
    const domain = publicDomain(request.query.domain);
    return reply.redirect(domain ? `/tech/${domain}/` : '/tech/', 303);
  });
  app.get<{ Params: { domain: string }; Querystring: { done?: string } }>('/tech/:domain/', async (request, reply) => {
    const domain = publicDomain(request.params.domain);
    reply.type('text/html; charset=utf-8');
    if (!domain) return reply.code(404).send(notFoundPage(request.params.domain));
    if (domain !== request.params.domain) return reply.redirect(`/tech/${domain}/`, 301);
    const [{ domains, names }, record, user] = await Promise.all([
      techData(),
      loadTech(pool, [domain]).then((m) => m.get(domain) ?? null),
      editors.currentUser(request),
    ]);
    return techDomainPage(domain, names.get(domain) ?? null, record, domains.includes(domain), {
      loginEnabled: editors.enabled,
      signedIn: !!user,
      message: request.query.done,
    });
  });
  app.post<{ Params: { domain: string } }>('/tech/:domain/check', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!editors.sameOrigin(request)) return reply.code(403).send({ error: 'same-origin requests only' });
    const domain = publicDomain(request.params.domain);
    if (!domain) return reply.code(404).send({ error: 'not found' });
    const user = await editors.currentUser(request);
    if (!user) return reply.redirect(`/auth/google?next=${encodeURIComponent(`/tech/${domain}/`)}`, 303);
    if (!allowCheck(user.email)) return reply.redirect(`/tech/${domain}/?done=rate_limited`, 303);
    const browser = browserFetcher();
    const r = await checkNow(pool, domain, { fallback: browser.fetchPage }).finally(() => browser.close());
    if ('error' in r)
      return reply.redirect(`/tech/${domain}/?done=${r.error === 'no_rules' ? 'no_rules' : r.error === 'busy' ? 'busy' : 'checked'}`, 303);
    techCache = null;
    return reply.redirect(`/tech/${domain}/?done=${r.fresh ? 'checked' : 'recent'}`, 303);
  });
  app.get<{ Querystring: { error?: string } }>('/login/', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return loginPage(request.query.error, editors.enabled);
  });
  // Editors (TRAFFIC_ADMIN_EMAILS) add and remove domains by hand.
  app.get<{ Querystring: { added?: string; refused?: string; removed?: string; error?: string; list?: string } }>(
    '/watch/',
    async (request, reply) => {
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
      const listOf = typeof q.list === 'string' && q.list !== 'sheet' && others.some((o) => o.requester === q.list) ? q.list : null;
      const { entries, refusedSince: refused } = await loadQueue(pool, config);
      const queue = new Map(entries.map((e) => [e.domain, e]));
      const flash =
        q.error === 'invalid'
          ? '沒有可以加入的網域。請輸入像 example.com.tw 的網域或完整網址。'
          : q.added !== undefined
            ? `已加入 ${Number(q.added) || 0} 個網域${Number(q.refused) ? `，${Number(q.refused)} 行看不懂而略過` : ''}，已排進抓取佇列。`
            : q.removed
              ? `已停止追蹤 ${q.removed}。已抓到的資料會保留。`
              : null;
      reply.type('text/html; charset=utf-8');
      return watchPage({
        editor,
        loginEnabled: editors.enabled,
        manual: publicTraffic(limitRows(manual)),
        others: others.map((o) => ({ ...o, domains: Number(o.domains) })),
        flash,
        list: listOf ? { requester: listOf, rows: publicTraffic(limitRows(await watchList(pool, listOf))) } : null,
        queue,
        refused,
      });
    },
  );
  // Similar sites (similarsites.com) of tracked sites that are not tracked yet; the add button posts to /watch/.
  app.get<{ Querystring: { min?: string; added?: string; tw?: string } }>('/discover/', async (request, reply) => {
    const minVotes = [1, 2, 3, 5].includes(Number(request.query.min)) ? Number(request.query.min) : 2;
    const taiwanOnly = request.query.tw === '1';
    const [editor, found, [counts]] = await Promise.all([
      editors.currentEditor(request),
      candidates(pool, { minVotes, limit: 200, taiwanOnly }),
      rows<{ answered: number; tracked: number }>(
        pool,
        `SELECT (SELECT COUNT(*) FROM similarsites_state WHERE status = 'ok') AS answered,
                (SELECT COUNT(DISTINCT domain) FROM traffic_months) AS tracked`,
      ),
    ]);
    const listers = [...new Set(found.flatMap((c) => c.listedBy))];
    const tracked = new Set((await loadTraffic(pool, listers)).keys());
    reply.type('text/html; charset=utf-8');
    return discoverPage({
      added: Number(request.query.added) || 0,
      editor,
      loginEnabled: editors.enabled,
      found,
      minVotes,
      taiwanOnly,
      fetched: { answered: Number(counts?.answered ?? 0), tracked: Number(counts?.tracked ?? 0) },
      tracked,
    });
  });
  const editorPost = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    if (!editors.sameOrigin(request)) {
      reply.code(403).send({ error: 'same-origin requests only' });
      return null;
    }
    const editor = await editors.currentEditor(request);
    if (!editor) {
      if (await editors.currentUser(request)) reply.code(403).type('text/html').send(loginPage('not_editor', true));
      else reply.redirect('/auth/google?next=/watch/', 303);
    }
    return editor;
  };
  app.post<{ Body: { domains?: string; note?: string; back?: string } }>('/watch/', async (request, reply) => {
    const editor = await editorPost(request, reply);
    if (!editor) return reply;
    const lines = String(request.body?.domains ?? '')
      .split(/[\s,]+/)
      .filter(Boolean);
    const r = lines.length
      ? await addWatches(pool, MANUAL, lines, {
          by: editor.email,
          note: request.body?.note ?? null,
        })
      : { error: 'invalid_domains' as const };
    // The add buttons on the discover and similar-sites pages send JSON requests and stay on their page; the same forms
    // without JavaScript come back to `back` (a path on this site) with a count.
    const asJson = String(request.headers.accept ?? '').includes('application/json');
    if ('error' in r || !r.added.length)
      return asJson ? reply.code(400).send({ error: 'invalid' }) : reply.redirect('/watch/?error=invalid', 303);
    request.log.info({ by: editor.email, added: r.added }, 'manual watch added');
    if (asJson) return { added: r.added.length };
    const back = /^\/(?!\/)[^\s\\]*$/.test(request.body?.back ?? '') ? (request.body?.back as string) : null;
    return reply.redirect(
      back
        ? `${back}${back.includes('?') ? '&' : '?'}added=${r.added.length}`
        : `/watch/?added=${r.added.length}&refused=${r.refused.length}`,
      303,
    );
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
  app.get<{
    Querystring: { month?: string; state?: string; priority?: string; page?: string; saved?: string; source?: string; sort?: string };
  }>('/status/collection/', async (request, reply) => {
    const month = request.query.month ?? collectionMonth(config);
    if (!validCollectionMonth(month)) return reply.code(400).send({ error: 'invalid month' });
    const [collection, months, editor, policy] = await Promise.all([
      loadCollection(pool, config, month),
      collectionMonths(pool, config),
      editors.currentEditor(request),
      fetchPolicy(pool, config),
    ]);
    const state = ['all', 'missing', 'pending', 'retry', 'retry-wait', 'manual-needed', 'complete'].includes(request.query.state ?? '')
      ? request.query.state!
      : 'all';
    reply.type('text/html; charset=utf-8');
    return collectionPage(
      collection,
      [...new Set([month, ...months])].sort().reverse(),
      !!editor,
      state,
      Math.max(0, Math.min(4, Math.floor(Number(request.query.priority) || 0))),
      Math.max(1, Math.floor(Number(request.query.page) || 1)),
      publicDomain(request.query.saved) || '',
      validCollectionSource(request.query.source),
      policy,
      validCollectionSort(request.query.sort),
    );
  });
  app.post<{
    Body: {
      domain?: string;
      priority?: string;
      month?: string;
      state?: string;
      filterPriority?: string;
      page?: string;
      source?: string;
      sort?: string;
    };
  }>('/status/collection/priority', async (request, reply) => {
    const editor = await editorPost(request, reply);
    if (!editor) return reply;
    const domain = publicDomain(request.body?.domain);
    const priority = Number(request.body?.priority);
    if (!domain || request.body?.priority === undefined || !Number.isInteger(priority) || priority < 0 || priority > 4)
      return reply.code(400).send({ error: 'invalid priority' });
    try {
      await setCollectionPriority(pool, domain, priority, editor.email);
    } catch {
      return reply.code(400).send({ error: 'unknown domain' });
    }
    const month = validCollectionMonth(request.body?.month) ? request.body.month : collectionMonth(config);
    const state = ['all', 'missing', 'pending', 'retry', 'retry-wait', 'manual-needed', 'complete'].includes(request.body?.state ?? '')
      ? request.body.state!
      : 'all';
    const filterPriority = Math.max(0, Math.min(4, Math.floor(Number(request.body?.filterPriority) || 0)));
    const page = Number.isFinite(Number(request.body?.page)) ? Math.max(1, Math.floor(Number(request.body?.page))) : 1;
    const source = validCollectionSource(request.body?.source);
    const sort = validCollectionSort(request.body?.sort);
    return reply.redirect(
      `/status/collection/?${new URLSearchParams({ month, state, priority: String(filterPriority), source, sort, page: String(page), saved: domain })}`,
      303,
    );
  });
  app.post<{ Body: { month?: string } }>('/status/collection/month', async (request, reply) => {
    const editor = await editorPost(request, reply);
    if (!editor) return reply;
    const month = request.body?.month;
    if (!validCollectionMonth(month) || month >= new Date().toISOString().slice(0, 7).replace('-', ''))
      return reply.code(400).send({ error: 'invalid month' });
    await syncCollections(pool, { ...config, targetMonth: month });
    return reply.redirect(`/status/collection/?month=${month}`, 303);
  });

  // Public, read-only API.
  // The API, described once in api-docs.ts: the page, the JSON index and the OpenAPI document.
  app.get('/api/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return apiDocsPage(PUBLIC_ORIGIN);
  });
  app.get('/api/v1/', async () => apiIndex(PUBLIC_ORIGIN));
  app.get('/api/v1/openapi.json', async () => openApi(PUBLIC_ORIGIN));
  app.get('/api/v1/months', async () => ({ months: await availableMonths(pool) }));
  app.get<{ Querystring: RankingQuery }>('/api/v1/history', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const data = await history();
    if (!limitedTraffic()) return data;
    const result = await rankingFor(request.query);
    const domains = new Set(result?.list.map((s) => s.domain) ?? []);
    return {
      ...data,
      filterTopics: result?.topics ?? [],
      sites: Object.fromEntries(Object.entries(data.sites).filter(([domain]) => domains.has(domain))),
      radar: Object.fromEntries(Object.entries(data.radar).filter(([domain]) => domains.has(domain))),
    };
  });
  app.get<{ Querystring: RankingQuery }>('/api/v1/rankings', async (request, reply) => {
    const r = publicTraffic(await rankingFor(request.query));
    if (!r) return reply.code(404).send({ error: 'no_data' });
    return { month: r.month, from: r.from, topic: r.topic, exclude: r.exclude, source: r.source, topics: r.topics, sites: r.list };
  });
  app.get<{ Querystring: RankingQuery }>('/api/v1/rankings.csv', async (request, reply) => {
    const r = publicTraffic(await rankingFor(request.query));
    if (!r) return reply.code(404).send({ error: 'no_data' });
    const cell = (v: unknown) =>
      v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const head = [
      '名次',
      '網站名',
      '網域',
      '原表標籤 A',
      '標籤',
      '流量(百萬)',
      '台灣造訪(百萬)',
      '台灣占比採用',
      '台灣占比依據(measured/manual/history/bound)',
      '成長',
      '上月名次',
      '搜尋S',
      'AI',
      '台灣搜尋S(估算)',
      '台灣AI(估算)',
      '搜尋占比',
      'AI占比',
      '台灣占比',
      '來源',
      ...CSV_CHANNELS.filter(([key]) => visibleChannel(key)).map(([, label]) => `${label}占比`),
      '比較月份',
      ...CSV_CHANNELS.filter(([key]) => visibleChannel(key)).map(([, label]) => `${label}占比差距`),
    ];
    const body = r.list.map((s) =>
      [
        s.rank,
        s.name,
        s.domain,
        s.group,
        s.topics.join(', '),
        s.visits,
        s.taiwanVisits,
        s.taiwanShareUsed,
        s.taiwanBasis,
        s.growth,
        s.prevRank,
        s.searchVisits,
        s.aiVisits,
        s.taiwanSearchVisits,
        s.taiwanAiVisits,
        s.searchShare,
        s.aiShare,
        s.taiwanShare,
        s.visitsSource,
        ...CSV_CHANNELS.filter(([key]) => visibleChannel(key)).map(([key]) => (s.channels ? (s.channels[key] ?? null) : null)),
        r.from,
        ...CSV_CHANNELS.filter(([key]) => visibleChannel(key)).map(([key]) =>
          s.channels?.[key] != null && s.prevChannels?.[key] != null
            ? trafficAccess.getStore()
              ? (s.channels[key] ?? 0) - (s.prevChannels[key] ?? 0)
              : twoDigits((s.channels[key] ?? 0) - (s.prevChannels[key] ?? 0))
            : null,
        ),
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
  app.get<{ Querystring: { topic?: string } }>('/api/v1/topics/all', async (request, reply) => {
    const data = await allTopics();
    const topic = typeof request.query.topic === 'string' ? request.query.topic : null;
    if (topic !== null && !data.topics.some((t) => t.topic === topic)) return reply.code(404).send({ error: 'unknown_topic' });
    return {
      scope: 'all',
      months: data.months,
      topics: data.topics,
      ...(topic !== null ? { topic, sites: limitRows(data.sites.filter((s) => s.topics.includes(topic))) } : {}),
    };
  });
  app.get<{ Params: { domain: string } }>('/api/v1/sites/:domain', async (request, reply) => {
    const domain = publicDomain(request.params.domain);
    const site = domain ? await siteData(pool, domain) : null;
    if (!site) return reply.code(404).send({ error: 'not_found' });
    return site;
  });
  app.get<{ Params: { domain: string } }>('/api/v1/tags/:domain', async (request, reply) => {
    const domain = publicDomain(request.params.domain);
    const tags = domain ? (await tagsOf([domain]))[domain] : undefined;
    if (!domain || !tags) return reply.code(404).send({ error: 'not_found' });
    return { domain, tags };
  });
  app.get<{ Querystring: TechQuery }>('/api/v1/tech', async (request) => {
    const o = await overview(request.query);
    return { ...o, rules: activeRules()?.version ?? null, products: PRODUCTS.size };
  });
  app.get<{ Params: { domain: string } }>('/api/v1/tech/:domain', async (request, reply) => {
    const domain = publicDomain(request.params.domain);
    const record = domain ? (await loadTech(pool, [domain])).get(domain) : undefined;
    if (!record) return reply.code(404).send({ error: 'not_found' });
    return record;
  });
  app.get('/api/v1/status', async () => serviceStatus(pool, config));
  app.get<{ Querystring: { month?: string } }>('/api/v1/collection', async (request, reply) => {
    const month = request.query.month ?? collectionMonth(config);
    if (!validCollectionMonth(month)) return reply.code(400).send({ error: 'invalid month' });
    return publicCollection(await loadCollection(pool, config, month));
  });

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
  // { domains: [...] } → the requester's standing list, replaced. Every watched domain is refreshed monthly; a
  // refreshDays sent by older clients is ignored.
  app.put<{ Body: { domains?: unknown } }>('/internal/v1/watch', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const r = await setWatchList(pool, requester, request.body?.domains);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return r;
  });
  // { domains: [...], note? } → added to the requester's standing list; the rest of the list stays.
  app.post<{ Body: { domains?: unknown; note?: unknown } }>('/internal/v1/watch/add', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const note = typeof request.body?.note === 'string' ? request.body.note : null;
    const r = await addWatches(pool, requester, request.body?.domains, { by: requester, note });
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
  // Tags for the other services (blog, tag), which show them and pass on their signed-in readers' votes.
  // The reader is the verified Google email the service signed in; admin rights follow TRAFFIC_ADMIN_EMAILS.
  // { domains: [...], voter? } → every tag of each known domain, plus that reader's votes and admin flag.
  app.post<{ Body: { domains?: unknown; voter?: unknown } }>('/internal/v1/tags', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const raw = request.body?.domains;
    if (!Array.isArray(raw) || raw.length > MAX_TRAFFIC_DOMAINS) return reply.code(400).send({ error: 'invalid_domains' });
    const domains = [...new Set(raw.map(publicDomain).filter((d): d is string => !!d))];
    const voter = request.body?.voter === undefined ? null : voterOf(request.body.voter);
    if (request.body?.voter !== undefined && !voter) return reply.code(400).send({ error: 'invalid_voter' });
    const tags = await tagsOf(domains);
    return {
      domains: tags,
      // An admin's votes are the overrides, since an admin's agree or disagree sets or hides the tag.
      ...(voter
        ? {
            voter: {
              email: voter,
              admin: editors.isEditor(voter),
              votes: await (editors.isEditor(voter) ? overridesOf(pool, Object.keys(tags)) : votesOf(pool, voter, Object.keys(tags))),
            },
          }
        : {}),
    };
  });
  // { voter, domain, tag, vote: 1 | -1 | 0 } · { voter, domain, tag } · { voter, domain, tag, action: set | hide | release }
  for (const kind of ['vote', 'propose', 'admin'] as const)
    app.post<{ Body: { voter?: unknown; domain?: unknown; tag?: unknown; vote?: unknown; action?: unknown } }>(
      `/internal/v1/tags/${kind}`,
      async (request, reply) => {
        const requester = authenticate(request, reply, tokens);
        if (!requester) return reply;
        const body = request.body ?? {};
        const voter = voterOf(body.voter);
        const domain = publicDomain(body.domain);
        if (!voter) return reply.code(400).send({ error: 'invalid_voter' });
        if (!domain) return reply.code(400).send({ error: 'invalid_domain' });
        const r = await changeTag(domain, voter, requester, kind, body.tag, kind === 'vote' ? body.vote : body.action);
        if (!r) return reply.code(404).send({ error: 'unknown_domain', domain });
        if ('error' in r) return reply.code(r.status ?? 400).send({ error: r.error, message: r.message });
        request.log.info({ requester, voter, domain, kind, tag: r.tag }, 'tag changed');
        return { ok: true, domain, tag: r.tag, tags: (await tagsOf([domain]))[domain] };
      },
    );
  // { sites: [{ domain, tags: [tag | { tag, reason? }], reason? }] } → this service's AI suggestions for those domains,
  // replaced. A tag's own reason comes before the site's. Political leaning (RESERVED_TAGS) is dropped.
  app.put<{ Body: { sites?: unknown } }>('/internal/v1/tags/ai', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const raw = request.body?.sites;
    if (!Array.isArray(raw) || raw.length > 500) return reply.code(400).send({ error: 'invalid_sites' });
    const { sites, known } = await tagContext();
    const reasonOf = (value: unknown) => (typeof value === 'string' && value ? value.slice(0, 2000) : null);
    const list: Array<{ domain: string; tags: Array<{ tag: string; reason: string | null }> }> = [];
    const skipped: unknown[] = [];
    for (const item of raw as Array<{ domain?: unknown; tags?: unknown; reason?: unknown }>) {
      const domain = publicDomain(item?.domain);
      const tags =
        Array.isArray(item?.tags) && item.tags.length <= 20
          ? item.tags.map((t: unknown) => {
              const entry = (typeof t === 'object' && t !== null ? t : { tag: t }) as { tag?: unknown; reason?: unknown };
              const tag = cleanTag(entry.tag, known);
              return tag ? { tag, reason: reasonOf(entry.reason) ?? reasonOf(item.reason) } : null;
            })
          : null;
      if (!domain || !sites.has(domain) || !tags || tags.some((t) => !t) || list.some((x) => x.domain === domain)) {
        skipped.push(item?.domain ?? null);
        continue;
      }
      const kept = (tags as Array<{ tag: string; reason: string | null }>).filter((t) => !RESERVED_TAGS.has(t.tag));
      list.push({ domain, tags: kept.filter((t, i) => kept.findIndex((x) => x.tag === t.tag) === i) });
    }
    const changed = await setAiTags(pool, requester, list);
    if (changed) {
      views.clear();
      historyCache = null;
      contextCache = null;
    }
    request.log.info({ requester, sites: list.length, changed, skipped: skipped.length }, 'ai tags replaced');
    return { ok: true, sites: list.length, changed, skipped };
  });
  // { voters: [email...], via? } → each voter's standing votes and last vote time (only those cast via `via` when given).
  app.post<{ Body: { voters?: unknown; via?: unknown } }>('/internal/v1/tags/voters', async (request, reply) => {
    const requester = authenticate(request, reply, tokens);
    if (!requester) return reply;
    const raw = request.body?.voters;
    const via = request.body?.via;
    if (!Array.isArray(raw) || raw.length > 500) return reply.code(400).send({ error: 'invalid_voters' });
    if (via !== undefined && (typeof via !== 'string' || !/^[a-z0-9]{1,16}$/.test(via)))
      return reply.code(400).send({ error: 'invalid_via' });
    const voters = raw.map(voterOf);
    if (voters.some((v) => !v)) return reply.code(400).send({ error: 'invalid_voters' });
    return { voters: await voterStats(pool, [...new Set(voters as string[])], via as string | undefined) };
  });
  // { domains: [...] } → every stored month and profile, plus fetch state, for services that mirror the data.
  // Every stored technology record of the domains asked for (blog's /tech/ and blog pages read these).
  app.post<{ Body: { domains?: unknown } }>('/internal/v1/tech', async (request, reply) => {
    const raw = request.body?.domains;
    if (!Array.isArray(raw) || raw.length > MAX_TRAFFIC_DOMAINS) return reply.code(400).send({ error: 'invalid_domains' });
    const domains = [...new Set(raw.map(publicDomain).filter((d): d is string => !!d))];
    const [records, run] = await Promise.all([loadTech(pool, domains), lastTechRun(pool)]);
    return {
      generatedAt: new Date().toISOString(),
      rules: activeRules()?.version ?? null,
      lastRun: run
        ? {
            startedAt: run.started_at.toISOString(),
            finishedAt: run.finished_at?.toISOString() ?? null,
            sent: run.sent,
            ok: run.ok,
            failed: run.failed,
          }
        : null,
      sites: Object.fromEntries(records),
      notChecked: domains.filter((d) => !records.has(d)),
    };
  });
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
  const [traffic, labels, watchers, [state], radar, metadata, manual, crowd] = await Promise.all([
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
      result: unknown;
    }>(pool, 'SELECT last_success_at, last_attempt_at, next_attempt_at, failures, last_error, result FROM fetch_state WHERE domain = ?', [
      domain,
    ]),
    loadRadar(pool, [domain]),
    loadMetadata(pool),
    loadManualMonths(pool, { domain }),
    loadCrowd(pool, [domain]),
  ]);
  const t = traffic.get(domain);
  if (!t && !labels.length && !watchers.length && !radar.size && !metadata.has(domain) && !manual.length && !crowd.size) return null;
  const custom = metadata.get(domain)?.topics;
  const tags = resolveTags(
    custom ?? latestTopics(labels.map((l) => ({ ...l, group: l.group_label }))),
    crowd.get(domain),
    custom ? 'editor' : 'sheet',
  );
  const byHand = new Map(manual.map((m) => [m.month, m]));
  const sheetByMonth = new Map<string, (typeof labels)[number]>();
  for (const l of labels) if (!sheetByMonth.has(l.month) || sheetByMonth.get(l.month)?.adjusted) sheetByMonth.set(l.month, l);
  const months = [...new Set([...(t?.monthly.map((m) => m.month) ?? []), ...sheetByMonth.keys(), ...byHand.keys()])].sort();
  const profiles = (t?.profiles ?? {}) as Record<string, TrafficProfile>;
  const profiled = Object.values(profiles)
    .filter((p) => t?.monthly.some((m) => m.month === p.month && estimated(m.visits)))
    .concat(manual.filter((m) => !t?.monthly.some((v) => v.month === m.month && estimated(v.visits))).map(manualProfile))
    .sort((a, b) => a.month.localeCompare(b.month));
  const raw = state?.result;
  const summary = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { category?: string | null; similarSites?: string[] } | null;
  // similarsites.com's list carries a similarity grade; Similarweb's own list is the fallback for sites it has not answered for.
  const similarEdges = await rows<{ similar: string; grade: number }>(
    pool,
    'SELECT similar, grade FROM similarsites_edges WHERE domain = ? ORDER BY similarity_rank',
    [domain],
  );
  const similarSites = similarEdges.length ? similarEdges.map((e) => e.similar) : (summary?.similarSites ?? []);
  return {
    domain,
    name: metadata.get(domain)?.name ?? labels.at(-1)?.name ?? domain,
    topics: tags.filter((x) => x.visible).map((x) => x.tag),
    tags,
    labels: labels.map((l) => ({
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
      const noEstimate = !!sw && !estimated(sw.visits);
      const p = noEstimate ? undefined : profiles[month];
      // As in the rankings: Similarweb, then a month entered from its platform, then the sheet.
      const hand = sw && !noEstimate ? undefined : byHand.get(month);
      return {
        month,
        similarweb: sw && !noEstimate ? sw.visits / 1e6 : null,
        noEstimate,
        manual: byHand.has(month) ? (byHand.get(month)?.visits ?? 0) / 1e6 : null,
        sheet: sh && !sh.adjusted ? sh.visits : null,
        searchShare: p ? searchShare(p) : hand ? hand.searchShare : (sh?.search_share ?? null),
        aiShare: p ? aiShare(p) : hand ? hand.aiShare : (sh?.ai_share ?? null),
        taiwanShare: p ? taiwanShare(p) : hand ? hand.taiwanShare : (sh?.taiwan_share ?? null),
      };
    }),
    // The newest month Similarweb profiled with an estimate: rank, engagement, every channel and the top countries.
    profile: profiled.at(-1) ?? null,
    profiles: profiled,
    manualProfiles: manual.map(manualProfile),
    category: summary?.category ?? null,
    similarSites,
    similarGrades: Object.fromEntries(similarEdges.map((e) => [e.similar, Number(e.grade)])),
    trackedSimilar: [...(await loadTraffic(pool, similarSites)).keys()],
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
