import { type Pool, rows } from './db.ts';
import { TrafficFetchError, trafficDomain } from './similarweb.ts';

// Cloudflare Radar's POPULAR domain ranking (official API, Account → Radar →
// Read token in CLOUDFLARE_RADAR_API_TOKEN), moved from tag
// (app/src/media-traffic/radar.ts). Radar answers only the latest period, so
// every period seen is kept. Exact places exist only for the top 100; below
// that Radar gives buckets ("top 20,000") or ">200000", which is stored as a
// lower bound and never read as "top 200,000". Ranks are not visits.

export interface RadarPeriod {
  domain: string;
  fetchedAt: string;
  dateStart: string;
  dateEnd: string;
  rank: number | null;
  bucket: number | null;
  bucketLowerBound: number | null;
}

const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export const radarToken = (env: Record<string, string | undefined> = process.env) => env.CLOUDFLARE_RADAR_API_TOKEN?.trim() || null;

/** Official domain details endpoint: ordered top 100, otherwise ranking buckets. */
export async function fetchRadarDomain(
  domain: string,
  token: string,
  request: typeof fetch = fetch,
  now = new Date(),
): Promise<RadarPeriod> {
  if (trafficDomain(domain) !== domain) throw Error('Invalid domain');
  const response = await request(
    `https://api.cloudflare.com/client/v4/radar/ranking/domain/${encodeURIComponent(domain)}?rankingType=POPULAR&format=JSON`,
    { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000), redirect: 'error' },
  );
  if (!response.ok) throw new TrafficFetchError(response.status, `Cloudflare Radar HTTP ${response.status}`);
  // biome-ignore lint/suspicious/noExplicitAny: shape checked field by field below
  const data: any = await response.json();
  if (data.success !== true || !data.result?.details_0) throw Error('Invalid Radar response');
  const details = data.result.details_0;
  const range = data.result.meta?.dateRange?.[0];
  const raw = details.bucket;
  const bucket =
    raw == null
      ? null
      : typeof raw === 'string' && /^\d+$/.test(raw)
        ? Number(raw)
        : typeof raw === 'string' && /^>\d+$/.test(raw)
          ? null
          : Number.NaN;
  const bucketLowerBound = typeof raw === 'string' && /^>\d+$/.test(raw) ? Number(raw.slice(1)) : null;
  const row = {
    domain,
    fetchedAt: now.toISOString(),
    dateStart: range?.startTime,
    dateEnd: range?.endTime,
    rank: details.rank ?? null,
    bucket,
    bucketLowerBound,
  };
  const valid =
    isTime(row.dateStart) &&
    isTime(row.dateEnd) &&
    Date.parse(row.dateStart) <= Date.parse(row.dateEnd) &&
    Date.parse(row.dateEnd) <= now.getTime() &&
    (row.rank === null || (positive(row.rank) && row.rank <= 100)) &&
    (row.bucket === null || positive(row.bucket)) &&
    (row.bucketLowerBound === null || (positive(row.bucketLowerBound) && row.bucket === null));
  if (!valid) throw Error('Invalid Radar ranking or reporting period');
  return row as RadarPeriod;
}

/** Newer fetches win for the same period; first_seen_at keeps the first sighting. */
export async function saveRadar(pool: Pool, periods: RadarPeriod[]) {
  if (!periods.length) return { periods: 0 };
  await pool.query(
    `INSERT INTO radar_ranks (domain, date_end, date_start, \`rank\`, bucket, bucket_lower_bound, first_seen_at, fetched_at) VALUES ?
     ON DUPLICATE KEY UPDATE
       \`rank\` = IF(VALUES(fetched_at) >= fetched_at, VALUES(\`rank\`), \`rank\`),
       bucket = IF(VALUES(fetched_at) >= fetched_at, VALUES(bucket), bucket),
       bucket_lower_bound = IF(VALUES(fetched_at) >= fetched_at, VALUES(bucket_lower_bound), bucket_lower_bound),
       first_seen_at = LEAST(first_seen_at, VALUES(first_seen_at)),
       fetched_at = GREATEST(fetched_at, VALUES(fetched_at))`,
    [
      periods.map((p) => [
        p.domain,
        new Date(p.dateEnd),
        new Date(p.dateStart),
        p.rank,
        p.bucket,
        p.bucketLowerBound,
        new Date(p.fetchedAt),
        new Date(p.fetchedAt),
      ]),
    ],
  );
  return { periods: periods.length };
}

/** Every stored period per domain, oldest first. */
export async function loadRadar(pool: Pool, domains?: string[]) {
  if (domains && !domains.length) return new Map<string, RadarPeriod[]>();
  const list = await rows<{
    domain: string;
    date_end: Date;
    date_start: Date;
    rank: number | null;
    bucket: number | null;
    bucket_lower_bound: number | null;
    fetched_at: Date;
  }>(
    pool,
    `SELECT domain, date_end, date_start, \`rank\`, bucket, bucket_lower_bound, fetched_at FROM radar_ranks
     ${domains ? 'WHERE domain IN (?)' : ''} ORDER BY domain, date_end`,
    domains ? [domains] : [],
  );
  const out = new Map<string, RadarPeriod[]>();
  for (const r of list) {
    const periods = out.get(r.domain) ?? out.set(r.domain, []).get(r.domain) ?? [];
    periods.push({
      domain: r.domain,
      fetchedAt: r.fetched_at.toISOString(),
      dateStart: r.date_start.toISOString(),
      dateEnd: r.date_end.toISOString(),
      rank: r.rank,
      bucket: r.bucket,
      bucketLowerBound: r.bucket_lower_bound,
    });
  }
  return out;
}

/** Fill watched domains with no stored ranking and no previous attempt. No refreshes or retries. */
export async function runRadar(
  pool: Pool,
  {
    token = radarToken(),
    request = fetch,
    now = () => new Date(),
    pauseMs = 1000,
    deadlineMs = 25 * 60_000,
    delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    token?: string | null;
    request?: typeof fetch;
    now?: () => Date;
    pauseMs?: number;
    deadlineMs?: number;
    delay?: (ms: number) => Promise<void>;
  } = {},
) {
  if (!token) return { skipped: 'no CLOUDFLARE_RADAR_API_TOKEN' };
  const conn = await pool.getConnection();
  try {
    const [[lock]] = (await conn.query("SELECT GET_LOCK('traffic-radar', 0) AS got")) as unknown as [[{ got: number }]];
    if (lock.got !== 1) return { skipped: 'another run holds the lock' };
    const due = await rows<{ domain: string }>(
      pool,
      `SELECT w.domain FROM (SELECT DISTINCT domain FROM watches) w LEFT JOIN radar_state s ON s.domain = w.domain
       WHERE s.last_attempt_at IS NULL AND s.last_success_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM radar_ranks r WHERE r.domain = w.domain)
       ORDER BY w.domain`,
    );
    const [run] = (await pool.query('INSERT INTO radar_runs (started_at) VALUES (?)', [now()])) as unknown as [{ insertId: number }];
    const tally = { due: due.length, sent: 0, ok: 0, failed: 0, blocked: false, note: null as string | null };
    const deadline = Date.now() + deadlineMs;
    let consecutive = 0;
    for (const [index, { domain }] of due.entries()) {
      if (Date.now() >= deadline) {
        tally.note = 'time limit reached';
        break;
      }
      if (index) await delay(pauseMs);
      const at = now();
      tally.sent++;
      try {
        await saveRadar(pool, [await fetchRadarDomain(domain, token, request, at)]);
        await pool.query(
          `INSERT INTO radar_state (domain, last_attempt_at, last_success_at, failures, last_error) VALUES (?, ?, ?, 0, NULL)
           ON DUPLICATE KEY UPDATE last_attempt_at = VALUES(last_attempt_at), last_success_at = VALUES(last_success_at), failures = 0, last_error = NULL`,
          [domain, at, at],
        );
        tally.ok++;
        consecutive = 0;
      } catch (error) {
        // Never store response bodies or anything carrying the token.
        const message = error instanceof TrafficFetchError ? error.message : 'Cloudflare Radar data unavailable or invalid';
        await pool.query(
          `INSERT INTO radar_state (domain, last_attempt_at, failures, last_error) VALUES (?, ?, 1, ?)
           ON DUPLICATE KEY UPDATE last_attempt_at = VALUES(last_attempt_at), failures = failures + 1, last_error = VALUES(last_error)`,
          [domain, at, message],
        );
        tally.failed++;
        tally.note = message;
        if (error instanceof TrafficFetchError && [401, 403, 429].includes(error.status)) {
          tally.blocked = true;
          break;
        }
        if (++consecutive >= 3) {
          tally.note = `three errors in a row: ${message}`;
          break;
        }
      }
    }
    await pool.query('UPDATE radar_runs SET finished_at = ?, sent = ?, ok = ?, failed = ?, blocked = ?, note = ? WHERE id = ?', [
      now(),
      tally.sent,
      tally.ok,
      tally.failed,
      tally.blocked ? 1 : 0,
      tally.note?.slice(0, 255) ?? null,
      run.insertId,
    ]);
    return tally;
  } finally {
    await conn.query("SELECT RELEASE_LOCK('traffic-radar')").catch(() => undefined);
    conn.release();
  }
}

export const lastRadarRun = async (pool: Pool) =>
  (
    await rows<{
      started_at: Date;
      finished_at: Date | null;
      sent: number;
      ok: number;
      failed: number;
      blocked: number;
      note: string | null;
    }>(pool, 'SELECT started_at, finished_at, sent, ok, failed, blocked, note FROM radar_runs ORDER BY id DESC LIMIT 1')
  )[0] ?? null;
