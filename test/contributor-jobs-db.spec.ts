import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { completeContributorJob, type JobResult } from '../src/contributor-jobs.ts';
import { recoverContributorRefusals } from '../src/contributor-recovery.ts';
import { contributorTransport } from '../src/contributor-transport.ts';
import { createPool, migrate, type Pool, rows } from '../src/db.ts';
import { previousMonth, runConfig, runOnce } from '../src/scheduler.ts';

const url = process.env.TRAFFIC_TEST_DB_URL;
const token = `cn1:sky-mini:${'x'.repeat(43)}`;
const month = previousMonth(new Date());
const fixture = (domain: string) => ({
  SiteName: domain,
  EstimatedMonthlyVisits: { [`${month.slice(0, 4)}-${month.slice(4)}-01`]: 123456 },
  Engagments: { Year: month.slice(0, 4), Month: month.slice(4), BounceRate: '0.4', PagePerVisit: '2', TimeOnSite: '100' },
  TrafficSources: { Direct: 0.4, SearchOrganic: 0.3, GenAi: 0.01 },
  TopCountryShares: [{ CountryCode: 'TW', Value: 0.9 }],
});

describe.skipIf(!url)('contributor job HTTP pipeline', () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  beforeAll(() => {
    pool = createPool(url, { size: 8, multipleStatements: true });
  });
  afterAll(async () => {
    await pool?.end();
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    const tables = await rows<{ t: string }>(pool, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE()');
    for (const { t } of tables) await pool.query(`DROP TABLE \`${t}\``);
    await migrate(pool);
    vi.stubEnv('TRAFFIC_COMMUNITY_ENABLED', '1');
    vi.stubEnv('TRAFFIC_CONTRIBUTOR_NODES', 'sky-mini');
    vi.stubEnv('TRAFFIC_CONTRIBUTOR_TRUST', 'sky-mini:10');
    vi.stubEnv('TRAFFIC_CONTRIBUTOR_NODE_KEYS', `sky-mini:${createHash('sha256').update(token).digest('hex')}`);
    await pool.query('INSERT INTO watches (requester,domain,kind,requested_at) VALUES ?', [
      [
        ['tag', 'a.tw', 'watch', new Date()],
        ['tag', 'b.tw', 'watch', new Date()],
      ],
    ]);
    app = buildApp(pool, { tokens: new Map(), login: null, logger: false });
  });
  const claim = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/contributors/jobs/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceVersion: 'node-v1' },
    });
  async function answer(status = 200) {
    for (let i = 0; i < 100; i++) {
      const response = await claim();
      const job = response.json().job;
      if (job) {
        const payload: JobResult = {
          sourceVersion: 'node-v1',
          reply: {
            domain: job.domain,
            requestId: job.requestId,
            fetchedAt: new Date().toISOString(),
            status,
            headers: status === 429 ? { 'retry-after': '3600' } : {},
            body: JSON.stringify(status === 200 ? fixture(job.domain) : { exceeded: true }),
          },
        };
        const result = await app.inject({
          method: 'POST',
          url: `/api/v1/contributors/jobs/${job.requestId}/result`,
          headers: { authorization: `Bearer ${token}` },
          payload,
        });
        expect(result.statusCode).toBe(200);
        return { job, payload };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error('no contributor job');
  }
  it('saves a node response only as community data, deduplicates retries and preserves shared spacing', async () => {
    await claim();
    const local = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const transport = contributorTransport(pool, ['sky-mini'], 'controller-v1', local);
    const config = runConfig({
      TRAFFIC_RUN_BUDGET: '1',
      TRAFFIC_WEEKLY_BUDGET: 'auto',
      TRAFFIC_HOURLY_BUDGET: '2',
      TRAFFIC_MIN_INTERVAL_SECONDS: '2000',
    });
    const running = runOnce(pool, { config, ...transport, only: ['a.tw'] });
    const { job, payload } = await answer();
    expect(await running).toMatchObject({ sent: 1, ok: 1 });
    expect(local).not.toHaveBeenCalled();
    expect(await rows(pool, 'SELECT * FROM traffic_months')).toHaveLength(0);
    expect(await rows(pool, 'SELECT source_node,source_version FROM contributor_observations')).toEqual([
      { source_node: 'sky-mini', source_version: 'node-v1' },
    ]);
    expect(await rows(pool, 'SELECT observation_id FROM contributor_canonical')).toMatchObject([{ observation_id: expect.any(Number) }]);
    expect(await completeContributorJob(pool, 'sky-mini', job.requestId, payload)).toBe(true);
    expect(await rows(pool, 'SELECT id FROM contributor_observations')).toHaveLength(1);
    expect(await runOnce(pool, { config, ...transport, only: ['b.tw'] })).toMatchObject({ skipped: expect.stringContaining('spacing') });
    expect(local).not.toHaveBeenCalled();
    const publicResponse = await app.inject(`/api/v1/contributors/a.tw?month=${month}`);
    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.body).toContain('sky-mini');
  });
  it('preserves Retry-After and stops every node and the local worker after refusal', async () => {
    await claim();
    const local = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const transport = contributorTransport(pool, ['sky-mini'], 'v1', local);
    const config = runConfig({ TRAFFIC_RUN_BUDGET: '2', TRAFFIC_WEEKLY_BUDGET: 'auto' });
    const running = runOnce(pool, { config, ...transport, only: ['a.tw', 'b.tw'] });
    await answer(429);
    expect(await running).toMatchObject({ sent: 1, refused: true });
    expect(await runOnce(pool, { config, ...transport, only: ['b.tw'] })).toMatchObject({
      skipped: expect.stringContaining('cooling down'),
    });
    expect(local).not.toHaveBeenCalled();
    expect(await rows(pool, 'SELECT * FROM contributor_observations')).toHaveLength(0);
  });
  it('restores a late refusal after a crashed worker before allowing another send', async () => {
    const at = new Date();
    await pool.query("INSERT INTO sends (id,domain,at,outcome) VALUES (1,'a.tw',?,'error')", [at]);
    await pool.query("INSERT INTO fetch_state (domain,last_attempt_at) VALUES ('a.tw',?)", [at]);
    await pool.query('INSERT INTO contributor_jobs (send_id,source_node,domain,created_at,expires_at,claimed_at) VALUES (1,?,?,?,?,?)', [
      'sky-mini',
      'a.tw',
      at,
      new Date(at.getTime() + 45_000),
      at,
    ]);
    const result = {
      sourceVersion: 'v1',
      reply: {
        domain: 'a.tw',
        requestId: '1',
        fetchedAt: at.toISOString(),
        status: 429,
        headers: { 'retry-after': '3600' },
        body: '{"exceeded":true}',
      },
    };
    expect(await completeContributorJob(pool, 'sky-mini', '1', result)).toBe(true);
    const config = runConfig({ TRAFFIC_RUN_BUDGET: '1', TRAFFIC_WEEKLY_BUDGET: 'auto', TRAFFIC_ADAPTIVE_BACKOFF: '1' });
    await recoverContributorRefusals(pool, config);
    await recoverContributorRefusals(pool, config);
    expect(await rows(pool, 'SELECT refusals FROM similarweb_backoff')).toEqual([{ refusals: 1 }]);
    const request = vi.fn() as unknown as typeof fetch;
    expect(await runOnce(pool, { config, request, only: ['b.tw'] })).toMatchObject({ skipped: expect.stringContaining('cooling down') });
    expect(request).not.toHaveBeenCalled();
  });
  it('requires authentication and ownership; accepted late results survive worker restart', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/contributors/jobs/claim', payload: { sourceVersion: 'v1' } })).statusCode,
    ).toBe(401);
    const at = new Date();
    await pool.query('INSERT INTO contributor_jobs (send_id,source_node,domain,created_at,expires_at,claimed_at) VALUES (1,?,?,?,?,?)', [
      'sky-mini',
      'a.tw',
      at,
      new Date(at.getTime() + 45_000),
      at,
    ]);
    const result = {
      sourceVersion: 'v1',
      reply: {
        domain: 'a.tw',
        requestId: '1',
        fetchedAt: at.toISOString(),
        status: 200,
        headers: {},
        body: JSON.stringify(fixture('a.tw')),
      },
    };
    expect(await completeContributorJob(pool, 'other-node', '1', result)).toBe(false);
    expect(await completeContributorJob(pool, 'sky-mini', '1', result, new Date(at.getTime() + 120_000))).toBe(true);
    expect(await rows(pool, 'SELECT source_node FROM contributor_observations')).toEqual([{ source_node: 'sky-mini' }]);
    const changed = { ...result, reply: { ...result.reply, body: JSON.stringify({ ...fixture('a.tw'), EstimatedMonthlyVisits: {} }) } };
    expect(await completeContributorJob(pool, 'sky-mini', '1', changed)).toBe(true);
    expect(await rows(pool, 'SELECT id FROM contributor_observations')).toHaveLength(1);
  });
});
