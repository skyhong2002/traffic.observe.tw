import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createPool, migrate, type Pool, rows } from '../src/db.ts';
import { setRulesForTest, WAPPALYZER_NAMES } from '../src/tech.ts';
import { dueDomains, loadTech, type PageFetcher, runTech, ScanFailure, saveObservation } from '../src/tech-scan.ts';
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
