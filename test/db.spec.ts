import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createPool, migrate, type Pool, rows } from '../src/db.ts';
import { recentMonths } from '../src/manual.ts';
import { editSites, managedSites } from '../src/metadata.ts';
import { monthView, ranking, topicSummary } from '../src/metrics.ts';
import { radarLabel } from '../src/pages.ts';
import { runRadar } from '../src/radar.ts';
import { lastMonthShare, runConfig, runOnce } from '../src/scheduler.ts';
import { saveSheet } from '../src/sheet.ts';

// Against a scratch database (TRAFFIC_TEST_DB_URL); every table is dropped first.
const url = process.env.TRAFFIC_TEST_DB_URL;
const TOKEN = 'b'.repeat(40);
const TAG = 't'.repeat(40);

const similarweb = (domain: string) => ({
  SiteName: domain,
  Category: 'News_and_Media',
  EstimatedMonthlyVisits: { '2026-07-01': 1_000_000, '2026-08-01': 1_100_000, '2026-09-01': 1_200_000 },
  Engagments: { Year: '2026', Month: '9', BounceRate: '0.5', PagePerVisit: '2', TimeOnSite: '100' },
  TrafficSources: { SearchOrganic: 0.3, GenAi: 0.01 },
  TopCountryShares: [{ CountryCode: 'TW', Value: 0.9 }],
  Competitors: { TopSimilarityCompetitors: [{ Domain: 'other.com.tw' }] },
});
const fakeFetch = (status = 200) => {
  const sent: string[] = [];
  const request = (async (input: string) => {
    const domain = new URL(input).searchParams.get('domain') as string;
    sent.push(domain);
    return new Response(JSON.stringify(similarweb(domain)), { status });
  }) as unknown as typeof fetch;
  return { request, sent };
};
const run = (pool: Pool, request: typeof fetch, budget = 5) =>
  runOnce(pool, {
    config: runConfig({ TRAFFIC_RUN_BUDGET: String(budget) }),
    request,
    pauseMs: 0,
    now: () => new Date('2026-10-21T10:00:00Z'),
  });

describe.skipIf(!url)('with a database', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(url, { size: 4, multipleStatements: true });
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    const tables = await rows<{ t: string }>(pool, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
    for (const { t } of tables) await pool.query(`DROP TABLE \`${t}\``);
    await migrate(pool);
  });
  const app = () =>
    buildApp(pool, {
      tokens: new Map([
        ['blog', Buffer.from(TOKEN)],
        ['tag', Buffer.from(TAG)],
      ]),
      login: null,
      logger: false,
    });

  it('sends at most the budget, highest priority first, and stores months and profiles', async () => {
    const now = new Date('2026-10-21T00:00:00Z');
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at) VALUES ?', [
      [
        ['sheet', 's.com.tw', 'watch', now],
        ['tag', 'a.com.tw', 'watch', now],
        ['tag', 'b.com.tw', 'watch', now],
      ],
    ]);
    const { request, sent } = fakeFetch();
    expect(await run(pool, request, 2)).toMatchObject({ sent: 2, ok: 2, refused: false });
    expect(sent).toEqual(['a.com.tw', 'b.com.tw']);
    expect(await rows(pool, 'SELECT month, visits FROM traffic_months WHERE domain = ? ORDER BY month', ['a.com.tw'])).toEqual([
      { month: '202607', visits: 1_000_000 },
      { month: '202608', visits: 1_100_000 },
      { month: '202609', visits: 1_200_000 },
    ]);
    // Both answers had 202609, last month on 10/21; a day later they no longer count, and in November they lack 202610.
    expect(await lastMonthShare(pool, new Date('2026-10-21T12:00:00Z'))).toEqual({ month: '202609', sampled: 2, found: 2 });
    expect(await lastMonthShare(pool, new Date('2026-10-23T12:00:00Z'))).toMatchObject({ sampled: 0 });
    expect(await lastMonthShare(pool, new Date('2026-11-01T00:30:00Z'))).toMatchObject({ month: '202610', sampled: 0 });
    // Fetched domains are fresh now; only the sheet one is left.
    const second = fakeFetch();
    await run(pool, second.request, 5);
    expect(second.sent).toEqual(['s.com.tw']);
  });

  it('stops at a refusal and sends nothing during the cooldown', async () => {
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at) VALUES ?', [
      [
        ['tag', 'a.com.tw', 'watch', new Date()],
        ['tag', 'b.com.tw', 'watch', new Date()],
      ],
    ]);
    const refused = fakeFetch(403);
    expect(await run(pool, refused.request)).toMatchObject({ sent: 1, refused: true });
    expect(refused.sent).toHaveLength(1);
    const after = fakeFetch();
    expect(await run(pool, after.request)).toMatchObject({ skipped: expect.stringContaining('cooling down') });
    expect(after.sent).toEqual([]);
  });

  it('sends nothing with budget 0', async () => {
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at) VALUES (?, ?, ?, ?)', [
      'tag',
      'a.com.tw',
      'watch',
      new Date(),
    ]);
    const { request, sent } = fakeFetch();
    expect(await run(pool, request, 0)).toEqual({ skipped: 'budget is 0' });
    expect(sent).toEqual([]);
  });

  it('keeps the request contract tag served to blog at /internal/similarweb', async () => {
    const server = app();
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect(
      (await server.inject({ method: 'POST', url: '/internal/similarweb/requests', payload: { domain: 'x.com.tw' } })).statusCode,
    ).toBe(404);
    // Rejected before the body is parsed: no 415/400 that would reveal the route.
    expect((await server.inject({ method: 'PUT', url: '/internal/v1/watch', headers: { 'cf-connecting-ip': '1.2.3.4' } })).statusCode).toBe(
      404,
    );
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/internal/similarweb/requests',
          headers: { ...auth, 'cf-connecting-ip': '1.2.3.4' },
          payload: { domain: 'x.com.tw' },
        })
      ).statusCode,
    ).toBe(404);
    const first = await server.inject({
      method: 'POST',
      url: '/internal/similarweb/requests',
      headers: auth,
      payload: { domain: 'https://www.X.com.tw/a', kind: 'traffic' },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ domain: 'x.com.tw', kind: 'traffic', status: 'pending', created: true });
    const again = await server.inject({
      method: 'POST',
      url: '/internal/similarweb/requests',
      headers: auth,
      payload: { domain: 'x.com.tw', kind: 'traffic' },
    });
    expect(again.statusCode).toBe(200);
    expect(
      (
        await server.inject({ method: 'POST', url: '/internal/similarweb/requests', headers: auth, payload: { domain: 'localhost' } })
      ).json(),
    ).toEqual({
      error: 'invalid_domain',
    });
    expect((await server.inject({ url: '/internal/similarweb/results?domain=y.com.tw', headers: auth })).statusCode).toBe(404);

    await server.inject({
      method: 'POST',
      url: '/internal/similarweb/requests',
      headers: auth,
      payload: { domain: 'x.com.tw', kind: 'similar_sites' },
    });
    const { request } = fakeFetch();
    // Submitted "now" (real clock); the run's clock is later than that.
    await runOnce(pool, { config: runConfig({ TRAFFIC_RUN_BUDGET: '5' }), request, pauseMs: 0, now: () => new Date(Date.now() + 1000) });
    const result = (await server.inject({ url: '/internal/similarweb/results?domain=x.com.tw', headers: auth })).json();
    expect(result).toMatchObject({
      domain: 'x.com.tw',
      source: 'similarweb-extension',
      traffic: { category: 'News_and_Media', topCountries: [{ code: 'TW', share: 0.9 }] },
      similarSites: ['other.com.tw'],
    });
    expect(result.traffic.monthly).toHaveLength(3);
    expect(Object.fromEntries(result.requests.map((r: { kind: string; status: string }) => [r.kind, r.status]))).toEqual({
      traffic: 'ok',
      similar_sites: 'ok',
    });

    // A lookup for a domain fetched in the last 30 days is answered from what is stored, not sent again.
    const { request: watched } = fakeFetch();
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at) VALUES (?, ?, ?, ?)', [
      'tag',
      'w.com.tw',
      'watch',
      new Date(),
    ]);
    await runOnce(pool, { config: runConfig({ TRAFFIC_RUN_BUDGET: '5' }), request: watched, pauseMs: 0, now: () => new Date() });
    const asked = await server.inject({
      method: 'POST',
      url: '/internal/similarweb/requests',
      headers: auth,
      payload: { domain: 'w.com.tw', kind: 'similar_sites' },
    });
    expect(asked.json()).toMatchObject({ status: 'ok' });
    const resent = fakeFetch();
    await runOnce(pool, { config: runConfig({ TRAFFIC_RUN_BUDGET: '5' }), request: resent.request, pauseMs: 0, now: () => new Date() });
    expect(resent.sent).toEqual([]);
    await server.close();
  });

  it('lets a service replace its watch list and read back everything stored', async () => {
    const server = app();
    const auth = { authorization: `Bearer ${TAG}` };
    const put = await server.inject({
      method: 'PUT',
      url: '/internal/v1/watch',
      headers: auth,
      payload: { domains: ['a.com.tw', 'b.com.tw', 'bad'], refreshDays: 7 },
    });
    expect(put.json()).toEqual({ watched: 2, refused: ['bad'] });
    await server.inject({ method: 'PUT', url: '/internal/v1/watch', headers: auth, payload: { domains: ['a.com.tw'], refreshDays: 7 } });
    expect(await rows(pool, "SELECT domain FROM watches WHERE requester = 'tag'")).toEqual([{ domain: 'a.com.tw' }]);
    const { request } = fakeFetch();
    await run(pool, request);
    const traffic = (
      await server.inject({ method: 'POST', url: '/internal/v1/traffic', headers: auth, payload: { domains: ['a.com.tw', 'z.com.tw'] } })
    ).json();
    expect(traffic.domains).toHaveLength(1);
    expect(traffic.domains[0]).toMatchObject({ domain: 'a.com.tw', profiles: { '202609': { channels: { SearchOrganic: 0.3 } } } });
    expect(traffic.state['a.com.tw']).toMatchObject({ failures: 0, lastSuccessAt: '2026-10-21T10:00:00.000Z' });
    await server.close();
  });

  it('keeps both classification columns and every repeated row as distinct tags', async () => {
    const base = {
      domain: 'a.com.tw',
      name: 'A',
      url: null,
      visits: 12,
      adjusted: false,
      searchShare: null,
      aiShare: null,
      taiwanShare: null,
      raw: {},
    };
    await saveSheet(pool, [
      { ...base, month: '202608', rowNo: 2, group: '舊群組', topics: '舊分類' },
      { ...base, month: '202609', rowNo: 2, group: '品牌', topics: '電商, 科技' },
      { ...base, month: '202609', rowNo: 3, group: '內容', topics: '科技，生活內容' },
    ]);
    const view = await monthView(pool, '202609');
    expect(view).toHaveLength(1);
    expect(view[0].topics).toEqual(['品牌', '電商', '科技', '內容', '生活內容']);
    expect(ranking(view, '品牌')).toHaveLength(1);
    expect(topicSummary(view).find((t) => t.topic === '科技')).toMatchObject({ sites: 1, visits: 12 });
    expect((await monthView(pool, '202608'))[0].topics).toEqual(['舊群組', '舊分類']);
    const server = app();
    const history = (await server.inject('/api/v1/history')).json();
    expect(history.sites['a.com.tw'].topics).toEqual(view[0].topics);
    const page = (await server.inject('/site/a.com.tw/')).body;
    for (const tag of view[0].topics) expect(page).toContain(`topic=${encodeURIComponent(tag)}`);
    expect((await server.inject('/api/v1/rankings.csv?month=202609')).body).toContain('品牌, 電商, 科技, 內容, 生活內容');
    await server.close();
  });

  it('edits names and tags with authorization, conflict checks, atomic batches and reimport protection', async () => {
    const origin = 'https://traffic.example';
    const server = buildApp(pool, {
      login: { clientId: 'cid', clientSecret: 'secret', origin, admins: new Set(['editor@example.com']) },
      logger: false,
    });
    const cookie = 'traffic_session=test-editor';
    await pool.query(
      'INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 DAY))',
      [createHash('sha256').update('test-editor').digest('hex'), 'editor@example.com'],
    );
    const base = {
      month: '202609',
      group: '通路',
      topics: '電商',
      name: '原名',
      url: null,
      visits: 12,
      adjusted: false,
      searchShare: null,
      aiShare: null,
      taiwanShare: null,
      raw: {},
    };
    const sheet = [
      { ...base, domain: 'a.com.tw', rowNo: 2 },
      { ...base, domain: 'b.com.tw', rowNo: 3 },
    ];
    await saveSheet(pool, sheet);
    const form = (url: string, payload: Record<string, string>, headers = { cookie, origin }) =>
      server.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(payload).toString(),
      });
    expect((await server.inject('/site/a.com.tw/edit/')).statusCode).toBe(303);
    expect((await server.inject('/sites/')).statusCode).toBe(303);
    expect((await server.inject({ url: '/site/a.com.tw/edit/', headers: { cookie } })).body).toContain('name="topics"');
    const values = { name: '清楚的名稱', topics: '台灣, 新聞, 社群, 新聞', revision: '0' };
    expect((await form('/site/a.com.tw/edit/', values, { cookie: '', origin })).statusCode).toBe(303);
    expect((await form('/site/a.com.tw/edit/', values, { cookie, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(await rows(pool, 'SELECT * FROM site_metadata')).toHaveLength(0);
    // Warm both public caches, then verify they are invalidated by the write.
    await server.inject('/api/v1/history');
    await server.inject('/api/v1/rankings?month=202609');
    await server.inject('/api/v1/topics/all');
    expect((await form('/site/a.com.tw/edit/', values)).statusCode).toBe(303);
    const history = (await server.inject('/api/v1/history')).json();
    expect(history.sites['a.com.tw']).toMatchObject({ name: '清楚的名稱', topics: ['台灣', '新聞', '社群'] });
    const ranking = (await server.inject('/api/v1/rankings?month=202609')).json();
    expect(ranking.sites.find((s: { domain: string }) => s.domain === 'a.com.tw')).toMatchObject({ rank: 1, name: '清楚的名稱' });
    expect(ranking.sites.find((s: { domain: string }) => s.domain === 'b.com.tw')).toMatchObject({ rank: 2 });
    // Leaving a tag out removes its sites and ranks the rest among themselves.
    const without = (await server.inject(`/api/v1/rankings?month=202609&exclude=${encodeURIComponent('新聞')}`)).json();
    expect(without.exclude).toEqual(['新聞']);
    expect(without.sites.map((s: { domain: string; rank: number }) => [s.domain, s.rank])).toEqual([['b.com.tw', 1]]);
    expect((await server.inject(`/table/?month=202609&exclude=${encodeURIComponent('新聞')}`)).body).toContain('排除 新聞');
    expect((await server.inject('/site/a.com.tw/')).body).toContain('清楚的名稱');
    expect((await server.inject('/api/v1/sites/a.com.tw')).json()).toMatchObject({ name: '清楚的名稱', topics: ['台灣', '新聞', '社群'] });
    expect((await server.inject('/api/v1/topics/all?topic=新聞')).json().sites.map((s: { domain: string }) => s.domain)).toEqual([
      'a.com.tw',
    ]);
    expect((await form('/site/a.com.tw/edit/', values)).statusCode).toBe(409);
    await saveSheet(
      pool,
      sheet.map((s) => ({ ...s, name: '重新匯入', topics: '科技' })),
    );
    expect((await monthView(pool, '202609')).find((s) => s.domain === 'a.com.tw')).toMatchObject({
      name: '清楚的名稱',
      topics: ['台灣', '新聞', '社群'],
    });
    // Invalid add/remove overlap rejects the entire batch. Geographic tags have no special constraints.
    expect((await form('/sites/', { domains: 'b.com.tw\na.com.tw', add: '科技', remove: '科技' })).statusCode).toBe(400);
    expect((await monthView(pool, '202609')).find((s) => s.domain === 'b.com.tw')?.topics).toEqual(['通路', '科技']);
    expect((await form('/sites/', { domains: 'a.com.tw\nb.com.tw', add: '非台灣, 部落格', remove: '' })).statusCode).toBe(303);
    expect((await server.inject('/api/v1/topics/all?topic=部落格')).json().sites).toHaveLength(2);
    expect((await monthView(pool, '202609')).find((s) => s.domain === 'a.com.tw')).toMatchObject({
      name: '清楚的名稱',
      topics: ['台灣', '新聞', '社群', '非台灣', '部落格'],
    });
    expect((await server.inject('/api/v1/rankings?month=202609')).json().sites).toHaveLength(2);
    expect((await server.inject('/api/v1/rankings?month=202609&topic=%E9%9D%9E%E5%8F%B0%E7%81%A3')).json().sites).toHaveLength(2);
    // Several tags in topic are ANDed: only a.com.tw carries 新聞 as well as 部落格.
    const both = (await server.inject(`/api/v1/rankings?month=202609&topic=${encodeURIComponent('新聞,部落格')}`)).json();
    expect(both.sites.map((s: { domain: string; rank: number }) => [s.domain, s.rank])).toEqual([['a.com.tw', 1]]);
    expect((await form('/sites/', { domains: 'missing.tw', add: '新聞', remove: '' })).statusCode).toBe(400);
    expect(await rows(pool, 'SELECT * FROM site_metadata_log')).toHaveLength(3);
    // Independent batches must merge against the latest committed tags.
    await Promise.all([
      editSites(pool, 'editor@example.com', { domains: ['a.com.tw'], add: '標籤一', remove: '' }),
      editSites(pool, 'editor@example.com', { domains: ['a.com.tw'], add: '標籤二', remove: '' }),
    ]);
    expect((await monthView(pool, '202609')).find((s) => s.domain === 'a.com.tw')?.topics).toEqual(
      expect.arrayContaining(['標籤一', '標籤二']),
    );
    // Both sites now carry 非台灣: the pages leave them out until told otherwise; the API leaves nothing out unless asked.
    const fresh = app();
    expect((await fresh.inject('/table/?month=202609')).body).toContain('排除 非台灣');
    expect((await fresh.inject('/table/?month=202609&exclude=')).body).not.toContain('排除 非台灣');
    expect((await fresh.inject('/api/v1/rankings?month=202609')).json().exclude).toEqual([]);
    await fresh.close();
    await server.close();
  });

  it('aggregates topics across months with complete current membership and no duplicate traffic', async () => {
    const base = {
      month: '202608',
      rowNo: 2,
      domain: 'a.com.tw',
      name: 'A',
      group: null,
      topics: '舊標籤',
      url: null,
      visits: 10,
      adjusted: false,
      searchShare: 0.5,
      aiShare: 0.01,
      taiwanShare: null,
      raw: {},
    };
    await saveSheet(pool, [
      base,
      { ...base, rowNo: 3 },
      { ...base, rowNo: 4, domain: 'b.com.tw', name: 'B', topics: '科技', visits: 20, searchShare: 0.2, aiShare: null },
      { ...base, month: '202609', topics: '科技', visits: 999, searchShare: null, aiShare: 0.03 },
      { ...base, month: '202610', name: '最新名稱', topics: '科技', visits: null },
      { ...base, month: '202610', rowNo: 3, domain: 'waiting.tw', name: '還沒有流量', topics: '新標籤', visits: null },
      { ...base, month: '202611', domain: 'adjusted.tw', name: '調整數字', topics: '新標籤', visits: 500, adjusted: true },
    ]);
    await pool.query('INSERT INTO traffic_months (domain, month, visits, first_seen_at, fetched_at) VALUES (?, ?, ?, NOW(), NOW())', [
      'a.com.tw',
      '202609',
      30_000_000,
    ]);
    const server = app();
    const all = (await server.inject('/api/v1/topics/all')).json();
    expect(all).toMatchObject({ scope: 'all', months: ['202608', '202609'] });
    expect(all.topics.find((t: { topic: string }) => t.topic === '科技')).toMatchObject({
      sites: 2,
      sitesWithData: 2,
      visits: 60,
      searchShare: 0.3,
    });
    expect(all.topics.find((t: { topic: string }) => t.topic === '科技').aiShare).toBeCloseTo(0.025, 12);
    expect(all.topics.find((t: { topic: string }) => t.topic === '新標籤')).toMatchObject({ sites: 2, sitesWithData: 0, visits: null });
    expect(all.topics.map((t: { topic: string }) => t.topic)).not.toContain('舊標籤');
    expect((await server.inject('/api/v1/topics/all?month=202608')).json()).toEqual(all);
    const members = (await server.inject('/api/v1/topics/all?topic=科技')).json().sites;
    expect(members.map((s: { domain: string }) => s.domain)).toEqual(['a.com.tw', 'b.com.tw']);
    expect(members[0]).toMatchObject({ name: '最新名稱', visits: 40, months: 2 });
    for (const path of ['/tag/', '/tag/?month=202608']) {
      const page = (await server.inject(path)).body;
      expect(page).toContain('60<span class="unit">m</span>');
      expect(page).toContain(`/tag/?topic=${encodeURIComponent('新標籤')}`);
      expect(page).not.toMatch(/name="month"|流量成長|AI 成長|搜尋成長/);
    }
    const memberPage = (await server.inject('/tag/?topic=新標籤')).body;
    expect(memberPage).toContain('/site/waiting.tw/');
    expect(memberPage).toContain('/site/adjusted.tw/');
    expect((await server.inject('/api/v1/topics/all?topic=不存在')).statusCode).toBe(404);
    // The documented monthly API remains available to existing consumers.
    const monthly = (await server.inject('/api/v1/topics?month=202608')).json();
    expect(monthly.month).toBe('202608');
    expect(monthly.topics.find((t: { topic: string }) => t.topic === '舊標籤')).toMatchObject({ sites: 1, visits: 10 });
    await editSites(pool, 'editor@example.com', { single: { domain: 'a.com.tw', name: '最新名稱', topics: '', revision: 0 } });
    expect((await server.inject('/api/v1/topics/all?topic=科技')).json().sites.map((s: { domain: string }) => s.domain)).toEqual([
      'b.com.tw',
    ]);
    await server.close();
  });

  it('treats a Similarweb 0 as no estimate: the sheet fills in, otherwise the month is missing', async () => {
    const row = { rowNo: 2, group: null, topics: '新聞', url: null, adjusted: false, aiShare: null, taiwanShare: null, raw: {} };
    await saveSheet(pool, [{ ...row, month: '202609', domain: 'news.example.tw', name: '新聞站', visits: 60.1, searchShare: 0.3 }]);
    const month = async (domain: string, m: string, visits: number) =>
      pool.query('INSERT INTO traffic_months (domain, month, visits, first_seen_at, fetched_at) VALUES (?, ?, ?, NOW(), NOW())', [
        domain,
        m,
        visits,
      ]);
    await month('news.example.tw', '202609', 0);
    await month('blog.example.tw', '202608', 437);
    await month('blog.example.tw', '202609', 0);
    const view = await monthView(pool, '202609');
    expect(view.find((s) => s.domain === 'news.example.tw')).toMatchObject({ visits: 60.1, visitsSource: 'sheet', searchShare: 0.3 });
    expect(view.find((s) => s.domain === 'blog.example.tw')).toBeUndefined();
    const server = app();
    const page = (await server.inject('/site/news.example.tw/')).body;
    expect(page).toContain('無估算');
    expect(page).toContain('60<span class="unit">m</span>');
    await server.close();
  });

  it('lets editors enter a month from the Similarweb platform where the free data has no estimate', async () => {
    const origin = 'https://traffic.example';
    const server = buildApp(pool, {
      login: { clientId: 'cid', clientSecret: 'secret', origin, admins: new Set(['editor@example.com']) },
      logger: false,
    });
    const cookie = 'traffic_session=test-editor';
    await pool.query(
      'INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 DAY))',
      [createHash('sha256').update('test-editor').digest('hex'), 'editor@example.com'],
    );
    const [month] = recentMonths();
    const row = { rowNo: 2, group: null, topics: '新聞', url: null, adjusted: false, aiShare: 0.01, taiwanShare: null, raw: {} };
    await saveSheet(pool, [{ ...row, month, domain: 'news.example.tw', name: '新聞站', visits: 50, searchShare: 0.2 }]);
    await pool.query('INSERT INTO traffic_months (domain, month, visits, first_seen_at, fetched_at) VALUES (?, ?, 0, NOW(), NOW())', [
      'news.example.tw',
      month,
    ]);
    const post = (payload: Record<string, string>, headers: Record<string, string> = { cookie, origin }) =>
      server.inject({
        method: 'POST',
        url: '/site/news.example.tw/manual/',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(payload).toString(),
      });
    const entry = {
      month,
      visits: '60.10M',
      search: '36.45',
      ai: '0.37%',
      taiwan: '',
      Direct: '40%',
      Referrals: '12.5',
      SocialOrganic: '0',
      bounce: '42.5',
      pages: '3.25',
      duration: '00:02:05',
      globalRank: '1,234',
      countryCode: 'US',
      countryRank: '23',
      category: 'News_and_Media',
      categoryRank: '45',
      countries: 'US 12.34',
      socialTotal: '3.8',
      social: 'Facebook | 76.23%\nYouTube | 14.05%',
      referringSites: 'yahoo.com | 92.41% | -13.99%\n? | 0.64% | -8.07%',
      referringIndustries: 'Social Networks and Online Communities | 82.28%',
      outgoingLinks: 'ftnn.com.tw | 6.72% | >5,000%',
      outgoingAdvertisers: 'worldlifestyle.com | 15.17% | +210.72%',
      displayTotal: '<1%',
      displayPublishers: 'zh.wikipedia.org | <0.01% | New',
    };
    // The status page lists the domain until it is filled in, and links to the form.
    expect((await server.inject('/status/')).body).toContain('/site/news.example.tw/manual/');
    expect((await server.inject('/site/news.example.tw/manual/')).statusCode).toBe(303);
    // The page says what the free data last answered and links to the platform.
    const blank = (await server.inject({ url: '/site/news.example.tw/manual/', headers: { cookie } })).body;
    expect(blank).toContain('無估算');
    expect(blank).toContain('pro.similarweb.com');
    expect((await post(entry, { cookie: '', origin })).statusCode).toBe(303);
    expect((await post(entry, { cookie, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post({ ...entry, visits: '60.1' })).body).toContain('單位');
    expect((await post({ ...entry, Direct: '101' })).statusCode).toBe(400);
    expect((await post({ ...entry, month: '201901' })).statusCode).toBe(400);
    expect(await rows(pool, 'SELECT * FROM manual_months')).toHaveLength(0);
    const saved = await post(entry);
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe('/site/news.example.tw/manual/?done=saved');
    // Entered numbers come before the sheet; shares left blank stay empty rather than falling back.
    expect((await monthView(pool, month)).find((s) => s.domain === 'news.example.tw')).toMatchObject({
      visits: 60.1,
      visitsSource: 'manual',
      searchShare: expect.closeTo(0.3645, 10),
      channels: { Direct: 0.4, Referrals: 0.125, SocialOrganic: 0, SearchOrganic: expect.closeTo(0.3645, 10), GenAi: 0.0037 },
      taiwanShare: null,
    });
    expect((await server.inject('/api/v1/history')).json().sites['news.example.tw'].m[month][4]).toBe(2);
    expect((await server.inject('/site/news.example.tw/')).body).toContain('人工補登');
    // Missing channels remain unknown, and saved fields survive the reload/month switch.
    const view = (await monthView(pool, month)).find((s) => s.domain === 'news.example.tw');
    expect(view?.channels?.Mail).toBeUndefined();
    const formPage = (await server.inject({ url: '/site/news.example.tw/manual/', headers: { cookie } })).body;
    expect(formPage).toContain('name="Direct" value="40"');
    expect(formPage).toContain('data-referrals="12.5"');
    expect(formPage).toContain('name="duration" value="125"');
    expect(formPage).toContain('data-categoryrank="45"');
    const detail = (await server.inject({ url: '/api/v1/sites/news.example.tw', headers: { cookie } })).json();
    expect(detail.profile).toMatchObject({
      source: 'manual',
      bounceRate: 0.425,
      pagesPerVisit: 3.25,
      timeOnSite: 125,
      globalRank: 1234,
      countryRank: { code: 'US', rank: 23 },
      categoryRank: { category: 'News_and_Media', rank: 45 },
      countries: [{ code: 'US', share: 0.1234 }],
      channels: { Direct: 0.4 },
    });
    const detailPage = (await server.inject({ url: '/site/news.example.tw/', headers: { cookie } })).body;
    expect(detailPage).toContain('平台補登');
    expect(detailPage).toContain('#1,234');
    expect(detail.manualProfiles[0].breakdowns).toMatchObject({
      socialTotal: { value: 0.038, bound: null },
      displayTotal: { value: 0.01, bound: 'lt' },
      social: [
        { name: 'Facebook', share: { value: expect.closeTo(0.7623, 10), bound: null } },
        { name: 'YouTube', share: { value: 0.1405, bound: null } },
      ],
      outgoingLinks: [{ name: 'ftnn.com.tw', change: '>5000%' }],
      displayPublishers: [{ name: 'zh.wikipedia.org', share: { value: 0.0001, bound: 'lt' }, change: 'New' }],
    });
    const guestDetail = (await server.inject('/api/v1/sites/news.example.tw')).json();
    expect(guestDetail.manualProfiles).toBeUndefined();
    expect(guestDetail.profile.breakdowns).toBeUndefined();
    // A later free estimate still wins for visits but cannot hide platform-only details.
    await pool.query('UPDATE traffic_months SET visits = 1000000 WHERE domain = ?', ['news.example.tw']);
    const withFree = (await server.inject({ url: '/api/v1/sites/news.example.tw', headers: { cookie } })).json();
    expect(withFree.manualProfiles[0].breakdowns.displayPublishers[0].change).toBe('New');
    expect((await monthView(pool, month)).find((s) => s.domain === 'news.example.tw')?.visitsSource).toBe('similarweb');
    await pool.query('UPDATE traffic_months SET visits = 0 WHERE domain = ?', ['news.example.tw']);
    expect(formPage).toContain('name="SocialOrganic" value="0"');
    // The saved month comes back filled in, ready to correct.
    expect((await server.inject({ url: '/site/news.example.tw/manual/', headers: { cookie } })).body).toContain('value="60.10m"');
    expect((await post({ month, action: 'delete' })).statusCode).toBe(303);
    expect((await monthView(pool, month)).find((s) => s.domain === 'news.example.tw')).toMatchObject({ visits: 50, visitsSource: 'sheet' });
    const log = await rows<{ email: string; before_value: unknown; after_value: unknown }>(
      pool,
      'SELECT email, before_value, after_value FROM manual_months_log ORDER BY id',
    );
    expect(log.map((l) => [l.email, !!l.before_value, !!l.after_value])).toEqual([
      ['editor@example.com', false, true],
      ['editor@example.com', true, false],
    ]);
    await server.close();
  });

  it('caps anonymous and signed-in non-admin results after every filter across rankings, history, topics and CSV', async () => {
    await saveSheet(
      pool,
      Array.from({ length: 65 }, (_, i) => ({
        rowNo: i + 2,
        month: '202609',
        group: null,
        topics: i < 35 ? '新聞' : '科技',
        url: null,
        adjusted: false,
        aiShare: 0.0012345,
        taiwanShare: 0.87654,
        raw: {},
        domain: `site${i}.tw`,
        name: `Site ${i}`,
        visits: i + 0.123456,
        searchShare: 0.34567,
      })),
    );
    const server = buildApp(pool, {
      logger: false,
      login: {
        clientId: 'cid',
        clientSecret: 'secret',
        origin: 'https://traffic.example',
        admins: new Set(['sky9109@gmail.com', 'genehong@gmail.com']),
      },
    });
    for (const name of ['member', 'sky9109', 'genehong']) {
      await pool.query(
        'INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 DAY))',
        [createHash('sha256').update(name).digest('hex'), `${name}@gmail.com`],
      );
    }
    try {
      for (const cookie of ['', 'traffic_session=member']) {
        for (const query of ['', '?topic=新聞', '?topic=科技', '?exclude=科技', '?month=202609', '?q=Site']) {
          const rankings = (await server.inject({ url: `/api/v1/rankings${query}`, headers: { cookie } })).json();
          expect(rankings.sites).toHaveLength(30);
          const history = (await server.inject({ url: `/api/v1/history${query}`, headers: { cookie } })).json();
          expect(Object.keys(history.sites)).toHaveLength(30);
          expect(new Set(Object.keys(history.sites))).toEqual(new Set(rankings.sites.map((site: { domain: string }) => site.domain)));
          const csv = (await server.inject({ url: `/api/v1/rankings.csv${query}`, headers: { cookie } })).body.trim().split('\n');
          expect(csv).toHaveLength(31);
        }
      }
      for (const name of ['sky9109', 'genehong']) {
        const headers = { cookie: `traffic_session=${name}` };
        expect((await server.inject({ url: '/api/v1/rankings', headers })).json().sites).toHaveLength(65);
        expect(Object.keys((await server.inject({ url: '/api/v1/history', headers })).json().sites)).toHaveLength(65);
        expect((await server.inject({ url: '/api/v1/rankings.csv', headers })).body.trim().split('\n')).toHaveLength(66);
      }
      expect((await server.inject('/api/v1/rankings?q=Site%2064')).json().sites).toHaveLength(1);
      expect((await server.inject('/api/v1/topics/all?topic=新聞')).json().sites).toHaveLength(30);
      expect(
        (await server.inject('/api/v1/rankings?topic=科技'))
          .json()
          .sites.every((site: { topics: string[] }) => site.topics.includes('科技')),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('serves pages and the public API', async () => {
    const server = app();
    const { request } = fakeFetch();
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at) VALUES (?, ?, ?, ?)', [
      'tag',
      'a.com.tw',
      'watch',
      new Date(),
    ]);
    await run(pool, request);
    // An earlier month's channels: the table compares every share with the comparison month.
    await pool.query(
      "INSERT INTO traffic_profiles (domain, month, profile, first_seen_at, fetched_at) VALUES ('a.com.tw', '202608', ?, NOW(), NOW())",
      [
        JSON.stringify({
          month: '202608',
          countries: [],
          channels: { SearchOrganic: 0.2, Mail: 0.05, GenAi: 0.01 },
          bounceRate: null,
          pagesPerVisit: null,
          timeOnSite: null,
          globalRank: null,
          countryRank: null,
          categoryRank: null,
        }),
      ],
    );
    const ranking = (await server.inject('/api/v1/rankings?month=202609')).json();
    expect(ranking.sites[0]).toMatchObject({ domain: 'a.com.tw', visits: 1.2, rank: 1, searchVisits: 1.2 * 0.3 });
    for (const path of ['/', '/table/', '/table/?source=tag', '/tag/', '/site/a.com.tw/', '/status/'])
      expect((await server.inject(path)).statusCode).toBe(200);
    // The report page is static and reads everything from /api/v1/history.
    expect((await server.inject('/')).body).toContain('/api/v1/history');
    const history = (await server.inject('/api/v1/history')).json();
    expect(history.months).toEqual(['202607', '202608', '202609']);
    expect(history.sources).toEqual([{ source: 'tag', domains: 1 }]);
    expect(history.sites['a.com.tw']).toMatchObject({
      src: ['tag'],
      m: { '202609': [1.2, 1.2 * 0.3, 1.2 * 0.01, 0.9, 0, 0.9, 0, null, 0] },
    });
    expect(history.radar).toEqual({});
    expect((await server.inject('/api/v1/rankings.csv?month=202609')).body).toContain('a.com.tw');

    const compared = (await server.inject('/api/v1/rankings?month=202609')).json();
    expect(compared.from).toBe('202608');
    expect(compared.sites[0]).toMatchObject({ channels: { SearchOrganic: 0.3 }, prevChannels: { SearchOrganic: 0.2 } });
    const shares = (await server.inject('/table/?month=202609')).body;
    expect(shares).not.toContain('>郵件 %</th>');
    expect(shares).toContain('aria-label="數值"');
    expect(shares.indexOf('</table>')).toBeLessThan(shares.indexOf('table-note'));
    expect(shares).toContain('30%');
    const changes = (await server.inject('/table/?month=202609&from=202608&show=change')).body;
    expect(changes).not.toContain('郵件 % ±');
    expect(changes).toContain('>▲10</span>');
    expect(changes).not.toContain('>▼5.0</span>');
    // 次數: visits × share (search 1.2m × 30%), and its change from 202608 (1.1m × 20%).
    expect((await server.inject('/table/?month=202609&unit=count')).body).toContain('360<span class="unit">k</span>');
    expect((await server.inject('/table/?month=202609&unit=count&show=change')).body).toContain('▲140<span class="unit">k</span>');
    const csv = (await server.inject('/api/v1/rankings.csv?month=202609')).body.split('\n');
    expect(csv[0]).not.toContain('電子郵件占比差距');
    expect(csv[1]).toContain('202608');
    await server.close();
  });

  it('lets editors sign in with Google and add or remove domains by hand', async () => {
    const origin = 'https://traffic.example';
    const login = { clientId: 'cid', clientSecret: 'secret', origin, admins: new Set(['sky9109@gmail.com']) };
    let email = 'sky9109@gmail.com';
    let nonce = '';
    const server = buildApp(pool, {
      tokens: new Map([['tag', Buffer.from(TAG)]]),
      login,
      logger: false,
      exchange: async () => ({
        iss: 'https://accounts.google.com',
        aud: 'cid',
        exp: Date.now() / 1000 + 60,
        nonce,
        email,
        email_verified: true,
      }),
    });
    const signIn = async () => {
      const start = await server.inject('/auth/google?next=/watch/');
      const flowCookie = String(start.headers['set-cookie']).split(';')[0];
      const auth = new URL(start.headers.location as string);
      nonce = auth.searchParams.get('nonce') as string;
      expect(auth.searchParams.get('redirect_uri')).toBe(`${origin}/auth/google/callback`);
      const back = await server.inject({
        url: `/auth/google/callback?state=${auth.searchParams.get('state')}&code=c`,
        headers: { cookie: flowCookie },
      });
      const session = ([] as string[])
        .concat(back.headers['set-cookie'] as string[])
        .find((c) => c.startsWith('traffic_session=') && !c.startsWith('traffic_session=;'));
      return { location: back.headers.location, cookie: session?.split(';')[0] };
    };
    const form = (cookie: string | undefined, url: string, body: Record<string, string>, from = origin) =>
      server.inject({
        method: 'POST',
        url,
        headers: { cookie: cookie ?? '', origin: from, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(body).toString(),
      });

    // Not on the list: signed in (to vote on tags), but the editors' pages refuse.
    email = 'someone@gmail.com';
    const reader = await signIn();
    expect(reader.location).toBe('/watch/');
    expect((await form(reader.cookie, '/watch/', { domains: 'x.com.tw' })).statusCode).toBe(403);
    expect((await server.inject({ url: '/sites/', headers: { cookie: reader.cookie } })).statusCode).toBe(403);
    email = 'sky9109@gmail.com';
    const { location, cookie } = await signIn();
    expect(location).toBe('/watch/');
    expect((await server.inject({ url: '/watch/', headers: { cookie } })).body).toContain('加入追蹤');
    expect((await server.inject('/watch/')).body).not.toContain('加入追蹤');

    // Signed out, or posted from another site: nothing changes.
    expect((await form(undefined, '/watch/', { domains: 'x.com.tw' })).headers.location).toBe('/auth/google?next=/watch/');
    expect((await form(cookie, '/watch/', { domains: 'x.com.tw' }, 'https://evil.example')).statusCode).toBe(403);
    expect(await rows(pool, 'SELECT domain FROM watches')).toEqual([]);

    const added = await form(cookie, '/watch/', {
      domains: 'https://www.x.com.tw/news/1\ny.com.tw, not a domain',
      note: '吉進要的',
    });
    expect(added.headers.location).toBe('/watch/?added=2&refused=3');
    expect(await rows(pool, "SELECT domain, added_by, note FROM watches WHERE requester = 'manual' ORDER BY domain")).toEqual([
      { domain: 'x.com.tw', added_by: 'sky9109@gmail.com', note: '吉進要的' },
      { domain: 'y.com.tw', added_by: 'sky9109@gmail.com', note: '吉進要的' },
    ]);
    // Hand-added domains come after tag's.
    await pool.query("INSERT INTO watches (requester, domain, kind, requested_at) VALUES ('tag', 'a.com.tw', 'watch', NOW())");
    const { request, sent } = fakeFetch();
    await run(pool, request, 3);
    expect(sent[0]).toBe('a.com.tw');
    expect(sent.slice(1).sort()).toEqual(['x.com.tw', 'y.com.tw']);
    expect((await server.inject({ url: '/watch/', headers: { cookie } })).body).toContain('1.200<span class="unit">m</span>');

    expect((await form(cookie, '/watch/remove', { domain: 'x.com.tw' })).headers.location).toBe('/watch/?removed=x.com.tw');
    expect(await rows(pool, "SELECT domain FROM watches WHERE requester = 'manual'")).toEqual([{ domain: 'y.com.tw' }]);
    expect((await rows<{ action: string }>(pool, 'SELECT action FROM watch_log ORDER BY id')).map((r) => r.action)).toEqual([
      'add:manual',
      'add:manual',
      'del:manual',
    ]);

    // The add buttons on the discover and similar-sites pages: a background request gets JSON and no redirect; the same
    // form without JavaScript comes back to its own page, and only to a path on this site.
    const post = (body: Record<string, string>, headers: Record<string, string> = {}) =>
      server.inject({
        method: 'POST',
        url: '/watch/',
        headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
        payload: new URLSearchParams(body).toString(),
      });
    const background = await post({ domains: 'w.com.tw', back: '/discover/?min=2' }, { accept: 'application/json' });
    expect(background.statusCode).toBe(200);
    expect(background.json()).toEqual({ added: 1 });
    expect((await post({ domains: 'not a domain' }, { accept: 'application/json' })).statusCode).toBe(400);
    expect((await post({ domains: 'v.com.tw', back: '/site/a.com.tw/similar/' })).headers.location).toBe('/site/a.com.tw/similar/?added=1');
    expect((await post({ domains: 'u.com.tw', back: '/discover/?min=2' })).headers.location).toBe('/discover/?min=2&added=1');
    expect((await post({ domains: 't.com.tw', back: '//evil.example/x' })).headers.location).toBe('/watch/?added=1&refused=0');
    expect((await server.inject({ url: '/discover/?min=2&added=1', headers: { cookie } })).body).toContain('已加入 1 個網域');
    for (const d of ['w.com.tw', 'v.com.tw', 'u.com.tw', 't.com.tw']) await form(cookie, '/watch/remove', { domain: d });

    // Removed from TRAFFIC_ADMIN_EMAILS: editing stops at once.
    login.admins.delete('sky9109@gmail.com');
    expect((await form(cookie, '/watch/', { domains: 'z.com.tw' })).statusCode).toBe(403);

    // Services can add and remove single domains too.
    const tag = { authorization: `Bearer ${TAG}` };
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/internal/v1/watch/add',
          headers: tag,
          payload: { domains: ['b.com.tw'], refreshDays: 7 },
        })
      ).json(),
    ).toEqual({ added: ['b.com.tw'], refused: [] });
    expect(await rows(pool, "SELECT domain FROM watches WHERE requester = 'tag' ORDER BY domain")).toEqual([
      { domain: 'a.com.tw' },
      { domain: 'b.com.tw' },
    ]);
    expect(
      (await server.inject({ method: 'POST', url: '/internal/v1/watch/remove', headers: tag, payload: { domain: 'b.com.tw' } })).json(),
    ).toEqual({
      removed: true,
      domain: 'b.com.tw',
    });
    await server.close();
  });

  it('resolves tags from editors, AI, readers and admins, from the site page and from services', async () => {
    const now = new Date();
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at) VALUES ?', [
      [
        ['blog', 'food.blog', 'watch', now],
        ['tag', 'news.com.tw', 'watch', now],
      ],
    ]);
    await editSites(pool, 'ed@x.tw', { single: { domain: 'news.com.tw', name: '新聞台', topics: '新聞, 台灣', revision: 0 } });
    const origin = 'https://traffic.example';
    let nonce = '';
    const email = 'reader@gmail.com';
    const server = buildApp(pool, {
      tokens: new Map([['blog', Buffer.from(TOKEN)]]),
      login: { clientId: 'cid', clientSecret: 'secret', origin, admins: new Set(['admin@gmail.com']) },
      logger: false,
      exchange: async () => ({ iss: 'accounts.google.com', aud: 'cid', exp: Date.now() / 1000 + 60, nonce, email, email_verified: true }),
    });
    const blog = { authorization: `Bearer ${TOKEN}` };
    const call = (url: string, payload: object, method: 'POST' | 'PUT' = 'POST') => server.inject({ method, url, headers: blog, payload });
    const tagsOf = async (domain: string) => (await server.inject(`/api/v1/tags/${domain}`)).json().tags as Array<Record<string, unknown>>;
    const shown = async (domain: string) => (await managedSites(pool)).find((s) => s.domain === domain)?.topics;

    // A service's AI suggestions; unknown domains are skipped.
    const ai = await call(
      '/internal/v1/tags/ai',
      {
        sites: [
          { domain: 'https://www.food.blog/', tags: ['美食', '旅遊'], reason: 'r' },
          { domain: 'nope.blog', tags: ['x'] },
        ],
      },
      'PUT',
    );
    expect(ai.json()).toEqual({ ok: true, sites: 1, changed: 2, skipped: ['nope.blog'] });
    expect(await shown('food.blog')).toEqual(['美食', '旅遊']);

    // A reader adds a tag (shown at once), another disagrees (hidden again).
    const added = await call('/internal/v1/tags/propose', { voter: 'A@Gmail.com', domain: 'food.blog', tag: ' #咖啡 ' });
    expect(added.json()).toMatchObject({ ok: true, tag: '咖啡' });
    expect((await tagsOf('food.blog')).find((t) => t.tag === '咖啡')).toEqual({
      tag: '咖啡',
      source: 'community',
      visible: true,
      agrees: 1,
      disagrees: 0,
      adminOverride: null,
    });
    await call('/internal/v1/tags/vote', { voter: 'b@gmail.com', domain: 'food.blog', tag: '咖啡', vote: -1 });
    expect(await shown('food.blog')).toEqual(['美食', '旅遊']);
    // An AI tag needs two more disagreements than agreements to hide.
    await call('/internal/v1/tags/vote', { voter: 'a@gmail.com', domain: 'food.blog', tag: '旅遊', vote: -1 });
    expect(await shown('food.blog')).toContain('旅遊');
    await call('/internal/v1/tags/vote', { voter: 'b@gmail.com', domain: 'food.blog', tag: '旅遊', vote: -1 });
    expect(await shown('food.blog')).toEqual(['美食']);
    expect((await call('/internal/v1/tags/vote', { voter: 'a@gmail.com', domain: 'food.blog', tag: '登山', vote: 1 })).statusCode).toBe(
      404,
    );
    expect((await call('/internal/v1/tags/vote', { voter: 'not-an-email', domain: 'food.blog', tag: '美食', vote: 1 })).statusCode).toBe(
      400,
    );
    expect((await call('/internal/v1/tags/propose', { voter: 'a@gmail.com', domain: 'nope.blog', tag: 'x' })).statusCode).toBe(404);
    expect((await call('/internal/v1/tags/propose', { voter: 'a@gmail.com', domain: 'food.blog', tag: 'a,b' })).json().error).toBe(
      'invalid_tag',
    );

    // Only admins override; set wins over the votes, release hands the tag back.
    expect(
      (await call('/internal/v1/tags/admin', { voter: 'a@gmail.com', domain: 'food.blog', tag: '咖啡', action: 'set' })).statusCode,
    ).toBe(403);
    await call('/internal/v1/tags/admin', { voter: 'admin@gmail.com', domain: 'food.blog', tag: '咖啡', action: 'set' });
    expect(await shown('food.blog')).toEqual(['咖啡', '美食']);
    // An admin does not vote: disagree hides at once, agree sets, withdrawing releases.
    await call('/internal/v1/tags/vote', { voter: 'admin@gmail.com', domain: 'food.blog', tag: '美食', vote: -1 });
    expect(await shown('food.blog')).toEqual(['咖啡']);
    expect(await rows(pool, "SELECT COUNT(*) AS n FROM tag_votes WHERE voter = 'admin@gmail.com'")).toEqual([{ n: 0 }]);
    expect((await call('/internal/v1/tags', { domains: ['food.blog'], voter: 'admin@gmail.com' })).json().voter).toEqual({
      email: 'admin@gmail.com',
      admin: true,
      votes: { 'food.blog': { 咖啡: 1, 美食: -1 } },
    });
    await call('/internal/v1/tags/vote', { voter: 'admin@gmail.com', domain: 'food.blog', tag: '美食', vote: 0 });
    expect(await shown('food.blog')).toEqual(['咖啡', '美食']);
    // The editors' list ignores votes; an admin can still hide one of its tags.
    for (const voter of ['a@gmail.com', 'b@gmail.com', 'c@gmail.com'])
      await call('/internal/v1/tags/vote', { voter, domain: 'news.com.tw', tag: '新聞', vote: -1 });
    await call('/internal/v1/tags/admin', { voter: 'admin@gmail.com', domain: 'news.com.tw', tag: '台灣', action: 'hide' });
    expect(await shown('news.com.tw')).toEqual(['新聞']);
    await call('/internal/v1/tags/admin', { voter: 'admin@gmail.com', domain: 'news.com.tw', tag: '台灣', action: 'release' });
    expect(await shown('news.com.tw')).toEqual(['新聞', '台灣']);
    // Batch edits change the editors' list, not the readers' tags.
    await editSites(pool, 'ed@x.tw', { domains: ['food.blog'], add: '生活', remove: '' });
    expect((await managedSites(pool)).find((s) => s.domain === 'food.blog')).toMatchObject({
      baseTopics: ['生活'],
      topics: ['生活', '咖啡', '美食'],
    });

    // A service reads every tag and its reader's votes, never other readers' emails.
    const read = await call('/internal/v1/tags', { domains: ['food.blog', 'nope.blog'], voter: 'a@gmail.com' });
    expect(Object.keys(read.json().domains)).toEqual(['food.blog']);
    expect(read.json().voter).toEqual({ email: 'a@gmail.com', admin: false, votes: { 'food.blog': { 咖啡: 1, 旅遊: -1 } } });
    expect((await server.inject('/api/v1/tags/food.blog')).body).not.toContain('@');
    expect((await server.inject('/api/v1/tags/nope.blog')).statusCode).toBe(404);

    // On the site page: anyone signed in votes and adds; the form goes back to the tag block.
    const start = await server.inject('/auth/google?next=/site/food.blog/');
    const auth = new URL(start.headers.location as string);
    nonce = auth.searchParams.get('nonce') as string;
    const back = await server.inject({
      url: `/auth/google/callback?state=${auth.searchParams.get('state')}&code=c`,
      headers: { cookie: String(start.headers['set-cookie']).split(';')[0] },
    });
    const cookie = ([] as string[])
      .concat(back.headers['set-cookie'] as string[])
      .find((c) => /^traffic_session=[^;]/.test(c))
      ?.split(';')[0] as string;
    const send = (body: Record<string, string>, from = origin) =>
      server.inject({
        method: 'POST',
        url: '/site/food.blog/tags/',
        headers: { cookie, origin: from, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(body).toString(),
      });
    expect((await server.inject('/site/food.blog/')).body).toContain('登入參與標籤投票 →</a>');
    expect((await send({ kind: 'vote', tag: '美食', value: '1' }, 'https://evil.example')).statusCode).toBe(403);
    expect((await send({ kind: 'vote', tag: '美食', value: '1' })).headers.location).toBe('/site/food.blog/?tags=done#tags');
    expect((await send({ kind: 'admin', tag: '美食', value: 'hide' })).headers.location).toBe('/site/food.blog/?tags=not_admin#tags');
    const page = (await server.inject({ url: '/site/food.blog/?tags=done', headers: { cookie } })).body;
    expect(page).toContain('aria-pressed="true" title="再次點選收回同意"');
    expect(page).toContain('已更新標籤。');
    expect(page).not.toContain('解除覆寫');
    expect(await rows(pool, "SELECT voter, vote, via FROM tag_votes WHERE domain = 'food.blog' AND tag = '美食'")).toEqual([
      { voter: 'reader@gmail.com', vote: 1, via: 'web' },
    ]);
    expect((await rows<{ n: number }>(pool, 'SELECT COUNT(*) AS n FROM tag_log'))[0].n).toBeGreaterThan(10);
  });

  it('keeps political leaning out of tags, stores a reason per AI tag and counts votes per voter', async () => {
    await pool.query("INSERT INTO watches (requester, domain, kind, requested_at) VALUES ('blog', 'food.blog', 'watch', NOW())");
    const server = app();
    const call = (url: string, payload: object, method: 'POST' | 'PUT' = 'POST') =>
      server.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` }, payload });
    const ai = await call(
      '/internal/v1/tags/ai',
      { sites: [{ domain: 'food.blog', reason: '全站', tags: [{ tag: '美食', reason: '食記' }, '旅遊', '藍營'] }] },
      'PUT',
    );
    expect(ai.json()).toMatchObject({ sites: 1, changed: 2 });
    expect(await rows(pool, "SELECT tag, reason FROM tag_assignments WHERE source = 'ai' ORDER BY tag")).toEqual([
      { tag: '旅遊', reason: '全站' },
      { tag: '美食', reason: '食記' },
    ]);
    const refused = await call('/internal/v1/tags/propose', { voter: 'a@gmail.com', domain: 'food.blog', tag: '綠' });
    expect([refused.statusCode, refused.json().error]).toEqual([400, 'reserved_tag']);
    await call('/internal/v1/tags/vote', { voter: 'a@gmail.com', domain: 'food.blog', tag: '美食', vote: 1 });
    await call('/internal/v1/tags/propose', { voter: 'a@gmail.com', domain: 'food.blog', tag: '咖啡' });
    const stats = (await call('/internal/v1/tags/voters', { voters: ['A@gmail.com', 'b@gmail.com'], via: 'blog' })).json().voters;
    expect(stats['a@gmail.com'].votes).toBe(2);
    expect(stats['b@gmail.com']).toEqual({ votes: 0, lastAt: null });
    expect((await call('/internal/v1/tags/voters', { voters: ['a@gmail.com'], via: 'web' })).json().voters['a@gmail.com'].votes).toBe(0);
    expect((await call('/internal/v1/tags/voters', { voters: ['nobody'] })).statusCode).toBe(400);
  });

  it('fetches Cloudflare Radar for every watched domain once a day and serves the periods', async () => {
    const now = new Date('2026-10-21T19:35:00Z');
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at) VALUES ?', [
      [
        ['tag', 'a.com.tw', 'watch', now],
        ['sheet', 'b.com.tw', 'watch', now],
        ['manual', 'c.com.tw', 'watch', now],
        ['sheet', 'a.com.tw', 'watch', now],
      ],
    ]);
    const sent: string[] = [];
    const answer: Record<string, unknown> = { 'a.com.tw': 12, 'b.com.tw': '20000', 'c.com.tw': '>200000' };
    const request = (async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer radar-token');
      const domain = decodeURIComponent(new URL(url).pathname.split('/').pop() as string);
      sent.push(domain);
      const v = answer[domain];
      return Response.json({
        success: true,
        result: {
          details_0: typeof v === 'number' ? { rank: v } : { bucket: v },
          meta: { dateRange: [{ startTime: '2026-10-19T00:00:00Z', endTime: '2026-10-20T00:00:00Z' }] },
        },
      });
    }) as unknown as typeof fetch;
    const go = (at: Date) => runRadar(pool, { token: 'radar-token', request, now: () => at, pauseMs: 0 });
    expect(await runRadar(pool, { token: null })).toEqual({ skipped: 'no CLOUDFLARE_RADAR_API_TOKEN' });
    expect(await go(now)).toMatchObject({ due: 3, sent: 3, ok: 3, blocked: false });
    expect(sent.sort()).toEqual(['a.com.tw', 'b.com.tw', 'c.com.tw']);
    // Answered within 20 hours: nothing is due.
    expect(await go(new Date(now.getTime() + 3_600_000))).toMatchObject({ due: 0, sent: 0 });
    const ranks = await rows<{ domain: string; rank: number | null; bucket: number | null; bucket_lower_bound: number | null }>(
      pool,
      'SELECT domain, `rank`, bucket, bucket_lower_bound FROM radar_ranks ORDER BY domain',
    );
    expect(ranks.map((r) => [r.domain, radarLabel({ rank: r.rank, bucket: r.bucket, bucketLowerBound: r.bucket_lower_bound })])).toEqual([
      ['a.com.tw', '第 12 名'],
      ['b.com.tw', '前 20,000 名'],
      ['c.com.tw', '未入前 200,000 名'],
    ]);
    // A refusal stops the batch.
    const refused = (async () => new Response('no', { status: 429 })) as unknown as typeof fetch;
    expect(
      await runRadar(pool, { token: 'radar-token', request: refused, now: () => new Date(now.getTime() + 86_400_000), pauseMs: 0 }),
    ).toMatchObject({
      sent: 1,
      blocked: true,
    });
    const server = app();
    const res = await server.inject({
      method: 'POST',
      url: '/internal/v1/radar',
      headers: { authorization: `Bearer ${TAG}` },
      payload: { domains: ['a.com.tw', 'z.com.tw'] },
    });
    expect(res.json()).toMatchObject({
      scope: 'global',
      lastRun: { blocked: true, sent: 1 },
      domains: { 'a.com.tw': [{ rank: 12, bucket: null, dateEnd: '2026-10-20T00:00:00.000Z' }] },
    });
    expect(Object.keys(res.json().domains)).toEqual(['a.com.tw']);
    expect((await server.inject('/site/c.com.tw/')).body).toContain('未入前 200,000 名');
    await server.close();
  });
});
