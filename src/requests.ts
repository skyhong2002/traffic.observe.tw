import { type Pool, rows } from './db.ts';
import { LOOKUP_FRESH_DAYS, type RunConfig, runConfig } from './scheduler.ts';
import { type FetchSummary, publicDomain, type TrafficProfile } from './similarweb.ts';
import { loadTraffic } from './store.ts';

// What services ask for. A standing list (`watch`, e.g. tag's outlets) is
// refreshed every month; a one-off lookup (`traffic`, `similar_sites`, as
// blog submits them) is fetched once and again only when resubmitted after 30
// days; a domain answered in the 30 days before it was asked is not fetched again. The request/result shape is the one tag served at /internal/similarweb
// (docs/api.md), so blog keeps working unchanged.

export const KINDS = ['traffic', 'similar_sites'] as const;
export type Kind = (typeof KINDS)[number];
const DAY = 86_400_000;
const MAX_WATCH = 5000;

const taipeiDayStart = (now: Date) => {
  const offset = 8 * 3_600_000;
  return new Date(Math.floor((now.getTime() + offset) / DAY) * DAY - offset);
};

interface State {
  last_attempt_at: Date | null;
  last_response_at: Date | null;
  last_success_at: Date | null;
  failures: number;
  next_attempt_at: Date | null;
  refused_at: Date | null;
  result: unknown;
}
const state = async (pool: Pool, domain: string) =>
  (await rows<State>(pool, 'SELECT * FROM fetch_state WHERE domain = ?', [domain]))[0] as State | undefined;
const summaryOf = (s: State | undefined) =>
  (s?.result ? (typeof s.result === 'string' ? JSON.parse(s.result) : s.result) : null) as FetchSummary | null;

/** pending / ok / no-data / blocked for one lookup, from the domain's fetch state. */
export function lookupStatus(kind: Kind, requestedAt: Date, s: State | undefined) {
  // A response from the LOOKUP_FRESH_DAYS before the lookup answers it (the scheduler does not fetch it again).
  const asked = requestedAt.getTime() - LOOKUP_FRESH_DAYS * DAY;
  const at = (d: Date | null | undefined) => d?.getTime() ?? 0;
  if (s && at(s.last_response_at) >= asked) {
    if (kind === 'traffic') return at(s.last_success_at) >= asked ? 'ok' : 'no-data';
    return summaryOf(s)?.similarSites.length ? 'ok' : 'no-data';
  }
  if (s && at(s.refused_at) >= requestedAt.getTime()) return 'blocked';
  if (s && s.failures >= 3) return 'no-data';
  return 'pending';
}

/** Queues a one-off lookup. Returns its status, or an error the API turns into 400/429. */
export async function submitLookup(
  pool: Pool,
  requester: string,
  rawDomain: unknown,
  rawKind: unknown,
  { now = new Date(), config = runConfig() }: { now?: Date; config?: RunConfig } = {},
) {
  const domain = publicDomain(rawDomain);
  if (!domain) return { error: 'invalid_domain' as const };
  const kind = KINDS.find((k) => k === rawKind);
  if (!kind) return { error: 'invalid_kind' as const };
  const [existing] = await rows<{ requested_at: Date }>(
    pool,
    'SELECT requested_at FROM watches WHERE requester = ? AND domain = ? AND kind = ?',
    [requester, domain, kind],
  );
  const s = await state(pool, domain);
  if (existing) {
    const status = lookupStatus(kind, existing.requested_at, s);
    const answered = s?.last_response_at ?? null;
    const stale =
      answered &&
      answered.getTime() >= existing.requested_at.getTime() - LOOKUP_FRESH_DAYS * DAY &&
      now.getTime() - answered.getTime() > LOOKUP_FRESH_DAYS * DAY;
    // A refused domain keeps its wait: resubmitting must not clear a backoff.
    if (!stale || status === 'blocked') return { domain, kind, status, created: false };
  }
  const [{ n }] = await rows<{ n: number }>(
    pool,
    "SELECT COUNT(*) AS n FROM watches WHERE requester = ? AND kind <> 'watch' AND requested_at >= ?",
    [requester, taipeiDayStart(now)],
  );
  if (Number(n) >= config.submitPerDay) return { error: 'daily_limit' as const };
  await pool.query(
    'INSERT INTO watches (requester, domain, kind, requested_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE requested_at = VALUES(requested_at)',
    [requester, domain, kind, now],
  );
  // A stale row starts over: its old failures and backoff no longer apply.
  if (existing) await pool.query('UPDATE fetch_state SET failures = 0, next_attempt_at = NULL WHERE domain = ?', [domain]);
  // A domain answered recently enough is not fetched again: the lookup is answered already.
  return { domain, kind, status: existing ? ('pending' as const) : lookupStatus(kind, now, s), created: !existing };
}

/** Every lookup a requester has for a domain, in tag's /internal/similarweb/results shape. */
export async function lookupResults(pool: Pool, requester: string, domain: string) {
  const list = await rows<{ kind: Kind; requested_at: Date }>(
    pool,
    "SELECT kind, requested_at FROM watches WHERE requester = ? AND domain = ? AND kind <> 'watch'",
    [requester, domain],
  );
  const s = await state(pool, domain);
  const summary = summaryOf(s);
  const traffic = (await loadTraffic(pool, [domain])).get(domain);
  const profile = traffic ? (Object.values(traffic.profiles).at(-1) as TrafficProfile | undefined) : undefined;
  return {
    domain,
    source: 'similarweb-extension' as const,
    fetchedAt: s?.last_response_at?.toISOString() ?? null,
    requests: list.map((r) => ({
      kind: r.kind,
      status: lookupStatus(r.kind, r.requested_at, s),
      requestedAt: r.requested_at.toISOString(),
      attempts: s?.failures ?? 0,
      nextAttemptAt: s?.next_attempt_at?.toISOString() ?? null,
    })),
    traffic: traffic?.monthly.length
      ? {
          // The latest three months, as tag returned them.
          monthly: traffic.monthly.slice(-3),
          globalRank: profile?.globalRank ?? null,
          countryRank: profile?.countryRank ?? null,
          category: summary?.category ?? null,
          topCountries: profile?.countries ?? [],
        }
      : null,
    similarSites: summary?.similarSites ?? [],
  };
}

/**
 * Replaces a requester's standing list: domains not in `domains` stop being
 * watched for it (their history stays). Returns the accepted and refused names.
 */
export async function setWatchList(pool: Pool, requester: string, rawDomains: unknown, now = new Date()) {
  if (!Array.isArray(rawDomains) || rawDomains.length > MAX_WATCH) return { error: 'invalid_domains' as const };
  const accepted = [...new Set(rawDomains.map(publicDomain).filter((d): d is string => !!d))];
  const refused = rawDomains.filter((d) => !publicDomain(d)).map(String);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (accepted.length)
      await conn.query(
        'INSERT INTO watches (requester, domain, kind, requested_at) VALUES ? ON DUPLICATE KEY UPDATE requested_at = requested_at',
        [accepted.map((d) => [requester, d, 'watch', now])],
      );
    await conn.query(
      `DELETE FROM watches WHERE requester = ? AND kind = 'watch'${accepted.length ? ' AND domain NOT IN (?)' : ''}`,
      accepted.length ? [requester, accepted] : [requester],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return { watched: accepted.length, refused };
}

/** Fetch state of the given domains, for clients that mirror the data (tag). */
export async function fetchStates(pool: Pool, domains: string[]) {
  if (!domains.length) return new Map<string, State>();
  const list = await rows<State & { domain: string }>(pool, 'SELECT * FROM fetch_state WHERE domain IN (?)', [domains]);
  return new Map(list.map((r) => [r.domain, r]));
}

/** Requester for domains editors add by hand on /watch/. */
export const MANUAL = 'manual';
const MAX_ADD = 200;

/**
 * Adds domains to a requester's standing list without touching the rest (an
 * editor on /watch/, or a service adding one domain at a time). Re-adding
 * updates the note. `by` is the editor's email or the service.
 */
export async function addWatches(
  pool: Pool,
  requester: string,
  rawDomains: unknown,
  { by, note = null, now = new Date() }: { by: string; note?: string | null; now?: Date },
) {
  if (!Array.isArray(rawDomains) || !rawDomains.length || rawDomains.length > MAX_ADD) return { error: 'invalid_domains' as const };
  const accepted = [...new Set(rawDomains.map(publicDomain).filter((d): d is string => !!d))];
  const refused = rawDomains.filter((d) => !publicDomain(d)).map(String);
  const clean = note?.trim().slice(0, 255) || null;
  if (accepted.length) {
    await pool.query(
      `INSERT INTO watches (requester, domain, kind, requested_at, added_by, note) VALUES ?
       ON DUPLICATE KEY UPDATE note = COALESCE(VALUES(note), note)`,
      [accepted.map((d) => [requester, d, 'watch', now, by, clean])],
    );
    await pool.query('INSERT INTO watch_log (at, email, action, domain, note) VALUES ?', [
      accepted.map((d) => [now, by, `add:${requester}`.slice(0, 16), d, clean]),
    ]);
  }
  return { added: accepted, refused };
}

/** Removes one domain from a requester's standing list. */
export async function removeWatch(pool: Pool, requester: string, rawDomain: unknown, { by, now = new Date() }: { by: string; now?: Date }) {
  const domain = publicDomain(rawDomain);
  if (!domain) return { error: 'invalid_domain' as const };
  const [result] = (await pool.query("DELETE FROM watches WHERE requester = ? AND domain = ? AND kind = 'watch'", [
    requester,
    domain,
  ])) as unknown as [{ affectedRows: number }];
  if (result.affectedRows)
    await pool.query('INSERT INTO watch_log (at, email, action, domain) VALUES (?, ?, ?, ?)', [
      now,
      by,
      `del:${requester}`.slice(0, 16),
      domain,
    ]);
  return { removed: result.affectedRows > 0, domain };
}

export interface WatchRow {
  domain: string;
  requester: string;
  addedBy: string | null;
  note: string | null;
  requestedAt: Date;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  /** Similarweb answered (with or without visits). */
  lastResponseAt: Date | null;
  failures: number;
  lastError: string | null;
  latestMonth: string | null;
  latestVisits: number | null;
}

/** One requester's standing list with fetch state, newest additions first. */
export async function watchList(pool: Pool, requester: string): Promise<WatchRow[]> {
  const list = await rows<{
    domain: string;
    added_by: string | null;
    note: string | null;
    requested_at: Date;
    last_success_at: Date | null;
    last_attempt_at: Date | null;
    last_response_at: Date | null;
    failures: number | null;
    last_error: string | null;
    month: string | null;
    visits: number | null;
  }>(
    pool,
    `SELECT w.domain, w.added_by, w.note, w.requested_at,
       s.last_success_at, s.last_attempt_at, s.last_response_at, s.failures, s.last_error, m.month, m.visits
     FROM watches w
     LEFT JOIN fetch_state s ON s.domain = w.domain
     LEFT JOIN traffic_months m ON m.domain = w.domain AND m.month = (SELECT MAX(month) FROM traffic_months x WHERE x.domain = w.domain)
     WHERE w.requester = ? AND w.kind = 'watch'
     ORDER BY w.requested_at DESC, w.domain`,
    [requester],
  );
  return list.map((r) => ({
    domain: r.domain,
    requester,
    addedBy: r.added_by,
    note: r.note,
    requestedAt: r.requested_at,
    lastSuccessAt: r.last_success_at,
    lastAttemptAt: r.last_attempt_at,
    lastResponseAt: r.last_response_at,
    failures: r.failures ?? 0,
    lastError: r.last_error,
    latestMonth: r.month,
    latestVisits: r.visits === null ? null : Number(r.visits),
  }));
}
