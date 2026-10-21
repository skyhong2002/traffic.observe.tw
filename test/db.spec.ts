import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createPool, migrate, type Pool, rows } from '../src/db.ts';
import { runConfig, runOnce } from '../src/scheduler.ts';

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
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at, refresh_days) VALUES ?', [
      [
        ['sheet', 's.com.tw', 'watch', now, 30],
        ['tag', 'a.com.tw', 'watch', now, 7],
        ['tag', 'b.com.tw', 'watch', now, 7],
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
    // Fetched domains are fresh now; only the sheet one is left.
    const second = fakeFetch();
    await run(pool, second.request, 5);
    expect(second.sent).toEqual(['s.com.tw']);
  });

  it('stops at a refusal and sends nothing during the cooldown', async () => {
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at, refresh_days) VALUES ?', [
      [
        ['tag', 'a.com.tw', 'watch', new Date(), 7],
        ['tag', 'b.com.tw', 'watch', new Date(), 7],
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
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at, refresh_days) VALUES (?, ?, ?, ?, ?)', [
      'tag',
      'a.com.tw',
      'watch',
      new Date(),
      7,
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

  it('serves pages and the public API', async () => {
    const server = app();
    const { request } = fakeFetch();
    await pool.query('INSERT INTO watches (requester, domain, kind, requested_at, refresh_days) VALUES (?, ?, ?, ?, ?)', [
      'tag',
      'a.com.tw',
      'watch',
      new Date(),
      7,
    ]);
    await run(pool, request);
    const ranking = (await server.inject('/api/v1/rankings?month=202609')).json();
    expect(ranking.sites[0]).toMatchObject({ domain: 'a.com.tw', visits: 1.2, rank: 1, searchVisits: 1.2 * 0.3 });
    for (const path of ['/', '/topics/', '/site/a.com.tw/', '/status/']) expect((await server.inject(path)).statusCode).toBe(200);
    expect((await server.inject('/api/v1/rankings.csv?month=202609')).body).toContain('a.com.tw');
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

    // Not on the list: no session.
    email = 'someone@gmail.com';
    expect(await signIn()).toEqual({ location: '/login/?error=not_editor', cookie: undefined });
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
      refreshDays: '30',
      note: '吉進要的',
    });
    expect(added.headers.location).toBe('/watch/?added=2&refused=3');
    expect(await rows(pool, "SELECT domain, refresh_days, added_by, note FROM watches WHERE requester = 'manual' ORDER BY domain")).toEqual(
      [
        { domain: 'x.com.tw', refresh_days: 30, added_by: 'sky9109@gmail.com', note: '吉進要的' },
        { domain: 'y.com.tw', refresh_days: 30, added_by: 'sky9109@gmail.com', note: '吉進要的' },
      ],
    );
    // Hand-added domains go first.
    await pool.query(
      "INSERT INTO watches (requester, domain, kind, requested_at, refresh_days) VALUES ('tag', 'a.com.tw', 'watch', NOW(), 7)",
    );
    const { request, sent } = fakeFetch();
    await run(pool, request, 2);
    expect(sent.sort()).toEqual(['x.com.tw', 'y.com.tw']);
    expect((await server.inject({ url: '/watch/', headers: { cookie } })).body).toContain('1.200');

    expect((await form(cookie, '/watch/remove', { domain: 'x.com.tw' })).headers.location).toBe('/watch/?removed=x.com.tw');
    expect(await rows(pool, "SELECT domain FROM watches WHERE requester = 'manual'")).toEqual([{ domain: 'y.com.tw' }]);
    expect((await rows<{ action: string }>(pool, 'SELECT action FROM watch_log ORDER BY id')).map((r) => r.action)).toEqual([
      'add:manual',
      'add:manual',
      'del:manual',
    ]);

    // Removed from TRAFFIC_ADMIN_EMAILS: the session stops working at once.
    login.admins.delete('sky9109@gmail.com');
    expect((await form(cookie, '/watch/', { domains: 'z.com.tw' })).headers.location).toBe('/auth/google?next=/watch/');

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
});
