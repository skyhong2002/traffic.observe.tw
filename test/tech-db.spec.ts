import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createPool, migrate, type Pool, rows } from '../src/db.ts';
import { runConfig } from '../src/scheduler.ts';
import { serviceStatus } from '../src/status.ts';
import { setRulesForTest, WAPPALYZER_NAMES } from '../src/tech.ts';
import { checkNow, dueDomains, loadTech, type PageFetcher, runTech, ScanFailure, saveObservation, techConfig } from '../src/tech-scan.ts';
import { compileVocabulary } from '../src/wappalyzer.ts';

// Against a scratch database (TRAFFIC_TEST_DB_URL); every table is dropped first.
const url = process.env.TRAFFIC_TEST_DB_URL;
const TOKEN = 'b'.repeat(40);
const rules = compileVocabulary(
  {
    WordPress: { meta: { generator: '^WordPress(?: ([\\d.]+))?\\;version:\\1' } },
    Hugo: { meta: { generator: 'Hugo ([\\d.]+)?\\;version:\\1' } },
  },
  'c'.repeat(40),
  WAPPALYZER_NAMES,
);
const site = (generator: string) => ({
  url: '',
  status: 200,
  headers: { 'content-type': 'text/html' },
  html: `<meta name="generator" content="${generator}">`,
});
const fake = (answers: Record<string, string | number>) => {
  const sent: string[] = [];
  const fetchPage: PageFetcher = async (domain) => {
    sent.push(domain);
    const a = answers[domain];
    if (a === undefined) throw new ScanFailure('network');
    if (typeof a === 'number') return { ...site(''), url: `https://${domain}/`, status: a };
    return { ...site(a), url: `https://${domain}/` };
  };
  return { fetchPage, sent };
};
const NOW = new Date('2026-10-25T00:00:00Z');
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe.skipIf(!url)('technology scans with a database', () => {
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
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at) VALUES ?', [
      [
        ['tag', 'news.com.tw', 'watch', NOW],
        ['blog', 'me.blog.tw', 'watch', NOW],
        ['blog', 'once.com.tw', 'traffic', NOW],
      ],
    ]);
  });
  afterEach(() => setRulesForTest(undefined));

  it('scans standing lists only, stores detections, and keeps the snapshot through a later failure', async () => {
    const first = fake({ 'news.com.tw': 'WordPress 6.8', 'me.blog.tw': 'Hugo 0.150.0' });
    expect(await runTech(pool, { rules, fetchPage: first.fetchPage, now: () => NOW, pauseMs: 0 })).toMatchObject({ sent: 2, ok: 2 });
    expect(first.sent.sort()).toEqual(['me.blog.tw', 'news.com.tw']);
    const later = new Date(NOW.getTime() + 31 * 86_400_000);
    const second = fake({ 'news.com.tw': 403 });
    await runTech(pool, { rules, fetchPage: second.fetchPage, now: () => later, pauseMs: 0 });
    const news = (await loadTech(pool, ['news.com.tw'])).get('news.com.tw');
    expect(news).toMatchObject({ status: 'blocked', errorCode: 'waf', observedAt: NOW.toISOString(), origin: 'traffic' });
    expect(news?.detections.map((d) => [d.id, d.version])).toEqual([['wordpress', '6.8']]);
  });

  it('persists the daily batch interval and paces different homepages ten seconds apart', async () => {
    const f = fake({ 'news.com.tw': 'WordPress 6.8', 'me.blog.tw': 'Hugo 1.0' });
    const pauses: number[] = [];
    expect(
      await runTech(pool, {
        rules,
        fetchPage: f.fetchPage,
        now: () => NOW,
        delay: async (ms) => {
          pauses.push(ms);
        },
      }),
    ).toMatchObject({ sent: 2 });
    expect(pauses).toEqual([techConfig().pauseSeconds * 1000]);
    f.sent.length = 0;
    expect(await runTech(pool, { rules, fetchPage: f.fetchPage, now: () => new Date(NOW.getTime() + 23 * 3_600_000) })).toMatchObject({
      skipped: 'website technology batch interval',
      nextRunAt: '2026-10-26T00:00:00.000Z',
    });
    expect(f.sent).toEqual([]);
    expect((await rows(pool, 'SELECT * FROM tech_runs')).length).toBe(1);
    await runTech(pool, { rules, fetchPage: f.fetchPage, now: () => new Date(NOW.getTime() + 24 * 3_600_000) });
    expect((await rows(pool, 'SELECT * FROM tech_runs')).length).toBe(2);
    expect(f.sent).toEqual([]); // A new daily batch does not override each domain's 30-day refresh.
  });

  it('shares a full-day homepage cache and a global lock between manual and automatic scans', async () => {
    const f = fake({ 'news.com.tw': 'WordPress 6.8' });
    expect(await checkNow(pool, 'news.com.tw', { rules, fetchPage: f.fetchPage, now: NOW })).toMatchObject({ fresh: true });
    expect(
      await checkNow(pool, 'news.com.tw', { rules, fetchPage: f.fetchPage, now: new Date(NOW.getTime() + 23 * 3_600_000) }),
    ).toMatchObject({ fresh: false });
    expect(f.sent).toEqual(['news.com.tw']);
    const conn = await pool.getConnection();
    await conn.query("SELECT GET_LOCK('traffic-tech',0)");
    try {
      expect(
        await checkNow(pool, 'news.com.tw', { rules, fetchPage: f.fetchPage, now: new Date(NOW.getTime() + 24 * 3_600_000) }),
      ).toMatchObject({ error: 'busy' });
      expect(await runTech(pool, { rules, fetchPage: f.fetchPage, now: () => new Date(NOW.getTime() + 24 * 3_600_000) })).toMatchObject({
        skipped: 'another run holds the lock',
      });
    } finally {
      await conn.query("SELECT RELEASE_LOCK('traffic-tech')");
      conn.release();
    }
    expect(f.sent).toEqual(['news.com.tw']);
    expect(
      await checkNow(pool, 'news.com.tw', { rules, fetchPage: f.fetchPage, now: new Date(NOW.getTime() + 24 * 3_600_000) }),
    ).toMatchObject({ fresh: true });
    expect(f.sent).toHaveLength(2);
    expect(await rows(pool, 'SELECT * FROM sends')).toEqual([]);
  });

  it('distinguishes stored-data checks, Similarweb requests and homepage scans in public status', async () => {
    await runTech(pool, {
      rules,
      fetchPage: fake({ 'news.com.tw': 'WordPress 6.8', 'me.blog.tw': 'Hugo 1.0' }).fetchPage,
      now: () => NOW,
      pauseMs: 0,
    });
    const requestAt = new Date(NOW.getTime() - 3_600_000);
    await pool.query("INSERT INTO sends(domain,at,outcome) VALUES ('news.com.tw',?,'ok')", [requestAt]);
    await pool.query("INSERT INTO runs(started_at,finished_at,budget,sent,ok,note) VALUES (?,?,15,1,1,NULL),(?,?,15,0,0,'cooling down')", [
      requestAt,
      requestAt,
      NOW,
      NOW,
    ]);
    const state = await serviceStatus(pool, runConfig({ TRAFFIC_RUN_BUDGET: '15' }), NOW);
    expect(state.activities.similarweb).toMatchObject({
      usesSimilarwebQuota: true,
      last24hRequests: 1,
      lastRequestAt: requestAt.toISOString(),
      lastScheduleCheckAt: NOW.toISOString(),
    });
    expect(state.activities.websiteTechnology).toMatchObject({
      usesSimilarwebQuota: false,
      destination: '各網站首頁',
      last24hAutomaticDomainScans: 2,
    });
    expect(state.activities.cloudflareRadar.usesSimilarwebQuota).toBe(false);
    expect(state.activities.storedDataApi).toMatchObject({
      usesSimilarwebQuota: false,
      triggersUpstreamFetch: false,
      recommendedPollSeconds: 3600,
    });
    expect(state.runs[0]).toMatchObject({ activity: 'schedule-check', destination: 'local-database', sent: 0, usesSimilarwebQuota: false });
    expect(state.runs[1]).toMatchObject({
      activity: 'provider-request',
      destination: 'data.similarweb.com',
      sent: 1,
      usesSimilarwebQuota: true,
    });
  });

  it('never lets an older attempt overwrite a newer one', async () => {
    const o = (status: 'detected' | 'failed', when: Date) => ({
      status,
      sourceUrl: null,
      httpStatus: null,
      errorCode: status === 'failed' ? ('network' as const) : null,
      ruleVersion: 'v',
      at: when.toISOString(),
      detections: [],
    });
    await saveObservation(pool, 'news.com.tw', o('detected', NOW));
    await saveObservation(pool, 'news.com.tw', o('failed', days(1)));
    expect((await loadTech(pool, ['news.com.tw'])).get('news.com.tw')).toMatchObject({
      status: 'detected',
      lastAttemptAt: NOW.toISOString(),
    });
  });

  it('puts never-checked domains first, then imported ones we have not tried, and backs off after failures', async () => {
    await saveObservation(
      pool,
      'me.blog.tw',
      {
        status: 'unknown',
        sourceUrl: null,
        httpStatus: null,
        errorCode: null,
        ruleVersion: 'p',
        at: days(2).toISOString(),
        detections: [],
      },
      'blog',
    );
    expect(await dueDomains(pool, NOW, 10)).toEqual(['news.com.tw', 'me.blog.tw']);
    // Our own failure keeps the imported snapshot but waits a day before trying again.
    await saveObservation(pool, 'me.blog.tw', {
      status: 'failed',
      sourceUrl: null,
      httpStatus: null,
      errorCode: 'timeout',
      ruleVersion: 'p',
      at: NOW.toISOString(),
      detections: [],
    });
    expect(await dueDomains(pool, NOW, 10)).toEqual(['news.com.tw']);
    expect(await dueDomains(pool, new Date(NOW.getTime() + 25 * 3_600_000), 10)).toEqual(['news.com.tw', 'me.blog.tw']);
    expect((await loadTech(pool, ['me.blog.tw'])).get('me.blog.tw')).toMatchObject({
      origin: 'blog',
      status: 'failed',
      observedAt: days(2).toISOString(),
    });
  });

  it('serves the overview, one domain, and the internal read to a service with a token only', async () => {
    setRulesForTest(rules);
    await runTech(pool, { rules, fetchPage: fake({ 'news.com.tw': 'WordPress 6.8' }).fetchPage, now: () => NOW, pauseMs: 0 });
    const app = buildApp(pool, { tokens: new Map([['blog', Buffer.from(TOKEN)]]), login: null, logger: false });
    const page = await app.inject('/tech/?technology=wordpress');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('用 WordPress 的網站');
    const api = (await app.inject('/api/v1/tech?source=tag')).json();
    expect(api.coverage).toMatchObject({ sites: 1, checked: 1, detected: 1 });
    expect(api.technologies).toEqual([{ id: 'wordpress', name: 'WordPress', category: 'cms', sites: 1 }]);
    expect((await app.inject('/api/v1/tech/news.com.tw')).json()).toMatchObject({
      status: 'detected',
      detections: [{ id: 'wordpress', version: '6.8' }],
    });
    expect((await app.inject('/api/v1/tech/nothing.com.tw')).statusCode).toBe(404);
    expect((await app.inject('/tech/nothing.com.tw/')).body).toContain('不在任何追蹤清單裡');
    expect((await app.inject('/site/news.com.tw/')).body).toContain('網站技術');
    const internal = (auth?: string) =>
      app.inject({
        method: 'POST',
        url: '/internal/v1/tech',
        remoteAddress: '127.0.0.1',
        headers: auth ? { authorization: `Bearer ${auth}` } : {},
        payload: { domains: ['news.com.tw', 'https://www.me.blog.tw/', 'unknown.com.tw'] },
      });
    expect((await internal()).statusCode).toBe(404);
    const body = (await internal(TOKEN)).json();
    expect(Object.keys(body.sites).sort()).toEqual(['me.blog.tw', 'news.com.tw']);
    expect(body.sites['me.blog.tw']).toMatchObject({ status: 'failed', errorCode: 'network', observedAt: null });
    expect(body.notChecked).toEqual(['unknown.com.tw']);
    expect(body.rules).toBe('wappalyzer-cccccccccccc');
    await app.close();
  });
});
