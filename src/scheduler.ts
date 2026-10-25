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
/** Failures before a domain only gets retried monthly. */
const MAX_FAILURES = 3;
/** A domain that is missing last month's profile is retried this often until it appears. */
const CATCH_UP = 3 * DAY;
/** Domains missing last month sent per run however rarely recent responses have had it, to look for it. */
const PROBES = 1;
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
  /** Shortest refresh interval among standing watches, or null if only one-off lookups. */
  refreshDays: number | null;
  /** Oldest one-off lookup not answered since it was submitted. */
  pendingSince: number | null;
  lastAttempt: number;
  lastSuccess: number;
  nextAttempt: number;
  latestProfile: string | null;
}

export const previousMonth = (now: Date) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * What is due, in fetch order. Due: an unanswered one-off lookup; a watched
 * domain whose last success is older than its refresh interval; or a watched
 * domain still missing last month's profile (Similarweb only ever returns the
 * latest month's channels and countries, so a month not caught is lost), tried
 * every three days. Domains in backoff (next_attempt_at) wait. Order: watched
 * domains tried before but still missing last month first (that month is lost
 * once the next one is out), then never tried, then the rest; each group by
 * requester priority, then the oldest success. Only `catchUp` of the domains
 * missing last month are kept (catchUpQuota): before Similarweb has it for a
 * site, fetching it again only gets the month before.
 */
export function dueQueue(candidates: Candidate[], now = new Date(), catchUp = Infinity) {
  const t = now.getTime();
  const last = previousMonth(now);
  const reason = (c: Candidate): DueReason | null => {
    if (c.nextAttempt > t) return null;
    if (c.pendingSince !== null) return 'lookup';
    if (c.refreshDays === null) return null;
    if (t - c.lastSuccess >= c.refreshDays * DAY) return c.lastSuccess ? 'refresh' : 'new';
    return (c.latestProfile ?? '') < last && t - c.lastAttempt >= CATCH_UP ? 'catch-up' : null;
  };
  const group = (c: Candidate) => (!c.lastAttempt ? 1 : c.refreshDays !== null && (c.latestProfile ?? '') < last ? 0 : 2);
  let left = catchUp;
  return candidates
    .map((c) => ({ ...c, reason: reason(c) }))
    .filter((c): c is Candidate & { reason: DueReason } => c.reason !== null)
    .sort(
      (a, b) =>
        group(a) - group(b) || a.tier - b.tier || Number(a.lastSuccess > 0) - Number(b.lastSuccess > 0) || a.lastSuccess - b.lastSuccess,
    )
    .filter((c) => group(c) !== 0 || left-- > 0);
}
/** Why a domain is due: never fetched, past its refresh interval, last month's profile still missing, or a one-off lookup. */
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

/** Domains missing last month a run may send: the budget times the share of recent answers that had it, at least PROBES. */
export const catchUpQuota = (share: MonthShare, budget: number) =>
  Math.max(PROBES, share.sampled ? Math.round((budget * share.found) / share.sampled) : 0);

const time = (d: Date | null) => d?.getTime() ?? 0;

export async function loadCandidates(pool: Pool, config: RunConfig): Promise<Candidate[]> {
  const list = await rows<{
    domain: string;
    requester: string;
    kind: string;
    requested_at: Date;
    refresh_days: number | null;
    last_attempt_at: Date | null;
    last_response_at: Date | null;
    last_success_at: Date | null;
    next_attempt_at: Date | null;
    latest: string | null;
  }>(
    pool,
    `SELECT w.domain, w.requester, w.kind, w.requested_at, w.refresh_days,
       s.last_attempt_at, s.last_response_at, s.last_success_at, s.next_attempt_at,
       (SELECT MAX(month) FROM traffic_profiles p WHERE p.domain = w.domain) AS latest
     FROM watches w LEFT JOIN fetch_state s ON s.domain = w.domain`,
  );
  const out = new Map<string, Candidate>();
  for (const r of list) {
    const tier = config.priority.includes(r.requester) ? config.priority.indexOf(r.requester) : config.priority.length;
    const c = out.get(r.domain) ?? {
      domain: r.domain,
      tier,
      refreshDays: null,
      pendingSince: null,
      lastAttempt: time(r.last_attempt_at),
      lastSuccess: time(r.last_success_at),
      nextAttempt: time(r.next_attempt_at),
      latestProfile: r.latest,
    };
    c.tier = Math.min(c.tier, tier);
    if (r.kind === 'watch' && r.refresh_days !== null) c.refreshDays = Math.min(c.refreshDays ?? Infinity, r.refresh_days);
    if (r.kind !== 'watch' && time(r.last_response_at) < r.requested_at.getTime() - LOOKUP_FRESH_DAYS * DAY)
      c.pendingSince = Math.min(c.pendingSince ?? Infinity, r.requested_at.getTime());
    out.set(r.domain, c);
  }
  return [...out.values()];
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
          // Not this domain's fault: it keeps its place and goes first after the cooldown.
          await upsertState(pool, domain, { refused_at: at, next_attempt_at: null, last_error: message });
          tally.refused = true;
          tally.note = message;
          break;
        }
        await pool.query('INSERT INTO sends (domain, at, outcome, http_status) VALUES (?, ?, ?, ?)', [domain, at, 'error', status]);
        await recordFailure(pool, domain, at, message);
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
        await recordFailure(pool, domain, at, (error instanceof Error ? error.message : String(error)).slice(0, 255));
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

/** Retry a day later; after three failures only monthly. */
async function recordFailure(pool: Pool, domain: string, at: Date, message: string) {
  await pool.query(
    `UPDATE fetch_state SET failures = failures + 1, last_error = ?,
       next_attempt_at = IF(failures >= ?, ?, ?) WHERE domain = ?`,
    [message, MAX_FAILURES, new Date(at.getTime() + 30 * DAY), new Date(at.getTime() + DAY), domain],
  );
}
