import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chunk, type Pool, rows } from './db.ts';

// Chrome UX Report popularity rank magnitude for Taiwan, from BigQuery's public
// chrome-ux-report.country_tw.<YYYYMM> tables (a free sandbox project is enough; one month is
// about 12 MB of the 1 TB monthly free query allowance). One query returns every origin Chrome
// users in Taiwan visited enough, so a month is downloaded once, whole, and every watched domain
// is matched locally. Ranks are buckets ("top 1,000", "top 5,000", …), counted per origin from
// Chrome users who opted into usage statistics; they are not visits and not exact places.
//
// Google publishes a month around the second Tuesday of the next one. The daily run lists the
// dataset's tables (metadata only, no query cost), downloads months not stored yet, newest
// first, and back-fills every month since CrUX added ranks (202102).

export const CRUX_FIRST_MONTH = '202102';
const BIGQUERY = 'https://bigquery.googleapis.com/bigquery/v2';
const SCOPE = 'https://www.googleapis.com/auth/bigquery';
const PAGE_ROWS = 50_000;

export interface CruxConfig {
  /** Service account key file (JSON) with BigQuery Job User on `project`. */
  credentials: string | null;
  /** Project the queries run (and are billed, within the free tier) in; defaults to the key's. */
  project: string | null;
  country: string;
  /** Taipei hour of the daily check. */
  hour: number;
}

export function cruxConfig(env: Record<string, string | undefined> = process.env): CruxConfig {
  const country = (env.CRUX_COUNTRY || 'tw').toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) throw Error('Invalid CRUX_COUNTRY');
  const hour = Number(env.CRUX_HOUR ?? 4);
  return {
    credentials: env.CRUX_CREDENTIALS?.trim() || null,
    project: env.CRUX_BIGQUERY_PROJECT?.trim() || null,
    country,
    hour: Number.isSafeInteger(hour) && hour >= 0 && hour < 24 ? hour : 4,
  };
}

export const validCruxMonth = (month: string) => /^\d{6}$/.test(month) && +month.slice(4) >= 1 && +month.slice(4) <= 12;

export class CruxError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

export async function readServiceAccount(path: string): Promise<ServiceAccount> {
  const key = JSON.parse(await readFile(path, 'utf8'));
  if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') throw Error('Invalid service account key');
  return key;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** OAuth 2.0 JWT bearer grant for a service account; no client library needed. */
export async function accessToken(key: ServiceAccount, request: typeof fetch = fetch, now = new Date()) {
  const aud = key.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(now.getTime() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud, iat, exp: iat + 3600 }),
  )}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  const response = await request(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new CruxError(response.status, `Google OAuth HTTP ${response.status}`);
  const data = (await response.json()) as { access_token?: unknown };
  if (typeof data.access_token !== 'string') throw Error('Invalid Google OAuth response');
  return data.access_token;
}

type Client = <T>(path: string, init?: { method?: string; body?: unknown; query?: Record<string, string> }) => Promise<T>;

export function bigQueryClient(token: string, request: typeof fetch = fetch): Client {
  return async (path, { method = 'GET', body, query } = {}) => {
    const url = new URL(`${BIGQUERY}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const response = await request(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    // Never keep response bodies: errors only carry the status.
    if (!response.ok) throw new CruxError(response.status, `BigQuery HTTP ${response.status}`);
    return response.json() as never;
  };
}

/** Months published for the country, oldest first (dataset metadata; no query cost). */
export async function publishedMonths(client: Client, country: string) {
  const months: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client<{ tables?: Array<{ tableReference?: { tableId?: string } }>; nextPageToken?: string }>(
      `/projects/chrome-ux-report/datasets/country_${country}/tables`,
      { query: { maxResults: '1000', ...(pageToken ? { pageToken } : {}) } },
    );
    for (const t of page.tables ?? []) {
      const id = t.tableReference?.tableId ?? '';
      if (validCruxMonth(id) && id >= CRUX_FIRST_MONTH) months.push(id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return months.sort();
}

/** Host of a CrUX origin ("https://www.example.com" → "www.example.com"); null if malformed. */
export function cruxHost(origin: string) {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    return ['https:', 'http:'].includes(url.protocol) && host.length <= 253 && /^[a-z0-9.-]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

interface QueryPage {
  jobComplete?: boolean;
  jobReference?: { jobId: string; location?: string };
  rows?: Array<{ f: Array<{ v: string | null }> }>;
  pageToken?: string;
  totalBytesProcessed?: string;
}

/** Every origin of one month, best (lowest) rank per host. */
export async function downloadMonth(client: Client, project: string, country: string, month: string) {
  if (!validCruxMonth(month)) throw Error('Invalid CrUX month');
  const sql = `SELECT origin, MIN(experimental.popularity.rank) AS rank FROM \`chrome-ux-report.country_${country}.${month}\`
    WHERE experimental.popularity.rank IS NOT NULL GROUP BY origin`;
  let page = await client<QueryPage>(`/projects/${encodeURIComponent(project)}/queries`, {
    method: 'POST',
    body: { query: sql, useLegacySql: false, maxResults: PAGE_ROWS, timeoutMs: 60_000 },
  });
  const job = page.jobReference;
  if (!job) throw Error('Invalid BigQuery response');
  const next = (pageToken?: string) =>
    client<QueryPage>(`/projects/${encodeURIComponent(project)}/queries/${encodeURIComponent(job.jobId)}`, {
      query: {
        maxResults: String(PAGE_ROWS),
        timeoutMs: '60000',
        ...(job.location ? { location: job.location } : {}),
        ...(pageToken ? { pageToken } : {}),
      },
    });
  for (let wait = 0; !page.jobComplete; wait++) {
    if (wait >= 10) throw Error('BigQuery job did not finish');
    page = await next();
  }
  const bytes = Number(page.totalBytesProcessed ?? 0);
  const ranks = new Map<string, number>();
  for (;;) {
    for (const row of page.rows ?? []) {
      const host = cruxHost(row.f[0]?.v ?? '');
      const rank = Number(row.f[1]?.v);
      if (!host || !Number.isSafeInteger(rank) || rank <= 0) continue;
      ranks.set(host, Math.min(rank, ranks.get(host) ?? rank));
    }
    if (!page.pageToken) break;
    page = await next(page.pageToken);
  }
  if (!ranks.size) throw Error(`CrUX ${country} ${month} returned no origins`);
  return { ranks, bytes };
}

/**
 * Each domain's best rank among its own host, www. and every subdomain, with the host holding
 * it (exact host first on a tie). A domain whose hosts are all absent is left out.
 */
export function matchDomains(ranks: Map<string, number>, domains: Iterable<string>) {
  const wanted = new Set(domains);
  const best = new Map<string, { rank: number; host: string }>();
  for (const [host, rank] of ranks) {
    const labels = host.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const domain = labels.slice(i).join('.');
      if (!wanted.has(domain)) continue;
      const current = best.get(domain);
      const exact = (h: string) => h === domain || h === `www.${domain}`;
      if (!current || rank < current.rank || (rank === current.rank && exact(host) && !exact(current.host)))
        best.set(domain, { rank, host });
    }
  }
  return best;
}

export async function saveMonth(pool: Pool, country: string, month: string, ranks: Map<string, number>, now = new Date()) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM crux_months WHERE country = ? AND month = ?', [country, month]);
    await conn.query('DELETE FROM crux_origins WHERE country = ? AND month = ?', [country, month]);
    for (const part of chunk([...ranks], 5000))
      await conn.query('INSERT INTO crux_origins (country, month, host, `rank`) VALUES ?', [part.map(([h, r]) => [country, month, h, r])]);
    await conn.query('INSERT INTO crux_months (country, month, origins, fetched_at) VALUES (?, ?, ?, ?)', [
      country,
      month,
      ranks.size,
      now,
    ]);
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => undefined);
    throw error;
  } finally {
    conn.release();
  }
}

export async function loadMonth(pool: Pool, country: string, month: string) {
  const list = await rows<{ host: string; rank: number }>(pool, 'SELECT host, `rank` FROM crux_origins WHERE country = ? AND month = ?', [
    country,
    month,
  ]);
  return new Map(list.map((r) => [r.host, r.rank]));
}

/** Replace the month's ranks for these domains. */
async function saveMatches(pool: Pool, country: string, month: string, domains: string[], ranks: Map<string, number>) {
  const best = matchDomains(ranks, domains);
  for (const part of chunk(domains, 1000))
    await pool.query('DELETE FROM crux_ranks WHERE country = ? AND month = ? AND domain IN (?)', [country, month, part]);
  for (const part of chunk([...best], 1000))
    await pool.query('INSERT INTO crux_ranks (domain, country, month, `rank`, host) VALUES ?', [
      part.map(([domain, b]) => [domain, country, month, b.rank, b.host]),
    ]);
  return best.size;
}

export const watchedDomains = async (pool: Pool) =>
  (await rows<{ domain: string }>(pool, 'SELECT DISTINCT domain FROM watches ORDER BY domain')).map((r) => r.domain);

export const storedMonths = async (pool: Pool, country: string) =>
  (await rows<{ month: string }>(pool, 'SELECT month FROM crux_months WHERE country = ? ORDER BY month', [country])).map((r) => r.month);

/**
 * Download months not stored yet (newest first, until the deadline) and match every watched
 * domain against them; then match newly watched domains against the months already stored.
 */
export async function runCrux(
  pool: Pool,
  {
    config = cruxConfig(),
    client,
    request = fetch,
    now = () => new Date(),
    deadlineMs = 20 * 60_000,
    stopping = () => false,
  }: {
    config?: CruxConfig;
    client?: Client;
    request?: typeof fetch;
    now?: () => Date;
    deadlineMs?: number;
    stopping?: () => boolean;
  } = {},
) {
  if (!client && !config.credentials) return { skipped: 'no CRUX_CREDENTIALS' };
  const conn = await pool.getConnection();
  try {
    const [[lock]] = (await conn.query("SELECT GET_LOCK('traffic-crux', 0) AS got")) as unknown as [[{ got: number }]];
    if (lock.got !== 1) return { skipped: 'another run holds the lock' };
    const [run] = (await pool.query('INSERT INTO crux_runs (started_at) VALUES (?)', [now()])) as unknown as [{ insertId: number }];
    const tally = {
      published: 0,
      stored: 0,
      fetched: [] as string[],
      matched: 0,
      newDomains: 0,
      bytes: 0,
      sent: 0,
      note: null as string | null,
    };
    const deadline = Date.now() + deadlineMs;
    try {
      let project = config.project;
      if (!client) {
        const key = await readServiceAccount(config.credentials as string);
        project ??= key.project_id ?? null;
        client = bigQueryClient(await accessToken(key, request, now()), request);
      }
      if (!project) throw Error('No BigQuery project (CRUX_BIGQUERY_PROJECT)');
      const { country } = config;
      const published = await publishedMonths(client, country);
      tally.sent++;
      const before = new Set(await storedMonths(pool, country));
      tally.published = published.length;
      const domains = await watchedDomains(pool);
      const checked = new Set(
        (await rows<{ domain: string }>(pool, 'SELECT domain FROM crux_domains WHERE country = ?', [country])).map((r) => r.domain),
      );
      const fresh = domains.filter((d) => !checked.has(d));
      for (const month of published.filter((m) => !before.has(m)).reverse()) {
        if (stopping() || Date.now() >= deadline) {
          tally.note = 'time limit reached; remaining months next run';
          break;
        }
        const { ranks, bytes } = await downloadMonth(client, project, country, month);
        tally.sent++;
        tally.bytes += bytes;
        await saveMonth(pool, country, month, ranks, now());
        tally.matched += await saveMatches(pool, country, month, domains, ranks);
        tally.fetched.push(month);
      }
      // Newly watched domains against months that were already stored before this run.
      if (fresh.length && !stopping()) {
        for (const month of [...before].sort())
          tally.matched += await saveMatches(pool, country, month, fresh, await loadMonth(pool, country, month));
        tally.newDomains = fresh.length;
      }
      if (fresh.length && !stopping()) {
        const at = now();
        for (const part of chunk(fresh, 1000))
          await pool.query('INSERT IGNORE INTO crux_domains (domain, country, checked_at) VALUES ?', [part.map((d) => [d, country, at])]);
      }
      tally.stored = before.size + tally.fetched.length;
    } catch (error) {
      tally.note = error instanceof CruxError ? error.message : String((error as Error)?.message ?? error).slice(0, 200);
    }
    await pool.query('UPDATE crux_runs SET finished_at = ?, months = ?, domains = ?, bytes_processed = ?, note = ? WHERE id = ?', [
      now(),
      tally.fetched.length,
      tally.newDomains,
      tally.bytes,
      tally.note?.slice(0, 255) ?? null,
      run.insertId,
    ]);
    return tally;
  } finally {
    await conn.query("SELECT RELEASE_LOCK('traffic-crux')").catch(() => undefined);
    conn.release();
  }
}

/** Each domain's bucket in the latest stored month (domains absent from it are left out). */
export async function latestCruxRanks(pool: Pool, country = cruxConfig().country) {
  const list = await rows<{ domain: string; rank: number }>(
    pool,
    `SELECT r.domain, r.\`rank\` FROM crux_ranks r
     JOIN (SELECT MAX(month) AS month FROM crux_months WHERE country = ?) l ON r.month = l.month
     WHERE r.country = ?`,
    [country, country],
  );
  return new Map(list.map((r) => [r.domain, Number(r.rank)]));
}

export interface CruxRank {
  month: string;
  rank: number;
  host: string;
}

/** Every stored month per domain, oldest first. */
export async function loadCrux(pool: Pool, domains?: string[], country = cruxConfig().country) {
  const out = new Map<string, CruxRank[]>();
  if (domains && !domains.length) return out;
  const list = await rows<{ domain: string; month: string; rank: number; host: string }>(
    pool,
    `SELECT domain, month, \`rank\`, host FROM crux_ranks WHERE country = ? ${domains ? 'AND domain IN (?)' : ''} ORDER BY domain, month`,
    domains ? [country, domains] : [country],
  );
  for (const r of list) (out.get(r.domain) ?? out.set(r.domain, []).get(r.domain))?.push({ month: r.month, rank: r.rank, host: r.host });
  return out;
}

/**
 * Hosts in the latest month's top `limit` bucket that no watched domain covers (neither the
 * host nor any of its parent domains is watched): candidates for the watch list.
 */
export async function untrackedPopular(pool: Pool, limit = 5000, country = cruxConfig().country) {
  const [latest] = await rows<{ month: string }>(pool, 'SELECT MAX(month) AS month FROM crux_months WHERE country = ?', [country]);
  if (!latest?.month) return { month: null, hosts: [] as Array<{ host: string; rank: number }> };
  const [hosts, watched] = await Promise.all([
    rows<{ host: string; rank: number }>(
      pool,
      'SELECT host, `rank` FROM crux_origins WHERE country = ? AND month = ? AND `rank` <= ? ORDER BY `rank`, host',
      [country, latest.month, limit],
    ),
    watchedDomains(pool),
  ]);
  const set = new Set(watched);
  const covered = (host: string) => {
    const labels = host.split('.');
    return labels.some((_, i) => set.has(labels.slice(i).join('.')));
  };
  return { month: latest.month, hosts: hosts.filter((h) => !covered(h.host)) };
}

export async function cruxStatus(pool: Pool, country = cruxConfig().country) {
  const [[months], [run], [ranked]] = await Promise.all([
    rows<{ n: number; first: string | null; last: string | null; fetched: Date | null }>(
      pool,
      'SELECT COUNT(*) AS n, MIN(month) AS first, MAX(month) AS last, MAX(fetched_at) AS fetched FROM crux_months WHERE country = ?',
      [country],
    ),
    rows<{ started_at: Date; finished_at: Date | null; months: number; bytes_processed: number; note: string | null }>(
      pool,
      'SELECT started_at, finished_at, months, bytes_processed, note FROM crux_runs ORDER BY id DESC LIMIT 1',
    ),
    rows<{ n: number }>(
      pool,
      'SELECT COUNT(DISTINCT r.domain) AS n FROM crux_ranks r JOIN (SELECT MAX(month) AS m FROM crux_months WHERE country = ?) l ON r.month = l.m WHERE r.country = ?',
      [country, country],
    ),
  ]);
  return {
    country,
    months: Number(months?.n ?? 0),
    firstMonth: months?.first ?? null,
    latestMonth: months?.last ?? null,
    lastFetchedAt: months?.fetched?.toISOString() ?? null,
    latestMonthDomains: Number(ranked?.n ?? 0),
    lastRunAt: run?.started_at.toISOString() ?? null,
    lastRunMonths: Number(run?.months ?? 0),
    lastRunBytes: Number(run?.bytes_processed ?? 0),
    lastRunNote: run?.note ?? null,
  };
}

/** "前 1 千名", "前 5 萬名", "前 100 萬名" … */
export function cruxLabel(rank: number) {
  if (rank >= 10_000) return `前 ${(rank / 10_000).toLocaleString('en-US')} 萬名`;
  if (rank >= 1000) return `前 ${(rank / 1000).toLocaleString('en-US')} 千名`;
  return `前 ${rank} 名`;
}
