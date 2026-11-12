import {
  type CollectionEntry,
  collectionMonth,
  collectionMonths,
  loadCollection,
  recordCollectionAttempt,
  syncCollections,
  validCollectionMonth,
} from './collection.ts';
import { type Pool, rows } from './db.ts';
import { fetchPolicy, policyNote } from './fetch-policy.ts';
import { finishRecovery, refuseProvider, reserveRecovery } from './provider-backoff.ts';
import { fetchSummary, isRefusal, parseDomainTraffic, requestSimilarweb, responseMetadata, TrafficFetchError } from './similarweb.ts';
import { saveTraffic } from './store.ts';

// The one place that sends requests to data.similarweb.com. This machine has
// one IP. Every run shares an optional weekly budget, sends requests 3 s apart,
// and stops at the first 401/403/429. While last month's profile is unavailable,
// probe at most once per day instead of spending the week's allowance hourly.
// Never-attempted domains still get their first fetch, even if only older months are available.

const DAY = 86_400_000;
/** A domain being fetched is held this long, so two runs never send it twice. */
const CLAIM = 15 * 60_000;
/** Failures before a domain only gets retried next month. */
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
    return env[name] !== undefined && env[name] !== '' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  };
  const target = env.TRAFFIC_TARGET_MONTH;
  if (target && target !== 'auto' && !validCollectionMonth(target)) throw Error('Invalid TRAFFIC_TARGET_MONTH');
  return {
    /** Requests one run may send; 0 sends none. */
    budget: num('TRAFFIC_RUN_BUDGET', 0),
    /** Optional local cap; auto uses response-driven backoff, 0 disables requests. */
    weeklyBudget: env.TRAFFIC_WEEKLY_BUDGET === 'auto' ? null : num('TRAFFIC_WEEKLY_BUDGET', 15),
    collectionEnabled: env.TRAFFIC_COLLECTION_ENABLED === '1',
    targetMonth: target && target !== 'auto' ? target : null,
    coreDomains: num('TRAFFIC_CORE_DOMAINS', 100),
    collectionMaxAttempts: Math.max(1, num('TRAFFIC_COLLECTION_MAX_ATTEMPTS', 3)),
    collectionRetryHours: Math.max(1, num('TRAFFIC_COLLECTION_RETRY_HOURS', 72)),
    hourlyBudget: num('TRAFFIC_HOURLY_BUDGET', 15),
    minIntervalSeconds: num('TRAFFIC_MIN_INTERVAL_SECONDS', 0),
    /** Before last month's profile appears, allow at most one request per interval. */
    probeIntervalHours: Math.max(1, num('TRAFFIC_PROBE_INTERVAL_HOURS', 24)),
    /** A 429 without Retry-After does not establish when the server will reset. */
    quotaCooldownHours: Math.max(1, num('TRAFFIC_QUOTA_COOLDOWN_HOURS', 168)),
    adaptiveBackoff: env.TRAFFIC_ADAPTIVE_BACKOFF === '1',
    backoffBaseHours: Math.max(1, num('TRAFFIC_BACKOFF_BASE_HOURS', 2)),
    backoffMaxHours: Math.max(1, num('TRAFFIC_BACKOFF_BASE_HOURS', 2), num('TRAFFIC_BACKOFF_MAX_HOURS', 24)),
    recoveryIntervalMinutes: Math.max(1, num('TRAFFIC_RECOVERY_INTERVAL_MINUTES', 15)),
    recoverySuccesses: Math.max(1, num('TRAFFIC_RECOVERY_SUCCESSES', 3)),
    recoveryDailyBudget: Math.max(1, num('TRAFFIC_RECOVERY_DAILY_BUDGET', 3)),
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
  collection?: CollectionEntry;
}

/** The 1st of `now`'s month (UTC), plus `months`. */
export const monthStart = (now: Date, months = 0) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1));

export const previousMonth = (now: Date) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * What is due, in fetch order. Due: an unanswered one-off lookup; a watched
 * domain not fetched successfully since the 1st of this month (every watched
 * domain comes due together at the start of a month); or a watched
 * domain still missing last month's profile (Similarweb only ever returns the
 * latest month's channels and countries, so a month not caught is lost), tried
 * every three days. Domains in backoff (next_attempt_at) wait. Order: never-tried
 * domains first, then watched domains still missing last month (that month is
 * lost once the next one is out), then the rest; each group by
 * requester priority, then the oldest success. Only `catchUp` of the domains
 * missing last month are kept (catchUpQuota): before Similarweb has it for a
 * site, fetching it again only gets the month before.
 */
export function dueQueue(candidates: Candidate[], now = new Date(), catchUp = Infinity) {
  const t = now.getTime();
  const last = previousMonth(now);
  const reason = (c: Candidate): DueReason | null => {
    if (c.collection) return c.collection.automatic ? 'collection' : null;
    if (c.nextAttempt > t) return null;
    if (c.pendingSince !== null) return 'lookup';
    if (!c.watched) return null;
    if (c.lastSuccess < monthStart(now).getTime()) return c.lastSuccess ? 'refresh' : 'new';
    return (c.latestProfile ?? '') < last && t - c.lastAttempt >= CATCH_UP ? 'catch-up' : null;
  };
  const group = (c: Candidate) => (!c.lastAttempt ? 0 : c.watched && (c.latestProfile ?? '') < last ? 1 : 2);
  let left = catchUp;
  return candidates
    .map((c) => ({ ...c, reason: reason(c) }))
    .filter((c): c is Candidate & { reason: DueReason } => c.reason !== null)
    .sort((a, b) =>
      a.collection && b.collection
        ? 0
        : a.collection
          ? -1
          : b.collection
            ? 1
            : group(a) - group(b) ||
              a.tier - b.tier ||
              Number(a.lastSuccess > 0) - Number(b.lastSuccess > 0) ||
              a.lastSuccess - b.lastSuccess,
    )
    .filter((c) => c.collection || group(c) !== 1 || left-- > 0);
}
/** Why a domain is due: never fetched, not yet fetched this month, last month's profile still missing, or a one-off lookup. */
export type DueReason = 'new' | 'refresh' | 'catch-up' | 'lookup' | 'collection';

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

export async function loadCandidates(pool: Pool, config: RunConfig, now = new Date()): Promise<Candidate[]> {
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
  }>(
    pool,
    `SELECT w.domain, w.requester, w.kind, w.requested_at,
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
      watched: false,
      pendingSince: null,
      lastAttempt: time(r.last_attempt_at),
      lastSuccess: time(r.last_success_at),
      nextAttempt: time(r.next_attempt_at),
      latestProfile: r.latest,
    };
    c.tier = Math.min(c.tier, tier);
    if (r.kind === 'watch') c.watched = true;
    if (r.kind !== 'watch' && time(r.last_response_at) < r.requested_at.getTime() - LOOKUP_FRESH_DAYS * DAY)
      c.pendingSince = Math.min(c.pendingSince ?? Infinity, r.requested_at.getTime());
    out.set(r.domain, c);
  }
  if (!config.collectionEnabled) return [...out.values()];
  const collection = await loadCollection(pool, config, collectionMonth(config, now), now);
  const enriched: Candidate[] = [];
  // Preserve the collection's importance/first-pass/retry allocation order.
  for (const entry of [...collection.queue, ...collection.entries.filter((e) => !e.automatic)]) {
    const candidate = out.get(entry.domain) ?? {
      domain: entry.domain,
      tier: config.priority.length,
      watched: true,
      pendingSince: null,
      lastAttempt: 0,
      lastSuccess: 0,
      nextAttempt: 0,
      latestProfile: null,
    };
    enriched.push({ ...candidate, collection: entry });
    out.delete(entry.domain);
  }
  // The live response can still fill older visits. Older missing profiles stay
  // visible for manual entry once the provider has advanced to another month.
  const months = (await collectionMonths(pool, config, now)).filter(
    (m) => m < collection.month && m >= previousMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))),
  );
  for (const month of months) {
    const older = await loadCollection(pool, config, month, now);
    for (const entry of older.queue) {
      const index = enriched.findIndex((c) => c.domain === entry.domain);
      if (index >= 0 && !enriched[index].collection?.automatic) {
        enriched[index] = { ...enriched[index], collection: entry };
      } else if (index < 0) {
        enriched.push({
          domain: entry.domain,
          tier: config.priority.length,
          watched: true,
          pendingSince: null,
          lastAttempt: 0,
          lastSuccess: 0,
          nextAttempt: 0,
          latestProfile: null,
          collection: entry,
        });
      }
    }
  }
  return [...enriched, ...out.values()];
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
  if (config.budget <= 0 || config.weeklyBudget === 0 || config.hourlyBudget === 0) return [];
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

export { coolingDown } from './fetch-policy.ts';

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
    /** Fetch just these domains, still within every shared limit and cooldown. */
    only?: string[];
  } = {},
) {
  if (config.budget <= 0) return { skipped: 'budget is 0' };
  const conn = await pool.getConnection();
  try {
    const [[lock]] = (await conn.query("SELECT GET_LOCK('traffic-similarweb', 0) AS got")) as unknown as [[{ got: number }]];
    if (lock.got !== 1) return { skipped: 'another run holds the lock' };
    const started = now();
    if (config.collectionEnabled) await syncCollections(pool, config, started);
    const candidates = await loadCandidates(pool, config, started);
    const initial = new Set(candidates.filter((c) => !c.lastAttempt && c.nextAttempt <= started.getTime()).map((c) => c.domain));
    if (only?.length) {
      const attempted = new Set(
        (
          await rows<{ domain: string }>(pool, 'SELECT domain FROM fetch_state WHERE domain IN (?) AND last_attempt_at IS NOT NULL', [only])
        ).map((r) => r.domain),
      );
      for (const domain of only) if (!attempted.has(domain)) initial.add(domain);
    }
    const due = only
      ? [...new Set(only)].filter(
          (domain) =>
            !config.collectionEnabled ||
            !candidates.find((c) => c.domain === domain)?.collection ||
            candidates.find((c) => c.domain === domain)?.collection?.automatic,
        )
      : dueDomains(candidates, started, catchUpQuota(await lastMonthShare(pool, started), config.budget));
    const firstFetches = due.filter((domain) => initial.has(domain));
    const policy = await fetchPolicy(pool, config, started, firstFetches.length);
    const skipped = policyNote(policy);
    if (skipped) {
      // Even an intentional wait is a worker heartbeat for /readyz.
      await pool.query('INSERT INTO runs (started_at, finished_at, budget, note) VALUES (?, ?, ?, ?)', [
        started,
        now(),
        config.budget,
        skipped,
      ]);
      return { skipped };
    }
    // A first fetch also checks for the latest month; do not spend another probe
    // on a known domain while this batch can fill missing history instead.
    const batch = (!config.collectionEnabled && policy.waitingForMonth && firstFetches.length ? firstFetches : due).slice(
      0,
      policy.maxPerRun,
    );
    const targetMonth = collectionMonth(config, started);
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
      const requestMonth = candidates.find((c) => c.domain === domain)?.collection?.month ?? targetMonth;
      // Recheck under the lock: an interval, week, or month can change mid-run.
      const current = await fetchPolicy(pool, config, at, initial.has(domain) ? 1 : 0);
      const hold = policyNote(current);
      if (hold) {
        tally.note = hold;
        break;
      }
      await upsertState(pool, domain, { last_attempt_at: at, next_attempt_at: new Date(at.getTime() + CLAIM) });
      // Reserve before the network call. A crash/timeout still consumes allowance.
      const [send] = (await pool.query(
        'INSERT INTO sends (domain, at, outcome, target_month, recovery_probe, response_meta) VALUES (?, ?, ?, ?, ?, ?)',
        [
          domain,
          at,
          'pending',
          config.collectionEnabled ? requestMonth : null,
          current.recovery ? 1 : 0,
          JSON.stringify({ egressRoute: 'direct', httpClient: 'node-fetch' }),
        ],
      )) as unknown as [{ insertId: number }];
      tally.sent++;
      if (current.recovery) await reserveRecovery(pool, config, at);
      let data: Record<string, unknown>;
      try {
        // Record the actual HTTP response before parsing, including success and malformed JSON.
        // Transport adapters may replace the default route/client on this reservation first.
        const observedRequest = (async (input: string, init: RequestInit) => {
          const response = await request(input, init);
          await pool.query("UPDATE sends SET http_status=?,response_meta=JSON_MERGE_PATCH(COALESCE(response_meta,'{}'),?) WHERE id=?", [
            response.status,
            JSON.stringify(responseMetadata(response)),
            send.insertId,
          ]);
          return response;
        }) as typeof fetch;
        data = await requestSimilarweb(domain, observedRequest, at);
      } catch (error) {
        const status = error instanceof TrafficFetchError ? error.status : null;
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 255);
        if (isRefusal(error)) {
          const adaptive = config.adaptiveBackoff ? await refuseProvider(pool, config, error, at) : null;
          await pool.query(
            "UPDATE sends SET outcome = ?, http_status = ?, response_meta = JSON_MERGE_PATCH(COALESCE(response_meta,'{}'),?) WHERE id = ?",
            [
              'refused',
              error.httpStatus,
              JSON.stringify({
                ...error.responseMeta,
                retrySource: adaptive?.source ?? (error.retryAt ? 'provider' : 'local-policy'),
                refusalStreak: adaptive?.refusals ?? null,
              }),
              send.insertId,
            ],
          );
          // Not this domain's fault: it keeps its place and goes first after the cooldown.
          const retryAt =
            adaptive?.until ??
            error.retryAt ??
            new Date(at.getTime() + (status === 429 ? config.quotaCooldownHours * 3_600_000 : config.cooldownMinutes * 60_000));
          await upsertState(pool, domain, { refused_at: at, retry_after_at: retryAt, next_attempt_at: null, last_error: message });
          tally.refused = true;
          tally.note = message;
          break;
        }
        await pool.query('UPDATE sends SET outcome = ?, http_status = COALESCE(?,http_status) WHERE id = ?', [
          'error',
          status,
          send.insertId,
        ]);
        await recordFailure(pool, domain, at, message);
        if (current.recovery) await finishRecovery(pool, config, at, false);
        if (config.collectionEnabled) await recordCollectionAttempt(pool, requestMonth, domain, at, 'error');
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
      let collectionOutcome = 'no-data';
      try {
        const traffic = parseDomainTraffic(data, domain, at);
        await saveTraffic(pool, [traffic]);
        await pool.query(
          `UPDATE sends SET outcome = ?, http_status = 200,
           response_meta=JSON_MERGE_PATCH(COALESCE(response_meta,'{}'),?) WHERE id = ?`,
          [
            'ok',
            JSON.stringify({
              latestMonth:
                traffic.monthly
                  .map((m) => m.month)
                  .sort()
                  .at(-1) ?? null,
              latestProfileMonth: Object.keys(traffic.profiles).sort().at(-1) ?? null,
            }),
            send.insertId,
          ],
        );
        await upsertState(pool, domain, {
          last_response_at: at,
          last_success_at: at,
          failures: 0,
          next_attempt_at: null,
          last_error: null,
          result: JSON.stringify(summary),
        });
        tally.ok++;
        collectionOutcome = traffic.monthly.every((m) => m.month < requestMonth) ? 'old-month' : 'response';
      } catch (error) {
        // Answered without usable visits: normal for small sites.
        await pool.query('UPDATE sends SET outcome = ?, http_status = 200 WHERE id = ?', ['no-data', send.insertId]);
        await upsertState(pool, domain, { last_response_at: at, result: JSON.stringify(summary) });
        await recordFailure(pool, domain, at, (error instanceof Error ? error.message : String(error)).slice(0, 255));
        tally.failed++;
      }
      if (current.recovery) await finishRecovery(pool, config, at, collectionOutcome !== 'no-data');
      if (config.collectionEnabled) await recordCollectionAttempt(pool, requestMonth, domain, at, collectionOutcome);
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

/** Retry a day later; after three failures not until next month, when everything watched comes due again. */
async function recordFailure(pool: Pool, domain: string, at: Date, message: string) {
  await pool.query(
    `UPDATE fetch_state SET failures = failures + 1, last_error = ?,
       next_attempt_at = IF(failures >= ?, ?, ?) WHERE domain = ?`,
    [message, MAX_FAILURES, monthStart(at, 1), new Date(at.getTime() + DAY), domain],
  );
}
