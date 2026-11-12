import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, migrate, type Pool, rows } from '../src/db.ts';
import { type EgressRoute, egressExperimentStatus, experimentalRequest } from '../src/egress-experiment.ts';
import { fetchPolicy } from '../src/fetch-policy.ts';
import { backoffDelay, backoffState, reserveRecovery } from '../src/provider-backoff.ts';
import { recentRequestDiagnostics } from '../src/request-diagnostics.ts';
import { runConfig, runOnce } from '../src/scheduler.ts';
import { nextPacedRun } from '../src/worker-timing.ts';

const url = process.env.TRAFFIC_TEST_DB_URL;
const start = new Date('2026-11-10T08:00:00Z');
const HOUR = 3_600_000;
const config = () =>
  runConfig({
    TRAFFIC_RUN_BUDGET: '15',
    TRAFFIC_WEEKLY_BUDGET: 'auto',
    TRAFFIC_ADAPTIVE_BACKOFF: '1',
    TRAFFIC_MIN_INTERVAL_SECONDS: '240',
  });
const answer = (domain: string) => ({
  SiteName: domain,
  EstimatedMonthlyVisits: { '2026-10-01': 100 },
  Engagments: { Year: '2026', Month: '10' },
});

describe('adaptive quota backoff', () => {
  it('increases waits, caps the base delay, and only adds positive jitter', () => {
    const c = config();
    expect([1, 2, 3, 4, 5, 99].map((n) => backoffDelay(c, n, () => 0) / HOUR)).toEqual([2, 4, 8, 16, 24, 24]);
    expect(backoffDelay(c, 1, () => 1)).toBeCloseTo(2.2 * HOUR, 0);
  });
});

describe.skipIf(!url)('adaptive quota recovery with a database', () => {
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
    await pool.query(
      "INSERT INTO traffic_profiles(domain,month,profile,first_seen_at,fetched_at) VALUES ('published.tw','202610','{}',?,?)",
      [start, start],
    );
  });
  const fetcher = (status = 200, headers?: Record<string, string>) => {
    const sent: string[] = [];
    const request = (async (input: string) => {
      const domain = new URL(input).searchParams.get('domain')!;
      sent.push(domain);
      return new Response(status === 200 ? JSON.stringify(answer(domain)) : '', { status, headers });
    }) as unknown as typeof fetch;
    return { sent, request };
  };
  const send = (domain: string, at: Date, f: ReturnType<typeof fetcher>) =>
    runOnce(pool, { config: config(), only: [domain], request: f.request, now: () => at, pauseMs: 0 });
  const due = async () => (await backoffState(pool, config()))!.next_attempt_at!;
  it('persists 2-hour then 4-hour waits and never sends during either cooldown', async () => {
    const refused = fetcher(429);
    expect(await send('a.tw', start, refused)).toMatchObject({ sent: 1, refused: true });
    const first = await due();
    expect(first.getTime() - start.getTime()).toBeGreaterThanOrEqual(2 * HOUR);
    expect(first.getTime() - start.getTime()).toBeLessThanOrEqual(2.2 * HOUR);
    const freshPool = createPool(url);
    try {
      expect((await fetchPolicy(freshPool, config(), start)).recovery).toMatchObject({
        phase: 'open',
        source: 'local-backoff',
        refusals: 1,
      });
    } finally {
      await freshPool.end();
    }
    expect(await send('b.tw', new Date(first.getTime() - 1000), refused)).toHaveProperty('skipped');
    expect(refused.sent).toHaveLength(1);
    expect(await send('b.tw', first, refused)).toMatchObject({ sent: 1, refused: true });
    const second = await due();
    expect(second.getTime() - first.getTime()).toBeGreaterThanOrEqual(4 * HOUR);
    expect(second.getTime() - first.getTime()).toBeLessThanOrEqual(4.4 * HOUR);
    expect((await backoffState(pool, config()))?.refusals).toBe(2);
  });
  it('honors a seven-day provider Retry-After even with the shorter local policy', async () => {
    await send('a.tw', start, fetcher(429, { 'retry-after': '604800' }));
    expect((await due()).toISOString()).toBe('2026-11-17T08:00:00.000Z');
    expect((await fetchPolicy(pool, config(), start)).recovery).toMatchObject({
      source: 'provider',
      providerRetryAt: '2026-11-17T08:00:00.000Z',
    });
    const f = fetcher();
    expect(await send('b.tw', new Date(start.getTime() + 24 * HOUR), f)).toHaveProperty('skipped');
    expect(f.sent).toEqual([]);
  });
  it('uses one real work item at a time, then requires three spaced successes before normal throughput', async () => {
    await send('initial.tw', start, fetcher(429));
    const f = fetcher();
    let at = await due();
    expect(
      await runOnce(pool, { config: config(), only: ['a.tw', 'b.tw', 'c.tw'], request: f.request, now: () => at, pauseMs: 0 }),
    ).toMatchObject({ sent: 1, ok: 1 });
    expect((await fetchPolicy(pool, config(), at)).recovery).toMatchObject({ phase: 'recovering', successes: 1 });
    expect(await send('b.tw', new Date(at.getTime() + 60_000), f)).toHaveProperty('skipped');
    expect(f.sent).toEqual(['a.tw']);
    at = await due();
    expect(await send('b.tw', at, f)).toMatchObject({ sent: 1, ok: 1 });
    at = await due();
    expect(await send('c.tw', at, f)).toMatchObject({ sent: 1, ok: 1 });
    expect(await backoffState(pool, config())).toMatchObject({ phase: 'closed', refusals: 0, successes: 3 });
    expect((await fetchPolicy(pool, config(), new Date(at.getTime() + 240_000))).recovery).toBeNull();
    expect((await rows<{ domain: string }>(pool, 'SELECT domain FROM sends WHERE recovery_probe=1')).map((r) => r.domain)).toEqual([
      'a.tw',
      'b.tw',
      'c.tw',
    ]);
  });
  it('does not reset the backoff streak after only one successful recovery request', async () => {
    await send('initial.tw', start, fetcher(429));
    await send('a.tw', await due(), fetcher());
    const at = await due();
    await send('b.tw', at, fetcher(429));
    expect(await backoffState(pool, config())).toMatchObject({ phase: 'open', refusals: 2, successes: 0 });
    expect((await due()).getTime() - at.getTime()).toBeGreaterThanOrEqual(4 * HOUR);
  });
  it('counts pending recovery reservations against the shared rolling-day probe budget', async () => {
    await send('initial.tw', start, fetcher(429));
    const at = await due();
    await pool.query('INSERT INTO sends(domain,at,outcome,recovery_probe) VALUES ?', [
      [
        ['a.tw', at, 'pending', 1],
        ['b.tw', at, 'error', 1],
        ['c.tw', at, 'refused', 1],
      ],
    ]);
    const f = fetcher();
    const later = new Date(at.getTime() + HOUR);
    const p = await fetchPolicy(pool, config(), later);
    expect(p).toMatchObject({ reason: 'recovery-probe-limit', maxPerRun: 0, recovery: { used: 3, remaining: 0 } });
    expect(await send('d.tw', later, f)).toHaveProperty('skipped');
    expect(f.sent).toEqual([]);
    expect(nextPacedRun(config(), p, later)!.getTime()).toBeGreaterThanOrEqual(at.getTime() + 24 * HOUR);
  });
  it('does not treat malformed JSON data as recovery success', async () => {
    await send('initial.tw', start, fetcher(429));
    const at = await due();
    const request = (async () => new Response('{}')) as typeof fetch;
    await runOnce(pool, { config: config(), only: ['bad.tw'], request, now: () => at });
    expect(await backoffState(pool, config())).toMatchObject({ phase: 'open', successes: 0 });
    expect((await due()).getTime() - at.getTime()).toBeGreaterThanOrEqual(2 * HOUR);
  });
  it('retains an in-flight recovery hold after the process exits before recording a response', async () => {
    await send('initial.tw', start, fetcher(429));
    const at = await due();
    await pool.query("INSERT INTO sends(domain,at,outcome,recovery_probe) VALUES ('interrupted.tw',?,'pending',1)", [at]);
    await reserveRecovery(pool, config(), at);
    const restarted = createPool(url);
    try {
      expect(await fetchPolicy(restarted, config(), new Date(at.getTime() + 60_000))).toMatchObject({
        reason: 'provider-cooldown',
        maxPerRun: 0,
        recovery: { phase: 'half-open', used: 1, successes: 0 },
      });
    } finally {
      await restarted.end();
    }
    expect((await due()).getTime() - at.getTime()).toBe(2 * HOUR);
    const f = fetcher();
    expect(await send('next.tw', new Date(at.getTime() + HOUR), f)).toHaveProperty('skipped');
    expect(f.sent).toEqual([]);
  });
  it('limits the exit comparison to three reserved recovery requests and records actual returned months', async () => {
    await send('initial.tw', start, fetcher(429));
    const routes: EgressRoute[] = [];
    const ordinary = fetcher();
    const request = experimentalRequest(
      pool,
      'vessel-test',
      async (route, input) => {
        routes.push(route);
        return new Response(JSON.stringify(answer(new URL(input).searchParams.get('domain')!)));
      },
      ordinary.request,
    );
    let at = await due();
    for (const domain of ['a.tw', 'b.tw', 'c.tw']) {
      at = await due();
      expect(await runOnce(pool, { config: config(), only: [domain], request, now: () => at })).toMatchObject({ sent: 1, ok: 1 });
    }
    expect(routes).toEqual(['direct', 'vessel-tokyo', 'vessel-singapore']);
    expect(await egressExperimentStatus(pool, 'vessel-test')).toMatchObject({
      remaining: 0,
      nextRoute: null,
      trials: [
        { domain: 'a.tw', egressRoute: 'direct', latestMonth: '202610', outcome: 'ok' },
        { domain: 'b.tw', egressRoute: 'vessel-tokyo', latestMonth: '202610', outcome: 'ok' },
        { domain: 'c.tw', egressRoute: 'vessel-singapore', latestMonth: '202610', outcome: 'ok' },
      ],
    });
    at = new Date(at.getTime() + 240_000);
    expect(await runOnce(pool, { config: config(), only: ['d.tw'], request, now: () => at })).toMatchObject({ sent: 1, ok: 1 });
    expect(routes).toHaveLength(3);
    expect(ordinary.sent).toEqual(['d.tw']);
  });
  it('shares provider cooldown across all exits and preserves refusal evidence with the route reservation', async () => {
    await send('initial.tw', start, fetcher(429));
    const routes: EgressRoute[] = [];
    const request = experimentalRequest(pool, 'vessel-refused', async (route) => {
      routes.push(route);
      return new Response('', { status: 429, headers: { 'retry-after': '604800' } });
    });
    const at = await due();
    await runOnce(pool, { config: config(), only: ['a.tw'], request, now: () => at });
    expect(await egressExperimentStatus(pool, 'vessel-refused')).toMatchObject({
      remaining: 2,
      trials: [{ egressRoute: 'direct', outcome: 'refused', httpStatus: 429, retrySource: 'provider', 'retry-after': '604800' }],
    });
    expect(
      await runOnce(pool, { config: config(), only: ['b.tw'], request, now: () => new Date(at.getTime() + 24 * HOUR) }),
    ).toHaveProperty('skipped');
    expect(routes).toEqual(['direct']);
  });
  it('preserves experiment, transport and safe 403 diagnostics together without upstream secrets', async () => {
    await send('initial.tw', start, fetcher(429));
    const request = experimentalRequest(
      pool,
      'diagnostics-test',
      async () =>
        new Response('secret upstream denial', {
          status: 403,
          headers: {
            server: 'CloudFront',
            'x-cache': 'Error from cloudfront',
            'x-amz-cf-pop': 'SIN1-P1',
            'x-amz-cf-id': 'secret-request-id',
            'set-cookie': 'secret-cookie',
            'retry-after': '7200',
          },
        }),
    );
    const at = await due();
    expect(await runOnce(pool, { config: config(), only: ['a.tw'], request, now: () => at })).toMatchObject({ sent: 1, refused: true });
    const [diagnostic] = await recentRequestDiagnostics(pool);
    expect(diagnostic).toMatchObject({
      httpStatus: 403,
      outcome: 'refused',
      egressRoute: 'direct',
      httpClient: 'curl',
      experiment: 'diagnostics-test',
      diagnosticsRecorded: true,
      provider: 'CloudFront',
      cache: 'Error from cloudfront',
      pop: 'SIN1-P1',
      retryAfter: '7200',
      retrySource: 'provider',
    });
    const [saved] = await rows<{ response_meta: unknown }>(pool, 'SELECT response_meta FROM sends ORDER BY id DESC LIMIT 1');
    expect(JSON.stringify(saved)).not.toContain('secret');
    expect(await due()).toEqual(new Date(at.getTime() + 2 * HOUR));
    const f = fetcher();
    expect(await send('b.tw', new Date(at.getTime() + HOUR), f)).toHaveProperty('skipped');
    expect(f.sent).toEqual([]);
  });
  it('records ordinary success with actual months and keeps invalid JSON out of persisted errors', async () => {
    expect(await send('good.tw', start, fetcher())).toMatchObject({ sent: 1, ok: 1 });
    expect((await recentRequestDiagnostics(pool))[0]).toMatchObject({
      httpStatus: 200,
      outcome: 'ok',
      httpClient: 'node-fetch',
      egressRoute: 'direct',
      diagnosticsRecorded: true,
      latestMonth: '202610',
      latestProfileMonth: '202610',
      provider: null,
    });
    const at = new Date(start.getTime() + 240_000);
    const request = (async () => new Response('private-body-not-json', { headers: { server: 'CloudFront' } })) as typeof fetch;
    expect(await runOnce(pool, { config: config(), only: ['bad.tw'], request, now: () => at })).toMatchObject({ sent: 1, failed: 1 });
    const [diagnostic] = await recentRequestDiagnostics(pool);
    expect(diagnostic).toMatchObject({ outcome: 'error', httpStatus: 200, provider: 'CloudFront', diagnosticsRecorded: true });
    const [state] = await rows<{ last_error: string }>(pool, 'SELECT last_error FROM fetch_state WHERE domain=?', ['bad.tw']);
    expect(state.last_error).toBe('Similarweb returned invalid JSON');
    expect(JSON.stringify(diagnostic)).not.toContain('private-body');
    await pool.query("INSERT INTO sends(domain,at,outcome,http_status) VALUES ('legacy.tw',?,'refused',403)", [new Date(at.getTime() + 1)]);
    expect((await recentRequestDiagnostics(pool))[0]).toMatchObject({
      diagnosticsRecorded: false,
      egressRoute: null,
      httpClient: null,
      provider: null,
    });
  });
});
