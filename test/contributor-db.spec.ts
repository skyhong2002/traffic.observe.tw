import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadCollection, syncCollections } from '../src/collection.ts';
import { createContributorPayload, loadCommunity, saveContributorPayload, signContributorToken } from '../src/contributor.ts';
import { loadMonthCoverage } from '../src/coverage.ts';
import { createPool, migrate, type Pool, rows } from '../src/db.ts';
import { setManualMonth } from '../src/manual.ts';
import { monthView } from '../src/metrics.ts';
import { runConfig, runOnce } from '../src/scheduler.ts';
import { trafficChannels } from '../src/similarweb.ts';
import { saveTraffic } from '../src/store.ts';
import { emptyNodeState, enqueue, syncNode } from '../tools/contributor-node.ts';

const url = process.env.TRAFFIC_TEST_DB_URL;
const month = '202610';
const fetchedAt = '2026-11-01T01:00:00.000Z';
const contribution = (domain = 'example.com', node = 'fixture', visits = 123000) =>
  createContributorPayload({
    domain,
    targetMonth: month,
    fetchedAt,
    sourceNode: node,
    sourceVersion: 'fixture-1',
    responseStatus: 200,
    payload: {
      visits,
      channels: Object.fromEntries(trafficChannels.map((c) => [c, 0])),
      countries: [{ code: 'TW', share: 1 }],
      bounceRate: 0,
      pagesPerVisit: 2,
      timeOnSite: 0,
    },
  });
const config = () => runConfig({ TRAFFIC_COLLECTION_ENABLED: '1', TRAFFIC_TARGET_MONTH: month });

describe.skipIf(!url)('contributor and manual technology end to end', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = createPool(url, { size: 4, multipleStatements: true });
  });
  afterAll(async () => {
    await pool.end();
  });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    for (const { t } of await rows<{ t: string }>(
      pool,
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE()',
    ))
      await pool.query(`DROP TABLE \`${t}\``);
    await migrate(pool);
    vi.stubEnv('TRAFFIC_CONTRIBUTOR_SECRET', 'isolated-test-signing-key-not-production');
    vi.stubEnv('TRAFFIC_CONTRIBUTOR_TRUST', 'fixture:10,other:1');
    vi.stubEnv('TRAFFIC_COMMUNITY_ENABLED', '1');
    await pool.query("INSERT INTO watches (requester,domain,kind,requested_at) VALUES ('sheet','example.com','watch',?)", [
      new Date('2026-10-01'),
    ]);
  });
  it('delivers a durable node batch over HTTP, deduplicates concurrent replay and adopts complete trusted data', async () => {
    const app = buildApp(pool, { login: null, logger: false, config: config() });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const state = emptyNodeState();
      enqueue(state, [contribution()]);
      await syncNode(state, address, signContributorToken('fixture')!);
      expect(state.items[0].state).toBe('sent');
      await Promise.all([saveContributorPayload(pool, contribution()), saveContributorPayload(pool, contribution())]);
      expect(await rows(pool, 'SELECT id FROM contributor_observations')).toHaveLength(1);
      expect(await rows(pool, 'SELECT observation_id FROM contributor_canonical')).toEqual([{ observation_id: 1 }]);
      expect(await rows(pool, 'SELECT * FROM sends')).toEqual([]);
      expect((await monthView(pool, month))[0]).toMatchObject({
        visits: 0.123,
        visitsSource: 'community',
        provenance: { sourceNode: 'fixture' },
      });
      const collection = await loadCollection(pool, config(), month);
      expect(collection.summary.complete).toBe(1);
      expect(collection.entries[0]).toMatchObject({ hasCommunity: true, complete: true });
      const missing = (await app.inject('/status/collection/?month=202610&view=collection&source=none')).body;
      expect(missing).not.toContain('href="/site/example.com/"');
      const sourcesPage = (await app.inject('/status/collection/?month=202610&view=collection&source=community')).body;
      expect(sourcesPage).toContain('可信社群');
      expect(sourcesPage).toContain('fixture');
      const coverage = (await loadMonthCoverage(pool, [month]))[month];
      expect(coverage).toMatchObject({ tracked: 1, withVisits: 1, complete: 1, lastUpdatedAt: fetchedAt });
      const ranking = (await app.inject(`/api/v1/rankings?month=${month}`)).json();
      expect(ranking.coverage).toEqual(coverage);
      expect(ranking.sites[0].visitsSource).toBe('community');
      const site = (await app.inject(`/site/example.com/?month=${month}`)).body;
      expect(site).toContain('fixture');
      const sources = (await app.inject('/api/v1/contributors/example.com?month=202610')).json();
      expect(sources.canonical[month].sourceNode).toBe('fixture');
      expect(sources.decisions[month].reason).toContain('trusted=10');
    } finally {
      await app.close();
    }
  });
  it('returns partial batch results, rejects secret fields without storing them, and rejects an expired token', async () => {
    const app = buildApp(pool, { login: null, logger: false });
    try {
      const headers = { authorization: `Bearer ${signContributorToken('fixture')}` };
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/contributors/upload',
        headers,
        payload: [contribution(), { ...contribution(), cookie: 'do-not-store' }, contribution('untracked.com')],
      });
      expect(response.statusCode).toBe(207);
      expect(response.json()).toMatchObject({ accepted: 1, rejected: 2 });
      const rejections = await rows(pool, 'SELECT * FROM contributor_rejections');
      expect(rejections).toHaveLength(2);
      expect(JSON.stringify(rejections)).not.toContain('do-not-store');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/contributors/upload',
            headers: { authorization: `Bearer ${signContributorToken('fixture', Math.floor(Date.now() / 1000) - 901)}` },
            payload: contribution(),
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
  it('keeps original automatic data and untrusted observations and supports immediate flag/trust rollback', async () => {
    await saveContributorPayload(pool, contribution());
    await saveContributorPayload(pool, contribution('example.com', 'unknown', 999000));
    expect((await loadCommunity(pool))[0].sourceNode).toBe('fixture');
    await saveTraffic(pool, [{ domain: 'example.com', fetchedAt, monthly: [{ month, visits: 456000 }], profiles: {} }]);
    expect((await monthView(pool, month))[0]).toMatchObject({ visits: 0.456, visitsSource: 'similarweb' });
    vi.stubEnv('TRAFFIC_COMMUNITY_ENABLED', '0');
    expect(await loadCommunity(pool)).toEqual([]);
    vi.stubEnv('TRAFFIC_COMMUNITY_ENABLED', '1');
    vi.stubEnv('TRAFFIC_CONTRIBUTOR_TRUST', '');
    expect(await loadCommunity(pool)).toEqual([]);
    expect(await rows(pool, 'SELECT id FROM contributor_observations')).toHaveLength(2);
    expect(await rows(pool, 'SELECT visits FROM traffic_months')).toEqual([{ visits: 456000 }]);
  });
  it('lets only same-origin editors add auditable technical evidence without changing automatic results', async () => {
    const origin = 'https://site.observe.tw';
    await pool.query('INSERT INTO sessions (token_hash,email,created_at,expires_at) VALUES (?,?,NOW(),DATE_ADD(NOW(),INTERVAL 1 DAY))', [
      createHash('sha256').update('tech-editor').digest('hex'),
      'editor@example.com',
    ]);
    const app = buildApp(pool, {
      logger: false,
      login: { clientId: 'id', clientSecret: 'test', origin, admins: new Set(['editor@example.com']) },
    });
    await pool.query(
      "INSERT INTO tech_scans (domain,status,error_code,http_status,last_attempt_at) VALUES ('example.com','blocked','waf',403,NOW())",
    );
    const post = (cookie: string, from = origin, sourceUrl = 'https://example.com/about/') =>
      app.inject({
        method: 'POST',
        url: '/tech/example.com/manual/',
        headers: { cookie, origin: from, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ products: 'wordpress', observedAt: '2026-11-01', sourceUrl }).toString(),
      });
    try {
      expect((await post('')).statusCode).toBe(303);
      expect((await post('traffic_session=tech-editor', 'https://evil.example')).statusCode).toBe(403);
      expect((await post('traffic_session=tech-editor', origin, 'https://example.com/?token=secret')).statusCode).toBe(400);
      expect((await post('traffic_session=tech-editor')).statusCode).toBe(303);
      expect(await rows(pool, 'SELECT status,error_code,http_status FROM tech_scans')).toEqual([
        { status: 'blocked', error_code: 'waf', http_status: 403 },
      ]);
      expect(await rows(pool, 'SELECT action FROM tech_manual_log')).toEqual([{ action: 'save' }]);
      const api = (await app.inject('/api/v1/tech/example.com')).json();
      expect(api.manual[0]).toMatchObject({ id: 'wordpress', source: 'manual', observedAt: '2026-11-01T00:00:00.000Z' });
      expect((await app.inject('/tech/example.com/')).body).toContain('人工確認');
    } finally {
      await app.close();
    }
  });
  it('serves HTML 404s and bounded readiness failure while liveness remains available', async () => {
    const app = buildApp(pool, {
      login: { clientId: 'id', clientSecret: 'test', origin: 'https://site.observe.tw', admins: new Set<string>() },
      logger: false,
    });
    try {
      expect((await app.inject({ url: '/missing-page', headers: { accept: 'text/html' } })).headers['content-type']).toContain('text/html');
      expect((await app.inject({ url: '/api/v1/missing', headers: { accept: 'text/html' } })).headers['content-type']).toContain(
        'application/json',
      );
      const query = vi.spyOn(pool, 'query').mockImplementation(() => new Promise(() => {}) as never);
      const started = Date.now();
      expect((await app.inject({ url: '/healthz', headers: { cookie: 'traffic_session=stale' } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/readyz', headers: { cookie: 'traffic_session=stale' } })).statusCode).toBe(503);
      expect(Date.now() - started).toBeLessThan(3000);
      query.mockRestore();
    } finally {
      await app.close();
    }
  });
  it('chooses the latest complete coverage month by default, honors explicit month, and exports matching CSV metadata', async () => {
    const full = contribution();
    await saveContributorPayload(pool, createContributorPayload({ ...full, targetMonth: '202609' }));
    await saveContributorPayload(pool, createContributorPayload({ ...full, payload: { visits: 100 } }));
    const app = buildApp(pool, { login: null, logger: false });
    try {
      expect((await app.inject('/api/v1/rankings')).json().month).toBe('202609');
      const response = (await app.inject('/api/v1/rankings?month=202610')).json();
      expect(response.month).toBe('202610');
      expect(response.coverage).toMatchObject({ tracked: 1, withVisits: 1, complete: 0 });
      const csv = await app.inject('/api/v1/rankings.csv?month=202610');
      expect(csv.headers['x-coverage-month']).toBe('202610');
      expect(csv.headers['x-coverage-tracked']).toBe(String(response.coverage.tracked));
      expect(csv.headers['x-coverage-complete']).toBe(String(response.coverage.complete));
      expect(csv.headers['x-coverage-last-updated-at']).toBe(response.coverage.lastUpdatedAt);
    } finally {
      await app.close();
    }
  });
  it('preserves automatic, manual and community values for the same month', async () => {
    await saveContributorPayload(pool, contribution());
    await setManualMonth(pool, 'editor@example.com', 'example.com', month, {
      domain: 'example.com',
      month,
      visits: 234000,
      searchShare: null,
      aiShare: null,
      taiwanShare: 1,
      channels: {},
      details: null,
    });
    expect((await monthView(pool, month))[0]).toMatchObject({ visits: 0.234, visitsSource: 'manual' });
    await saveTraffic(pool, [{ domain: 'example.com', fetchedAt, monthly: [{ month, visits: 345000 }], profiles: {} }]);
    const app = buildApp(pool, { login: null, logger: false });
    try {
      const data = (await app.inject('/api/v1/sites/example.com')).json();
      const row = data.months.find((r: { month: string }) => r.month === month);
      expect(row).toMatchObject({ similarweb: 0.34, manual: 0.23, community: 0.12 });
      expect(row.provenance.adopted).toBe(false);
      expect((await monthView(pool, month))[0]).toMatchObject({ visits: 0.345, visitsSource: 'similarweb' });
    } finally {
      await app.close();
    }
  });
  it('starts canary only in worker sync, persists decisions and rolls back on refusal without changing backoff', async () => {
    const now = new Date('2026-11-17T10:00:00Z');
    const cfg = runConfig({
      TRAFFIC_COLLECTION_ENABLED: '1',
      TRAFFIC_TARGET_MONTH: month,
      TRAFFIC_QUEUE_OPTIMIZATION: '1',
      TRAFFIC_QUEUE_CANARY: 'isolated',
      TRAFFIC_RUN_BUDGET: '1',
      TRAFFIC_WEEKLY_BUDGET: 'auto',
      TRAFFIC_ADAPTIVE_BACKOFF: '1',
    });
    expect((await loadCollection(pool, cfg, month, now)).queue[0].decision.policy).toBe('baseline');
    expect(await rows(pool, 'SELECT * FROM queue_canaries')).toEqual([]);
    await syncCollections(pool, cfg, now);
    expect((await loadCollection(pool, cfg, month, now)).queue[0].decision.policy).toBe('fair-v1');
    const result = await runOnce(pool, {
      config: cfg,
      now: () => now,
      pauseMs: 0,
      request: (async () => new Response('{}', { status: 429, headers: { 'retry-after': '7200' } })) as typeof fetch,
    });
    expect(result).toMatchObject({ refused: true });
    expect(
      (await rows<{ rolled_back_at: Date | null }>(pool, 'SELECT rolled_back_at FROM queue_canaries'))[0].rolled_back_at,
    ).not.toBeNull();
    expect((await loadCollection(pool, cfg, month, new Date(now.getTime() + 3 * 86400000))).queue[0]?.decision.policy ?? 'baseline').toBe(
      'baseline',
    );
    const [send] = await rows<{ queue_decision: string | object; outcome: string }>(pool, 'SELECT queue_decision,outcome FROM sends');
    expect(send.outcome).toBe('refused');
    expect(JSON.stringify(send.queue_decision)).toContain('fair-v1');
    await syncCollections(pool, cfg, new Date(now.getTime() + 3 * 86400000));
    expect(await rows(pool, 'SELECT id FROM queue_canaries')).toHaveLength(1);
  });
});
