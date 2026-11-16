import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadCollection } from '../src/collection.ts';
import {
  accessToken,
  bigQueryClient,
  cruxConfig,
  cruxHost,
  cruxLabel,
  cruxStatus,
  downloadMonth,
  latestCruxRanks,
  loadCrux,
  matchDomains,
  publishedMonths,
  runCrux,
  untrackedPopular,
} from '../src/crux.ts';
import { createPool, migrate, type Pool, rows } from '../src/db.ts';
import { runConfig } from '../src/scheduler.ts';

// A fake BigQuery: table listing plus one query per month, answered in pages.
function fakeBigQuery(months: Record<string, Array<[string, number]>>, pageSize = 2) {
  const calls: string[] = [];
  const jobs = new Map<string, Array<[string, number]>>();
  const page = (jobId: string, offset: number) => {
    const all = jobs.get(jobId) ?? [];
    const rowsOut = all.slice(offset, offset + pageSize).map(([o, r]) => ({ f: [{ v: o }, { v: String(r) }] }));
    return {
      jobComplete: true,
      jobReference: { jobId, location: 'US' },
      rows: rowsOut,
      totalBytesProcessed: '1000',
      ...(offset + pageSize < all.length ? { pageToken: String(offset + pageSize) } : {}),
    };
  };
  // biome-ignore lint/suspicious/noExplicitAny: test double
  const client = (async (path: string, init: any = {}) => {
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path.endsWith('/tables')) return { tables: Object.keys(months).map((tableId) => ({ tableReference: { tableId } })) };
    if (init.method === 'POST') {
      const month = /country_tw\.(\d{6})/.exec(init.body.query)?.[1] as string;
      const jobId = `job-${month}`;
      jobs.set(jobId, months[month]);
      return page(jobId, 0);
    }
    const jobId = path.split('/').at(-1) as string;
    return page(jobId, Number(init.query?.pageToken ?? 0));
  }) as never;
  return { client, calls };
}

describe('CrUX helpers', () => {
  it('reads hosts from origins and rejects anything else', () => {
    expect(cruxHost('https://www.Example.com')).toBe('www.example.com');
    expect(cruxHost('http://blog.example.com:8080')).toBe('blog.example.com');
    expect(cruxHost('ftp://example.com')).toBeNull();
    expect(cruxHost('not a url')).toBeNull();
  });

  it('labels buckets in 千 and 萬', () => {
    expect([1000, 5000, 10000, 50000, 100000, 1000000].map(cruxLabel)).toEqual([
      '前 1 千名',
      '前 5 千名',
      '前 1 萬名',
      '前 5 萬名',
      '前 10 萬名',
      '前 100 萬名',
    ]);
  });

  it('gives a domain the best rank among its hosts and subdomains, exact host first on a tie', () => {
    const ranks = new Map([
      ['www.pixnet.net', 10000],
      ['someone.pixnet.net', 1000],
      ['pixnet.net.evil.com', 1000],
      ['tw.news.yahoo.com', 1000],
      ['www.udn.com', 5000],
      ['money.udn.com', 5000],
      ['notpixnet.net', 1000],
    ]);
    const best = matchDomains(ranks, ['pixnet.net', 'udn.com', 'yahoo.com', 'tw.news.yahoo.com', 'absent.tw']);
    expect(best.get('pixnet.net')).toEqual({ rank: 1000, host: 'someone.pixnet.net' });
    expect(best.get('udn.com')).toEqual({ rank: 5000, host: 'www.udn.com' });
    expect(best.get('yahoo.com')).toEqual({ rank: 1000, host: 'tw.news.yahoo.com' });
    expect(best.get('tw.news.yahoo.com')).toEqual({ rank: 1000, host: 'tw.news.yahoo.com' });
    expect(best.has('absent.tw')).toBe(false);
  });

  it('lists published months and pages through a month', async () => {
    const { client } = fakeBigQuery({
      '202012': [],
      '202610': [
        ['https://a.tw', 1000],
        ['http://a.tw', 5000],
        ['https://b.tw', 5000],
        ['bad', 1000],
        ['https://c.tw', 10000],
      ],
      latest: [],
    });
    expect(await publishedMonths(client, 'tw')).toEqual(['202610']);
    const { ranks, bytes } = await downloadMonth(client, 'p', 'tw', '202610');
    expect([...ranks]).toEqual([
      ['a.tw', 1000],
      ['b.tw', 5000],
      ['c.tw', 10000],
    ]);
    expect(bytes).toBe(1000);
    await expect(downloadMonth(client, 'p', 'tw', '2026; DROP')).rejects.toThrow('Invalid CrUX month');
  });

  it('signs a service account JWT and never keeps BigQuery error bodies', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let assertion = '';
    const request = (async (_url: string, init: RequestInit) => {
      assertion = new URLSearchParams(String(init.body)).get('assertion') as string;
      return new Response(JSON.stringify({ access_token: 'tok' }));
    }) as unknown as typeof fetch;
    const key = {
      client_email: 'crux@p.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    };
    expect(await accessToken(key, request, new Date('2026-11-13T00:00:00Z'))).toBe('tok');
    const [header, claims, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      iss: key.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1794528000,
    });
    expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);

    const failing = (async () => new Response('secret details', { status: 403 })) as unknown as typeof fetch;
    await expect(bigQueryClient('tok', failing)('/x')).rejects.toThrow(/^BigQuery HTTP 403$/);
  });

  it('only runs with credentials and a valid country', () => {
    expect(cruxConfig({}).credentials).toBeNull();
    expect(cruxConfig({ CRUX_HOUR: '30' }).hour).toBe(4);
    expect(() => cruxConfig({ CRUX_COUNTRY: 'tw;' })).toThrow();
  });
});

const url = process.env.TRAFFIC_TEST_DB_URL;

describe.skipIf(!url)('CrUX with a database', () => {
  let pool: Pool;
  const config = { ...cruxConfig({}), project: 'test-project', credentials: null };
  const watch = (domains: string[]) =>
    pool.query('INSERT IGNORE INTO watches (requester, domain, kind, requested_at) VALUES ?', [
      domains.map((d) => ['sheet', d, 'watch', new Date('2026-10-01T00:00:00Z')]),
    ]);
  beforeAll(() => {
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

  const months = {
    '202609': [
      ['https://www.pixnet.net', 10000],
      ['https://a.pixnet.net', 5000],
      ['https://ptt.cc', 1000],
      ['https://popular.example', 1000],
    ] as Array<[string, number]>,
    '202610': [
      ['https://www.pixnet.net', 5000],
      ['https://ptt.cc', 1000],
      ['https://new.tw', 50000],
      ['https://popular.example', 1000],
      ['https://cdn.ptt.cc', 1000],
    ] as Array<[string, number]>,
  };

  it('downloads every month once, newest first, and matches watched domains', async () => {
    await watch(['pixnet.net', 'ptt.cc', 'absent.tw']);
    const fake = fakeBigQuery(months);
    const first = await runCrux(pool, { config, client: fake.client });
    expect(first).toMatchObject({ fetched: ['202610', '202609'], published: 2, stored: 2, newDomains: 3, note: null });
    expect(fake.calls.filter((c) => c.startsWith('POST'))).toHaveLength(2);

    const crux = await loadCrux(pool, undefined, 'tw');
    expect(crux.get('pixnet.net')).toEqual([
      { month: '202609', rank: 5000, host: 'a.pixnet.net' },
      { month: '202610', rank: 5000, host: 'www.pixnet.net' },
    ]);
    expect(crux.get('ptt.cc')?.map((r) => r.host)).toEqual(['ptt.cc', 'ptt.cc']);
    expect(crux.has('absent.tw')).toBe(false);

    // Nothing new: only the table listing is read again.
    const again = fakeBigQuery(months);
    expect(await runCrux(pool, { config, client: again.client })).toMatchObject({ fetched: [], newDomains: 0 });
    expect(again.calls).toEqual(['GET /projects/chrome-ux-report/datasets/country_tw/tables']);

    // A newly watched domain is matched against the stored months without querying them again.
    await watch(['new.tw']);
    const later = fakeBigQuery(months);
    expect(await runCrux(pool, { config, client: later.client })).toMatchObject({ fetched: [], newDomains: 1 });
    expect(later.calls).toHaveLength(1);
    expect((await loadCrux(pool, ['new.tw'], 'tw')).get('new.tw')).toEqual([{ month: '202610', rank: 50000, host: 'new.tw' }]);

    expect(await latestCruxRanks(pool, 'tw')).toEqual(
      new Map([
        ['pixnet.net', 5000],
        ['ptt.cc', 1000],
        ['new.tw', 50000],
      ]),
    );
    expect(await untrackedPopular(pool, 5000, 'tw')).toEqual({ month: '202610', hosts: [{ host: 'popular.example', rank: 1000 }] });
    expect(await cruxStatus(pool, 'tw')).toMatchObject({ months: 2, firstMonth: '202609', latestMonth: '202610', latestMonthDomains: 3 });
  });

  it('stops at the deadline and fetches the remaining months next run', async () => {
    await watch(['ptt.cc']);
    const fake = fakeBigQuery(months);
    let calls = 0;
    const result = await runCrux(pool, { config, client: fake.client, stopping: () => calls++ > 0 });
    expect(result).toMatchObject({ fetched: ['202610'], note: expect.stringMatching(/remaining months/) });
    expect(await runCrux(pool, { config, client: fakeBigQuery(months).client })).toMatchObject({ fetched: ['202609'] });
  });

  it('records a failed run without storing a partial month', async () => {
    await watch(['ptt.cc']);
    const client = (async (path: string) => {
      if (path.endsWith('/tables')) return { tables: [{ tableReference: { tableId: '202610' } }] };
      throw new Error('BigQuery HTTP 500');
    }) as never;
    expect(await runCrux(pool, { config, client })).toMatchObject({ note: 'BigQuery HTTP 500' });
    expect(await rows(pool, 'SELECT * FROM crux_months')).toEqual([]);
    expect((await rows<{ note: string }>(pool, 'SELECT note FROM crux_runs'))[0].note).toBe('BigQuery HTTP 500');
  });

  it('skips without credentials', async () => {
    expect(await runCrux(pool, { config: cruxConfig({}) })).toEqual({ skipped: 'no CRUX_CREDENTIALS' });
  });

  it('lets Chrome popularity order domains Similarweb has no numbers for', async () => {
    await watch(['zzz.com', 'ptt.cc', 'pixnet.net', 'aaa.com']);
    await runCrux(pool, { config, client: fakeBigQuery(months).client });
    const collection = await loadCollection(
      pool,
      runConfig({ TRAFFIC_COLLECTION_ENABLED: '1' }),
      '202610',
      new Date('2026-11-13T00:00:00Z'),
    );
    expect(collection.entries.map((e) => [e.domain, e.cruxRank])).toEqual([
      ['ptt.cc', 1000],
      ['pixnet.net', 5000],
      ['aaa.com', null],
      ['zzz.com', null],
    ]);
  });
});
