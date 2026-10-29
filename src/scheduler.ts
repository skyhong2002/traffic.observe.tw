import { type Pool, rows } from './db.ts';
import { fetchSummary, isRefusal, parseDomainTraffic, requestSimilarweb, TrafficFetchError } from './similarweb.ts';
import { saveTraffic } from './store.ts';

// The one place that sends requests to data.similarweb.com. This machine has
// one IP and Similarweb refuses after ~20 requests in a burst (403, lifts after
// ~11 minutes), so each hourly run sends at most `budget` requests, 3 s apart,
// highest-priority domains first, and stops at the first 401/403/429.

const DAY = 86_400_000;
/** A domain being fetched is held this long, so two runs never send it twice. */
const CLAIM = 15 * 60_000;
/** How far back responses count towards how often last month is out (never before the 1st). */
const SHARE_WINDOW = DAY;
/** A one-off lookup is answered by any response this recent, even one fetched before it was asked. */
export const LOOKUP_FRESH_DAYS = 30;

export function runConfig(env: Record<string, string | undefined> = process.env) {
  const num = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return env[name] !== undefined && env[name] !== '' && Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    /** Requests one run may send; 0 sends none. */
    budget: num('TRAFFIC_RUN_BUDGET', 0),
    /** After a refusal nothing is sent for this long (tag's limit lifted after ~11 minutes). */
    cooldownMinutes: num('TRAFFIC_REFUSAL_COOLDOWN_MINUTES', 50),
    /** Requesters in priority order; earlier ones are fetched first. Editors' hand-added domains (manual) come last. */
    priority: (env.TRAFFIC_PRIORITY || 'tag,blog,sheet,manual').split(',').map((s) => s.trim()),
    /** One-off lookups a requester may submit per Taipei day. */
    submitPerDay: num('TRAFFIC_SUBMIT_PER_DAY', 200),
    /** The worker runs once an hour at this minute (:35 is where tag's job ran). */
    runMinute: num('TRAFFIC_RUN_MINUTE', 35) % 60,
  };
}
export type RunConfig = ReturnType<typeof runConfig>;

export interface Candidate {
  domain: string;
  /** Index of the highest-priority requester watching it. */
  tier: number;
  /** On a standing list (refreshed every month), not only one-off lookups. */
  watched: boolean;
  /** Oldest one-off lookup not answered since it was submitted. */
  pendingSince: number | null;
  lastAttempt: number;
  lastSuccess: number;
  nextAttempt: number;
  latestProfile: string | null;
  /** Includes imported traffic without a fetch-state record. */
  hasData?: boolean;
}

/** The 1st of `now`'s month (UTC), plus `months`. */
export const monthStart = (now: Date, months = 0) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1));

export const previousMonth = (now: Date) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Only fill domains without data that have never been attempted. No refreshes or retries. */
export function dueQueue(candidates: Candidate[], now = new Date(), _catchUp = Infinity) {
  return candidates
    .filter((c) => !c.lastAttempt && !c.lastSuccess && !c.hasData && !c.latestProfile && c.nextAttempt <= now.getTime())
    .filter((c) => c.watched || c.pendingSince !== null)
    .sort((a, b) => a.tier - b.tier || a.domain.localeCompare(b.domain))
    .map((c) => ({ ...c, reason: (c.pendingSince !== null ? 'lookup' : 'new') as DueReason }));
}
/** Queue reasons; refresh and catch-up are retained for API compatibility but currently disabled. */
export type DueReason = 'new' | 'refresh' | 'catch-up' | 'lookup';

export const dueDomains = (candidates: Candidate[], now = new Date(), catchUp = Infinity) =>
  dueQueue(candidates, now, catchUp).map((c) => c.domain);

/**
 * Of the domains answered with visits in the last day (this month only), how many came with last month's profile.
 * Similarweb may not put out a month for every site at once, so this is a share, not a yes or no.
 */
export async function lastMonthShare(pool: Pool, now = new Date()) {
  const month = previousMonth(now);
  const since = Math.max(now.getTime() - SHARE_WINDOW, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [r] = await rows<{ sampled: number; found: number | null }>(
    pool,
    `SELECT COUNT(*) AS sampled,
       SUM(EXISTS (SELECT 1 FROM traffic_profiles p WHERE p.domain = f.domain AND p.month = ?)) AS found
     FROM fetch_state f WHERE f.last_success_at >= ? AND f.last_success_at = f.last_response_at`,
    [month, new Date(since)],
  );
  return { month, sampled: Number(r?.sampled ?? 0), found: Number(r?.found ?? 0) };
}
export type MonthShare = Awaited<ReturnType<typeof lastMonthShare>>;

/** Domains missing last month a run may send: the budget times the share of recent answers that had it, at least one (retained for status compatibility; catch-up is disabled). */
export const catchUpQuota = (share: MonthShare, budget: number) =>
  Math.max(1, share.sampled ? Math.round((budget * share.found) / share.sampled) : 0);

const time = (d: Date | null) => d?.getTime() ?? 0;

export async function loadCandidates(pool: Pool, config: RunConfig): Promise<Candidate[]> {
  const list = await rows<{
    domain: string;
    requester: string;
    kind: string;
    requested_at: Date;
    last_attempt_at: Date | null;
    last_response_at: Date | null;
    last_success_at: Date | null;
    next_attempt_at: Date | null;
    latest: string | null;
    has_data: number;
  }>(
    pool,
    `SELECT w.domain, w.requester, w.kind, w.requested_at,
       s.last_attempt_at, s.last_response_at, s.last_success_at, s.next_attempt_at,
       EXISTS (SELECT 1 FROM traffic_months m WHERE m.domain = w.domain) AS has_data,
       (SELECT MAX(month) FROM traffic_profiles p WHERE p.domain = w.domain) AS latest
     FROM watches w LEFT JOIN fetch_state s ON s.domain = w.domain`,
  );
  const out = new Map<string, Candidate>();
  for (const r of list) {
    const tier = config.priority.includes(r.requester) ? config.priority.indexOf(r.requester) : config.priority.length;
    const c = out.get(r.domain) ?? {
      domain: r.domain,
      tier,
      watched: false,
      pendingSince: null,
      lastAttempt: time(r.last_attempt_at),
      lastSuccess: time(r.last_success_at),
      nextAttempt: time(r.next_attempt_at),
      latestProfile: r.latest,
      hasData: Boolean(r.has_data),
    };
    c.tier = Math.min(c.tier, tier);
    if (r.kind === 'watch') c.watched = true;
    if (r.kind !== 'watch' && time(r.last_response_at) < r.requested_at.getTime() - LOOKUP_FRESH_DAYS * DAY)
      c.pendingSince = Math.min(c.pendingSince ?? Infinity, r.requested_at.getTime());
    out.set(r.domain, c);
  }
  return [...out.values()];
}

/** Runs refused in a row, without an answer, before the queue's times stop being a forecast. */
const STALLED_RUNS = 3;

/**
 * When Similarweb started refusing every run, if the last STALLED_RUNS runs that
 * sent anything were all refused before a single answer; null while fetching works.
 */
export async function refusedSince(pool: Pool) {
  const recent = await rows<{ refused: number; ok: number }>(
    pool,
    `SELECT refused, ok FROM runs WHERE sent > 0 ORDER BY id DESC LIMIT ${STALLED_RUNS}`,
  );
  if (recent.length < STALLED_RUNS || recent.some((r) => !r.refused || r.ok)) return null;
  const [r] = await rows<{ at: Date | null }>(
    pool,
    'SELECT MIN(started_at) AS at FROM runs WHERE sent > 0 AND id > COALESCE((SELECT MAX(id) FROM runs WHERE ok > 0), 0)',
  );
  return r?.at ?? null;
}

/** The worker runs hourly; a gap this long means it stopped. */
const WORKER_SILENT = 3 * 3_600_000;

/**
 * What is wrong with fetching, for /readyz and status.skyhong.tw: the worker
 * has not run for WORKER_SILENT, or the last STALLED_RUNS runs that sent
 * anything got no answer (refused or failed). Empty when fine or turned off.
 */
export async function fetchProblems(pool: Pool, config: RunConfig, now = new Date()) {
  if (config.budget <= 0) return [];
  const problems: string[] = [];
  const [last] = await rows<{ at: Date | null }>(pool, 'SELECT MAX(started_at) AS at FROM runs');
  if (!last?.at || now.getTime() - last.at.getTime() > WORKER_SILENT)
    problems.push(`worker has not run since ${last?.at?.toISOString() ?? 'ever'}`);
  const recent = await rows<{ ok: number; note: string | null }>(
    pool,
    `SELECT ok, note FROM runs WHERE sent > 0 ORDER BY id DESC LIMIT ${STALLED_RUNS}`,
  );
  if (recent.length === STALLED_RUNS && recent.every((r) => !r.ok))
    problems.push(`last ${STALLED_RUNS} Similarweb runs got no answer (${recent[0].note ?? 'failed'})`);
  return problems;
}

/** The latest refusal, if it is still inside the cooldown. */
export async function coolingDown(pool: Pool, config: RunConfig, now = new Date()) {
  const [r] = await rows<{ at: Date | null }>(pool, 'SELECT MAX(refused_at) AS at FROM fetch_state');
  const until = r?.at ? r.at.getTime() + config.cooldownMinutes * 60_000 : 0;
  return until > now.getTime() ? new Date(until) : null;
}

const upsertState = (pool: Pool, domain: string, set: Record<string, unknown>) => {
  const cols = Object.keys(set);
  return pool.query(
    `INSERT INTO fetch_state (domain, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    [domain, ...cols.map((c) => set[c])],
  );
};

/**
 * One run. Holds a MySQL named lock so a manual run and the worker never send
 * at the same time. Returns what it did; a refusal is not an error.
 */
export async function runOnce(
  pool: Pool,
  {
    config = runConfig(),
    request = fetch,
    now = () => new Date(),
    pauseMs = 3000,
    deadlineMs = 5 * 60_000,
    delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    only,
  }: {
    config?: RunConfig;
    request?: typeof fetch;
    now?: () => Date;
    pauseMs?: number;
    deadlineMs?: number;
    delay?: (ms: number) => Promise<void>;
    /** Fetch just these domains (tools/fetch-once.ts), still within the budget and cooldown. */
    only?: string[];
  } = {},
) {
  if (config.budget <= 0) return { skipped: 'budget is 0' };
  const conn = await pool.getConnection();
  try {
    const [[lock]] = (await conn.query("SELECT GET_LOCK('traffic-similarweb', 0) AS got")) as unknown as [[{ got: number }]];
    if (lock.got !== 1) return { skipped: 'another run holds the lock' };
    const cooling = await coolingDown(pool, config, now());
    if (cooling) return { skipped: `cooling down until ${cooling.toISOString()}` };
    const due =
      only ?? dueDomains(await loadCandidates(pool, config), now(), catchUpQuota(await lastMonthShare(pool, now()), config.budget));
    const batch = due.slice(0, config.budget);
    const started = now();
    const [run] = (await pool.query('INSERT INTO runs (started_at, budget) VALUES (?, ?)', [started, config.budget])) as unknown as [
      { insertId: number },
    ];
    const tally = { due: due.length, sent: 0, ok: 0, failed: 0, refused: false, note: null as string | null };
    let consecutive = 0;
    // Wall-clock time, whatever `now` says.
    const deadline = Date.now() + deadlineMs;
    for (const [index, domain] of batch.entries()) {
      if (Date.now() >= deadline) {
        tally.note = 'time limit reached';
        break;
      }
      if (index) await delay(pauseMs);
      const at = now();
      await upsertState(pool, domain, { last_attempt_at: at, next_attempt_at: new Date(at.getTime() + CLAIM) });
      tally.sent++;
      let data: Record<string, unknown>;
      try {
        data = await requestSimilarweb(domain, request);
      } catch (error) {
        const status = error instanceof TrafficFetchError ? error.status : null;
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 255);
        if (isRefusal(error)) {
          await pool.query('INSERT INTO sends (domain, at, outcome, http_status) VALUES (?, ?, ?, ?)', [domain, at, 'refused', status]);
          // Keep the refusal for diagnostics; attempted domains are not retried.
          await upsertState(pool, domain, { refused_at: at, next_attempt_at: null, last_error: message });
          tally.refused = true;
          tally.note = message;
          break;
        }
        await pool.query('INSERT INTO sends (domain, at, outcome, http_status) VALUES (?, ?, ?, ?)', [domain, at, 'error', status]);
        await recordFailure(pool, domain, message);
        tally.failed++;
        // Repeated HTTP/network errors mean the provider is down; stop until the next run.
        if (++consecutive >= 3) {
          tally.note = 'three errors in a row';
          break;
        }
        continue;
      }
      consecutive = 0;
      const summary = fetchSummary(data, domain);
      try {
        const traffic = parseDomainTraffic(data, domain, at);
        await saveTraffic(pool, [traffic]);
        await pool.query('INSERT INTO sends (domain, at, outcome, http_status) VALUES (?, ?, ?, 200)', [domain, at, 'ok']);
        await upsertState(pool, domain, {
          last_response_at: at,
          last_success_at: at,
          failures: 0,
          next_attempt_at: null,
          last_error: null,
          result: JSON.stringify(summary),
        });
        tally.ok++;
      } catch (error) {
        // Answered without usable visits: normal for small sites.
        await pool.query('INSERT INTO sends (domain, at, outcome, http_status) VALUES (?, ?, ?, 200)', [domain, at, 'no-data']);
        await upsertState(pool, domain, { last_response_at: at, result: JSON.stringify(summary) });
        await recordFailure(pool, domain, (error instanceof Error ? error.message : String(error)).slice(0, 255));
        tally.failed++;
      }
    }
    await pool.query('UPDATE runs SET finished_at = ?, sent = ?, ok = ?, failed = ?, refused = ?, note = ? WHERE id = ?', [
      now(),
      tally.sent,
      tally.ok,
      tally.failed,
      tally.refused ? 1 : 0,
      tally.note,
      run.insertId,
    ]);
    return tally;
  } finally {
    await conn.query("SELECT RELEASE_LOCK('traffic-similarweb')").catch(() => undefined);
    conn.release();
  }
}

/** Keep the failure for diagnostics without scheduling a retry. */
async function recordFailure(pool: Pool, domain: string, message: string) {
  await pool.query('UPDATE fetch_state SET failures = failures + 1, last_error = ?, next_attempt_at = NULL WHERE domain = ?', [
    message,
    domain,
  ]);
}
