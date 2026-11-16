import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import {
  collectionMonth,
  collectionMonths,
  coverageFields,
  loadCollection,
  publicCollection,
  recordCollectionAttempt,
  setCollectionPriority,
  syncCollections,
} from '../src/collection.ts';
import { createPool, migrate, type Pool, rows } from '../src/db.ts';
import { fetchPolicy } from '../src/fetch-policy.ts';
import { parseManualDetails, setManualMonth } from '../src/manual.ts';
import { dueDomains, loadCandidates, runConfig, runOnce } from '../src/scheduler.ts';
import { type TrafficProfile, trafficChannels } from '../src/similarweb.ts';
import { saveTraffic } from '../src/store.ts';

const at = new Date('2026-11-10T10:00:00Z');
const DAY = 86_400_000;
const profile = (month = '202610'): TrafficProfile => ({
  month,
  countries: [{ code: 'TW', share: 0.9 }],
  channels: Object.fromEntries(trafficChannels.map((c) => [c, 0])),
  bounceRate: 0,
  pagesPerVisit: 2,
  timeOnSite: 0,
  globalRank: null,
  countryRank: null,
  categoryRank: null,
});
const response = (domain: string) => ({
  SiteName: domain,
  EstimatedMonthlyVisits: { '2026-10-01': 200 },
  Engagments: { Year: '2026', Month: '10', BounceRate: 0, PagePerVisit: 2, TimeOnSite: 10 },
  TrafficSources: Object.fromEntries(trafficChannels.map((c) => [c, 0])),
  TopCountryShares: [{ CountryCode: 'TW', Value: 0.9 }],
});
const url = process.env.TRAFFIC_TEST_DB_URL;
const config = () =>
  runConfig({ TRAFFIC_RUN_BUDGET: '15', TRAFFIC_WEEKLY_BUDGET: 'auto', TRAFFIC_COLLECTION_ENABLED: '1', TRAFFIC_CORE_DOMAINS: '1' });

describe('monthly collection fields', () => {
  it('requires actual fields, treats zero as reported, and combines complementary profiles', () => {
    expect(coverageFields(100, [profile()]).missing).toEqual([]);
    expect(coverageFields(0, [profile()]).missing).toEqual(['visits']);
    const partial = { ...profile(), channels: { SearchOrganic: 0 }, countries: [], timeOnSite: null };
    expect(coverageFields(100, [partial]).missing).toContain('channels.Direct');
    expect(coverageFields(100, [partial]).missing).toContain('channels.GenAi');
    expect(coverageFields(100, [partial]).missing).not.toContain('channels.SearchPaid');
    expect(coverageFields(100, [partial]).missing).not.toContain('channels.SocialPaid');
    expect(coverageFields(100, [partial]).missing).not.toContain('channels.Mail');
    expect(coverageFields(100, [partial]).missing).not.toContain('channels.Affiliate');
    expect(
      coverageFields(100, [partial, { channels: { ...profile().channels }, countries: profile().countries, timeOnSite: 0 }]).missing,
    ).toEqual([]);
  });
  it('derives the target for any month and validates a configured override', () => {
    expect(collectionMonth(config(), new Date('2027-01-01T00:00:00Z'))).toBe('202612');
    expect(collectionMonth({ ...config(), targetMonth: '202610' }, new Date('2027-01-01T00:00:00Z'))).toBe('202610');
    expect(() => runConfig({ TRAFFIC_TARGET_MONTH: '202613' })).toThrow('Invalid TRAFFIC_TARGET_MONTH');
    expect(() => collectionMonth({ ...config(), targetMonth: '202701' }, new Date('2027-01-01T00:00:00Z'))).toThrow('past month');
  });
});

describe.skipIf(!url)('monthly collection database', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = createPool(url, { size: 4, multipleStatements: true });
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    for (const { t } of await rows<{ t: string }>(
      pool,
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE()',
    ))
      await pool.query(`DROP TABLE \`${t}\``);
    await migrate(pool);
  });
  const watch = async (...domains: string[]) => {
    await pool.query('INSERT INTO watches (requester,domain,kind,requested_at) VALUES ?', [domains.map((d) => ['sheet', d, 'watch', at])]);
  };
  const save = async (domain: string, month = '202610', visits = 100, p: TrafficProfile | null = profile(month)) =>
    saveTraffic(pool, [{ domain, fetchedAt: at.toISOString(), monthly: [{ month, visits }], profiles: p ? { [month]: p } : {} }]);
  const fetcher = () => {
    const sent: string[] = [];
    const request = (async (input: string) => {
      const domain = new URL(input).searchParams.get('domain')!;
      sent.push(domain);
      return new Response(JSON.stringify(response(domain)));
    }) as unknown as typeof fetch;
    return { sent, request };
  };
  it('filters missing report sites by tags and exports both selected months including prior-only websites', async () => {
    await watch('current.tw', 'missing.tw', 'other.tw');
    await save('current.tw', '202608', 4_000_000);
    await save('missing.tw', '202608', 8_000_000);
    await save('current.tw', '202609', 2_000_000);
    await save('missing.tw', '202609', 6_000_000);
    await save('current.tw', '202610', 3_000_000, { ...profile(), channels: { SearchOrganic: 0.2, GenAi: 0 } });
    await pool.query('INSERT INTO site_metadata (domain,name,topics,updated_at,updated_by) VALUES ?', [
      [
        ['current.tw', '目前購物', JSON.stringify(['電商']), at, 'test'],
        ['missing.tw', '待補購物', JSON.stringify(['電商']), at, 'test'],
        ['other.tw', '其他網站', JSON.stringify(['部落格']), at, 'test'],
      ],
    ]);
    const app = buildApp(pool, { config: config(), login: null, logger: false });
    try {
      const missing = await app.inject('/status/collection/?month=202610&from=202608&source=none&topic=電商&exclude=');
      expect(missing.statusCode).toBe(200);
      expect(missing.body).toContain('id="report-collection"');
      expect(missing.body).toContain('/site/missing.tw/manual/?month=202610');
      expect(missing.body).not.toContain('/site/other.tw/manual/');
      expect(missing.body).toContain('部落格');
      const response = await app.inject('/api/v1/rankings.csv?month=202610&from=202608&topic=電商&exclude=');
      expect(response.statusCode).toBe(200);
      const lines = response.body
        .trim()
        .replace(/^\uFEFF/, '')
        .split('\n')
        .map((line) => line.split(','));
      const header = lines[0];
      const index = (name: string) => {
        const at = header.indexOf(name);
        expect(at).toBeGreaterThanOrEqual(0);
        return at;
      };
      const current = lines.find((row) => row[index('網域')] === 'current.tw')!;
      const previousOnly = lines.find((row) => row[index('網域')] === 'missing.tw')!;
      expect(current[index('比較月份')]).toBe('202608');
      expect(current[index('比較月流量(百萬)')]).toBe('4');
      expect(current[index('上月名次')]).toBe('2');
      expect(current[index('AI排行')]).toBe('1');
      expect(previousOnly[index('流量(百萬)')]).toBe('');
      expect(previousOnly[index('比較月流量(百萬)')]).toBe('8');
      expect(previousOnly[index('名次')]).toBe('');
      expect(previousOnly[index('比較月造訪量排名')]).toBe('1');
      expect(previousOnly[index('當月報表缺漏')]).toContain('造訪量');
      expect(lines).toHaveLength(3);
    } finally {
      await app.close();
    }
  });
  it('uses importance and prior Taiwan traffic ahead of new-domain or source order', async () => {
    await watch('small.tw', 'large.tw', 'foreign.com', 'pinned.com');
    await save('small.tw', '202609', 100);
    await save('large.tw', '202609', 10000);
    await save('foreign.com', '202609', 1_000_000, { ...profile('202609'), countries: [{ code: 'TW', share: 0.01 }] });
    await setCollectionPriority(pool, 'pinned.com', 1, 'editor@example.com');
    const c = await loadCollection(pool, config(), '202610', at);
    expect(c.queue.map((e) => [e.domain, e.priority])).toEqual([
      ['pinned.com', 1],
      ['large.tw', 2],
      ['small.tw', 3],
      ['foreign.com', 4],
    ]);
    expect(dueDomains(await loadCandidates(pool, config(), at), at)).toEqual(c.queue.map((e) => e.domain));
  });
  it('lets a site with a rare tag go ahead of a bigger site with only common tags', async () => {
    const common = Array.from({ length: 21 }, (_, i) => `common${i}.tw`);
    await watch('core.tw', 'rare.tw', 'small-rare.tw', ...common);
    await save('core.tw', '202609', 1_000_000);
    await save('rare.tw', '202609', 2000);
    await save('small-rare.tw', '202609', 10);
    for (const [i, d] of common.entries()) await save(d, '202609', 5000 + i);
    await pool.query('INSERT INTO site_metadata (domain,name,topics,updated_at,updated_by) VALUES ?', [
      [
        ['rare.tw', '稀有', JSON.stringify(['宗教', '新聞']), at, 'test'],
        ['small-rare.tw', '小稀有', JSON.stringify(['宗教']), at, 'test'],
        ...common.map((d) => [d, d, JSON.stringify(['新聞', '其他']), at, 'test']),
      ],
    ]);
    const c = await loadCollection(pool, config(), '202610', at);
    const order = c.queue.map((e) => e.domain);
    // core.tw is the single core domain; then 2000 × 10 beats every common site, which in turn beat 10 × 10.
    expect(order.slice(0, 3)).toEqual(['core.tw', 'rare.tw', 'common20.tw']);
    expect(order.at(-1)).toBe('small-rare.tw');
    expect(c.entries.find((e) => e.domain === 'rare.tw')?.rareTags).toEqual(['宗教']);
    expect(c.entries.find((e) => e.domain === 'common0.tw')?.rareTags).toEqual([]);
    expect(dueDomains(await loadCandidates(pool, config(), at), at)).toEqual(order);
    const entry = publicCollection(c).entries.find((e) => e.domain === 'rare.tw');
    expect(entry?.rareTags).toEqual(['宗教']);
    expect(entry).not.toHaveProperty('score');
    expect(entry).not.toHaveProperty('queueScore');
  });
  it('merges manual fields, removes completed work, and reopens deleted data', async () => {
    await watch('done.tw', 'partial.tw', 'zero.tw');
    const p = profile();
    delete p.channels.GenAi;
    await save('done.tw', '202610', 100, p);
    await save('zero.tw', '202610', 0, profile());
    await setManualMonth(pool, 'editor@example.com', 'done.tw', '202610', {
      domain: 'done.tw',
      month: '202610',
      visits: 100,
      searchShare: null,
      aiShare: 0,
      taiwanShare: null,
      channels: { GenAi: 0 },
      details: parseManualDetails({}),
    });
    await setManualMonth(pool, 'editor@example.com', 'partial.tw', '202610', {
      domain: 'partial.tw',
      month: '202610',
      visits: 100,
      searchShare: null,
      aiShare: null,
      taiwanShare: null,
      channels: {},
      details: parseManualDetails({}),
    });
    let c = await loadCollection(pool, config(), '202610', at);
    expect(c.entries.find((e) => e.domain === 'done.tw')).toMatchObject({ complete: true, hasManual: true, hasAutomatic: true });
    expect(c.entries.find((e) => e.domain === 'partial.tw')).toMatchObject({ complete: false, fields: { visits: true } });
    expect(c.entries.find((e) => e.domain === 'zero.tw')?.missing).toContain('visits');
    const f = fetcher();
    await runOnce(pool, { config: config(), only: ['done.tw'], request: f.request, now: () => at });
    expect(f.sent).toEqual([]);
    await pool.query("DELETE FROM manual_months WHERE domain='done.tw'");
    c = await loadCollection(pool, config(), '202610', at);
    expect(c.entries.find((e) => e.domain === 'done.tw')?.missing).toEqual(['channels.GenAi']);
  });
  it('schedules manual entries after untouched work despite pinned priority and reserved retry slots', async () => {
    await watch('fresh.tw', 'retry.tw', 'manual-fresh.tw', 'manual-retry.tw');
    await syncCollections(pool, config(), at);
    for (const domain of ['manual-fresh.tw', 'manual-retry.tw']) {
      await setCollectionPriority(pool, domain, 1, 'editor@example.com');
      await setManualMonth(pool, 'editor@example.com', domain, '202610', {
        domain,
        month: '202610',
        visits: 100,
        searchShare: null,
        aiShare: null,
        taiwanShare: null,
        channels: {},
        details: parseManualDetails({}),
      });
    }
    for (const domain of ['retry.tw', 'manual-retry.tw'])
      await recordCollectionAttempt(pool, '202610', domain, new Date(at.getTime() - 4 * DAY), 'response');
    await pool.query('INSERT INTO sends (domain,at,outcome,target_month) VALUES ?', [
      Array.from({ length: 4 }, () => ['used.tw', at, 'ok', '202610']),
    ]);
    const c = await loadCollection(pool, config(), '202610', at);
    expect(c.queue.map((e) => e.domain)).toEqual(['retry.tw', 'fresh.tw', 'manual-fresh.tw', 'manual-retry.tw']);
    expect(c.entries.map((e) => e.hasManual)).toEqual([false, false, true, true]);
    expect(dueDomains(await loadCandidates(pool, config(), at), at)).toEqual(c.queue.map((e) => e.domain));
  });
  it('automatically saves a target, records first-pass progress and never repeats completed work', async () => {
    await watch('a.tw', 'b.tw');
    const f = fetcher();
    expect(await runOnce(pool, { config: config(), request: f.request, now: () => at, pauseMs: 0 })).toMatchObject({ sent: 1, ok: 1 });
    expect(await runOnce(pool, { config: config(), request: f.request, now: () => at, pauseMs: 0 })).toMatchObject({ sent: 1, ok: 1 });
    expect(await runOnce(pool, { config: config(), request: f.request, now: () => at, pauseMs: 0 })).toMatchObject({ sent: 0 });
    expect(new Set(f.sent).size).toBe(2);
    expect((await loadCollection(pool, config(), '202610', at)).summary.complete).toBe(2);
    expect(await rows(pool, 'SELECT month,attempts FROM collection_domains ORDER BY domain')).toEqual([
      { month: '202610', attempts: 1 },
      { month: '202610', attempts: 1 },
    ]);
  });
  it('reports saved-month provenance separately from the latest sent request, including refusals', async () => {
    await watch('visits.tw', 'mixed.tw', 'empty.tw');
    await save('visits.tw', '202610', 100, null);
    await save('mixed.tw');
    await setManualMonth(pool, 'editor@example.com', 'mixed.tw', '202610', {
      domain: 'mixed.tw',
      month: '202610',
      visits: 100,
      searchShare: null,
      aiShare: null,
      taiwanShare: null,
      channels: {},
      details: parseManualDetails({}),
    });
    const later = new Date(at.getTime() + 3600000);
    await pool.query("UPDATE traffic_profiles SET fetched_at=? WHERE domain='mixed.tw'", [later]);
    await pool.query('INSERT INTO sends (domain, at, outcome, http_status, target_month) VALUES (?,?,?,?,?)', [
      'mixed.tw',
      later,
      'refused',
      429,
      '202610',
    ]);
    await pool.query('INSERT INTO sends (domain, at, outcome, http_status, target_month) VALUES (?,?,?,?,?)', [
      'mixed.tw',
      new Date(later.getTime() + 1000),
      'ok',
      200,
      '202609',
    ]);
    const c = await loadCollection(pool, config(), '202610', later);
    expect(c.entries.find((e) => e.domain === 'visits.tw')).toMatchObject({
      hasAutomatic: true,
      hasManual: false,
      automaticVisitsAt: at.toISOString(),
      automaticProfileAt: null,
      lastRequestAt: null,
    });
    expect(c.entries.find((e) => e.domain === 'mixed.tw')).toMatchObject({
      hasAutomatic: true,
      hasManual: true,
      automaticVisitsAt: at.toISOString(),
      automaticProfileAt: later.toISOString(),
      manualUpdatedAt: expect.any(String),
      lastRequestAt: later.toISOString(),
      lastRequestOutcome: 'refused',
      lastRequestHttpStatus: 429,
    });
    expect(c.entries.find((e) => e.domain === 'empty.tw')).toMatchObject({
      hasAutomatic: false,
      hasManual: false,
      automaticVisitsAt: null,
      automaticProfileAt: null,
      manualUpdatedAt: null,
    });
    const app = buildApp(pool, { config: config(), login: null, logger: false });
    try {
      const manual = await app.inject('/status/collection/?month=202610&state=all&source=manual');
      expect(manual.statusCode).toBe(200);
      expect(manual.body).toContain('/site/mixed.tw/');
      expect(manual.body).toContain('自動＋人工');
      expect(manual.body).toContain('上游拒絕 · HTTP 429');
      expect(manual.body).not.toContain('/site/visits.tw/');
      const automatic = await app.inject('/status/collection/?month=202610&state=all&source=automatic');
      expect(automatic.body).toContain('/site/visits.tw/');
      expect(automatic.body).toContain('/site/mixed.tw/');
      expect(automatic.body).not.toContain('/site/empty.tw/');
      const none = await app.inject('/status/collection/?month=202610&state=all&source=none');
      expect(none.body).toContain('/site/empty.tw/');
      expect(none.body).not.toContain('/site/mixed.tw/');
    } finally {
      await app.close();
    }
  });
  it('keeps old-month missing fields across calendar changes and marks unavailable profiles for manual entry', async () => {
    await watch('old.tw');
    await syncCollections(pool, config(), at);
    await save('old.tw', '202610', 100, null);
    const december = new Date('2026-12-10T10:00:00Z');
    await syncCollections(pool, config(), december);
    await save('old.tw', '202611', 100);
    expect(await collectionMonths(pool, config(), december)).toEqual(['202611', '202610']);
    const old = await loadCollection(pool, config(), '202610', december);
    expect(old.entries[0]).toMatchObject({ complete: false, status: 'manual-needed', automatic: false, fields: { visits: true } });
    expect(old.entries[0].missing).toContain('countries');
    expect((await loadCollection(pool, config(), '202611', december)).entries[0].complete).toBe(true);
  });
  it('keeps old profiles eligible until this domain advances and fills old visits after the current month completes', async () => {
    await watch('old.tw');
    await syncCollections(pool, config(), at);
    await save('old.tw', '202610', 100, null);
    const december = new Date('2026-12-10T10:00:00Z');
    await save('other.tw', '202611');
    expect((await loadCollection(pool, config(), '202610', december)).entries[0].status).toBe('pending');
    await pool.query("DELETE FROM traffic_months WHERE domain='old.tw'");
    await save('old.tw', '202611');
    const sent: string[] = [];
    const request = (async (input: string) => {
      sent.push(new URL(input).searchParams.get('domain')!);
      return new Response(
        JSON.stringify({
          ...response('old.tw'),
          EstimatedMonthlyVisits: { '2026-10-01': 100, '2026-11-01': 200 },
          Engagments: { Year: '2026', Month: '11', BounceRate: 0, PagePerVisit: 2, TimeOnSite: 10 },
        }),
      );
    }) as unknown as typeof fetch;
    expect(await runOnce(pool, { config: config(), request, now: () => december })).toMatchObject({ sent: 1, ok: 1 });
    expect(sent).toEqual(['old.tw']);
    expect(await rows(pool, 'SELECT target_month FROM sends')).toEqual([{ target_month: '202610' }]);
    expect((await loadCollection(pool, config(), '202610', december)).entries[0].status).toBe('manual-needed');
  });
  it('lets authorized editors persist priorities and register historical months for manual completion without requests', async () => {
    await watch('a.tw');
    const origin = 'https://traffic.example';
    const cookie = 'traffic_session=collection-editor';
    await pool.query('INSERT INTO sessions (token_hash,email,created_at,expires_at) VALUES (?,?,NOW(),DATE_ADD(NOW(),INTERVAL 1 DAY))', [
      createHash('sha256').update('collection-editor').digest('hex'),
      'editor@example.com',
    ]);
    const app = buildApp(pool, {
      config: config(),
      login: { clientId: 'id', clientSecret: 'secret', origin, admins: new Set(['editor@example.com']) },
      logger: false,
    });
    const post = (url: string, payload: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url,
        headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(payload).toString(),
      });
    try {
      expect((await post('/status/collection/priority', { domain: 'a.tw', priority: '1' })).statusCode).toBe(303);
      expect((await loadCollection(pool, config(), '202610', at)).entries[0].priority).toBe(1);
      const saved = await post('/status/collection/priority', {
        domain: 'a.tw',
        priority: '2',
        month: '202610',
        state: 'all',
        filterPriority: '2',
        page: '3',
        source: 'none',
        sort: 'request-asc',
      });
      const location = new URL(saved.headers.location!, origin);
      expect(Object.fromEntries(location.searchParams)).toEqual({
        month: '202610',
        state: 'all',
        priority: '2',
        source: 'none',
        sort: 'request-asc',
        page: '3',
        saved: 'a.tw',
      });
      const returned = await app.inject({ url: location.pathname + location.search, headers: { cookie } });
      expect(returned.statusCode).toBe(200);
      expect(returned.body).toContain('已儲存 a.tw 的優先級。');
      expect((await post('/status/collection/month', { month: '202501' })).statusCode).toBe(303);
      const page = await app.inject({ url: '/site/a.tw/manual/?month=202501', headers: { cookie } });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('value="202501" selected');
      expect((await post('/site/a.tw/manual/', { month: '202501', visits: '1K' })).statusCode).toBe(303);
      expect((await loadCollection(pool, config(), '202501', at)).entries[0].fields.visits).toBe(true);
      expect(await rows(pool, 'SELECT * FROM sends')).toEqual([]);
      expect((await post('/status/collection/priority', { domain: 'a.tw', priority: '0' })).statusCode).toBe(303);
      expect(await rows(pool, 'SELECT * FROM collection_priorities')).toEqual([]);
    } finally {
      await app.close();
    }
  });
  it('retries missing data with a durable delay and a monthly attempt budget, but does not penalize refusals', async () => {
    await watch('retry.tw');
    await syncCollections(pool, config(), at);
    await recordCollectionAttempt(pool, '202610', 'retry.tw', at, 'refused');
    expect((await loadCollection(pool, config(), '202610', at)).entries[0].attempts).toBe(0);
    await recordCollectionAttempt(pool, '202610', 'retry.tw', at, 'response');
    expect((await loadCollection(pool, config(), '202610', new Date(at.getTime() + DAY))).entries[0].status).toBe('retry-wait');
    expect((await loadCollection(pool, config(), '202610', new Date(at.getTime() + 3 * DAY))).entries[0].status).toBe('retry');
    await recordCollectionAttempt(pool, '202610', 'retry.tw', at, 'no-data');
    await recordCollectionAttempt(pool, '202610', 'retry.tw', at, 'no-data');
    expect((await loadCollection(pool, config(), '202610', new Date(at.getTime() + 4 * DAY))).entries[0].status).toBe('manual-needed');
  });
  it('does not exhaust a month retry budget while daily probes still return only old months', async () => {
    await watch('late.tw');
    await syncCollections(pool, config(), at);
    for (let i = 0; i < 4; i++) await recordCollectionAttempt(pool, '202610', 'late.tw', at, 'old-month');
    const next = new Date(at.getTime() + DAY);
    let e = (await loadCollection(pool, config(), '202610', next)).entries[0];
    expect(e).toMatchObject({ attempts: 4, budgetAttempts: 0, status: 'retry', automatic: true });
    await recordCollectionAttempt(pool, '202610', 'late.tw', next, 'response');
    e = (await loadCollection(pool, config(), '202610', new Date(next.getTime() + 3 * DAY))).entries[0];
    expect(e).toMatchObject({ attempts: 5, budgetAttempts: 1, status: 'retry' });
  });
  it('reserves every fifth send for retry work even when requests are paced one per run', async () => {
    await watch('fresh.tw', 'retry.tw');
    await syncCollections(pool, config(), at);
    await recordCollectionAttempt(pool, '202610', 'retry.tw', new Date(at.getTime() - 4 * DAY), 'response');
    await pool.query('INSERT INTO sends (domain,at,outcome,target_month) VALUES ?', [
      Array.from({ length: 4 }, () => ['used.tw', at, 'ok', '202610']),
    ]);
    expect((await loadCollection(pool, config(), '202610', at)).queue[0].domain).toBe('retry.tw');
  });
  it('shares rolling-hour and spacing controls across runners, pending sends and manual requests', async () => {
    await save('published.tw');
    const c = { ...config(), hourlyBudget: 2, minIntervalSeconds: 240 };
    const f = fetcher();
    expect(await runOnce(pool, { config: c, only: ['a.tw'], request: f.request, now: () => at })).toMatchObject({ sent: 1 });
    expect(await runOnce(pool, { config: c, only: ['b.tw'], request: f.request, now: () => new Date(at.getTime() + 1000) })).toMatchObject({
      skipped: expect.stringContaining('request spacing'),
    });
    const later = new Date(at.getTime() + 240000);
    await pool.query("INSERT INTO sends(domain,at,outcome) VALUES ('pending.tw',?,'pending')", [later]);
    expect(await fetchPolicy(pool, c, later)).toMatchObject({ reason: 'hourly-limit', hourly: { used: 2, remaining: 0 } });
    expect(await runOnce(pool, { config: c, only: ['b.tw'], request: f.request, now: () => later })).toMatchObject({
      skipped: expect.stringContaining('hourly request limit'),
    });
    expect((await fetchPolicy(pool, c, new Date(at.getTime() + 3_600_000))).hourly.used).toBe(1);
    expect(f.sent).toEqual(['a.tw']);
  });
  it('preserves provider Retry-After evidence and cooldown without charging domain retries', async () => {
    await watch('a.tw');
    await save('published.tw');
    let calls = 0;
    const request = (async () => {
      calls++;
      return new Response('', {
        status: 429,
        headers: { 'retry-after': '7200', 'x-ratelimit-remaining': '0', 'set-cookie': 'sensitive' },
      });
    }) as typeof fetch;
    await runOnce(pool, { config: config(), request, now: () => at });
    const [send] = await rows<{ response_meta: unknown }>(pool, 'SELECT response_meta FROM sends');
    const meta = typeof send.response_meta === 'string' ? JSON.parse(send.response_meta) : send.response_meta;
    expect(meta).toMatchObject({ 'retry-after': '7200', 'x-ratelimit-remaining': '0', retrySource: 'provider' });
    expect(JSON.stringify(meta)).not.toContain('sensitive');
    expect((await fetchPolicy(pool, config(), at)).coolingDownUntil).toBe('2026-11-10T12:00:00.000Z');
    expect(await runOnce(pool, { config: config(), request, now: () => new Date(at.getTime() + 240000) })).toMatchObject({
      skipped: expect.stringContaining('cooling down'),
    });
    expect(calls).toBe(1);
    expect((await fetchPolicy(pool, config(), at)).coolingDownUntil).toBe('2026-11-10T12:00:00.000Z');
    expect((await loadCollection(pool, config(), '202610', at)).entries[0].attempts).toBe(0);
  });
  it('serves public missing-field reports and prevents anonymous or cross-origin priority edits', async () => {
    await watch('a.tw');
    const app = buildApp(pool, { config: config(), login: null, logger: false });
    try {
      const report = await app.inject('/api/v1/collection?month=202610');
      expect(report.statusCode).toBe(200);
      expect(report.json().summary.total).toBe(1);
      expect(report.json().entries[0]).toHaveProperty('availableFields');
      expect(report.json().entries[0]).not.toHaveProperty('score');
      const page = await app.inject('/status/collection/?month=202610');
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('逐站缺漏');
      expect(page.body).not.toContain('儲存優先級');
      expect((await app.inject('/api/v1/collection?month=202613')).statusCode).toBe(400);
      const write = await app.inject({
        method: 'POST',
        url: '/status/collection/priority',
        headers: { origin: 'https://evil.example' },
        payload: { domain: 'a.tw', priority: '1' },
      });
      expect(write.statusCode).toBe(403);
      expect(await rows(pool, 'SELECT * FROM collection_priorities')).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
