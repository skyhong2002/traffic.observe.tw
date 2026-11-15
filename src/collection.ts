import { type Pool, rows } from './db.ts';
import { loadManualMonths, manualProfile } from './manual.ts';
import { monthView, shiftMonth } from './metrics.ts';
import type { RunConfig } from './scheduler.ts';
import { type TrafficProfile, trafficChannels } from './similarweb.ts';

export const PRIORITY_LABELS = ['自動', '必抓', '核心', '台灣', '其他'];
export const FIELD_LABELS: Record<string, string> = {
  visits: '造訪量',
  countries: '國家占比',
  bounceRate: '跳出率',
  pagesPerVisit: '每次頁數',
  timeOnSite: '停留時間',
  ...Object.fromEntries(trafficChannels.map((c) => [`channels.${c}`, `渠道 ${c}`])),
};
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const measured = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export const validCollectionMonth = (v: unknown): v is string => typeof v === 'string' && /^20\d{2}(0[1-9]|1[0-2])$/.test(v);
export function collectionMonth(config: Pick<RunConfig, 'targetMonth'>, now = new Date()) {
  const current = now.toISOString().slice(0, 7).replace('-', '');
  if (config.targetMonth && config.targetMonth >= current) throw Error('Collection target must be a past month');
  return config.targetMonth ?? shiftMonth(current, -1);
}

/** Missing values stay unknown. A zero share or zero duration is still a reported value. */
export function coverageFields(visits: number | null, profiles: Array<Partial<TrafficProfile> | null>) {
  const has = (key: keyof TrafficProfile) => profiles.some((p) => measured(p?.[key]));
  const fields: Record<string, boolean> = {
    visits: visits !== null && Number.isFinite(visits) && visits > 0,
    countries: profiles.some((p) => p?.countries?.some((c) => /^[A-Z]{2}$/.test(c.code) && measured(c.share) && c.share <= 1)) || false,
    bounceRate: profiles.some((p) => measured(p?.bounceRate) && p!.bounceRate! <= 1),
    pagesPerVisit: has('pagesPerVisit'),
    timeOnSite: has('timeOnSite'),
    ...Object.fromEntries(
      trafficChannels.map((key) => [`channels.${key}`, profiles.some((p) => measured(p?.channels?.[key]) && p!.channels![key]! <= 1)]),
    ),
  };
  return { fields, missing: Object.keys(fields).filter((key) => !fields[key]) };
}

export async function syncCollections(pool: Pool, config: RunConfig, now = new Date()) {
  const month = collectionMonth(config, now);
  await pool.query('INSERT IGNORE INTO collection_months (month, created_at) VALUES (?, ?)', [month, now]);
  await pool.query(
    `INSERT IGNORE INTO collection_domains (month, domain, enrolled_at)
     SELECT ?, domain, ? FROM watches WHERE kind = 'watch' GROUP BY domain`,
    [month, now],
  );
}

/** Also lists the current virtual collection before its first worker run; reads never enqueue requests. */
export async function collectionMonths(pool: Pool, config: RunConfig, now = new Date()) {
  return [
    ...new Set([
      collectionMonth(config, now),
      ...(await rows<{ month: string }>(pool, 'SELECT month FROM collection_months')).map((r) => r.month),
    ]),
  ]
    .sort()
    .reverse();
}

export async function loadCollection(pool: Pool, config: RunConfig, month = collectionMonth(config), now = new Date()) {
  if (!validCollectionMonth(month)) throw Error('Invalid collection month');
  const [domains, traffic, profiles, manual, overrides, attempts, states, before, provider, [allocation], requests] = await Promise.all([
    rows<{ domain: string; sources: string | null }>(
      pool,
      `SELECT d.domain, GROUP_CONCAT(DISTINCT w.requester ORDER BY w.requester) AS sources
       FROM (SELECT domain FROM collection_domains WHERE month = ? UNION SELECT domain FROM watches WHERE kind = 'watch') d
       LEFT JOIN watches w ON w.domain = d.domain AND w.kind = 'watch' GROUP BY d.domain`,
      [month],
    ),
    rows<{ domain: string; visits: number; fetched_at: Date }>(
      pool,
      'SELECT domain, visits, fetched_at FROM traffic_months WHERE month = ?',
      [month],
    ),
    rows<{ domain: string; profile: unknown; fetched_at: Date }>(
      pool,
      'SELECT domain, profile, fetched_at FROM traffic_profiles WHERE month = ?',
      [month],
    ),
    loadManualMonths(pool, { months: [month] }),
    rows<{ domain: string; priority: number }>(pool, 'SELECT domain, priority FROM collection_priorities'),
    rows<{ domain: string; attempts: number; old_month_attempts: number; last_attempt_at: Date | null; last_result: string | null }>(
      pool,
      'SELECT domain, attempts, old_month_attempts, last_attempt_at, last_result FROM collection_domains WHERE month = ?',
      [month],
    ),
    rows<{ domain: string; next_attempt_at: Date | null }>(pool, 'SELECT domain, next_attempt_at FROM fetch_state'),
    monthView(pool, shiftMonth(month, -1)),
    rows<{ domain: string; month: string }>(pool, 'SELECT domain, MAX(month) AS month FROM traffic_profiles GROUP BY domain'),
    rows<{ n: number }>(pool, "SELECT COUNT(*) AS n FROM sends WHERE target_month = ? AND outcome <> 'refused'", [month]),
    rows<{ domain: string; at: Date; outcome: string; http_status: number | null }>(
      pool,
      `SELECT s.domain, s.at, s.outcome, s.http_status FROM sends s
       JOIN (SELECT MAX(id) AS id FROM sends WHERE target_month = ? GROUP BY domain) latest USING (id)`,
      [month],
    ),
  ]);
  const visits = new Map(traffic.map((r) => [r.domain, Number(r.visits)]));
  const profile = new Map(profiles.map((r) => [r.domain, parse<Partial<TrafficProfile>>(r.profile)]));
  const hands = new Map(manual.map((r) => [r.domain, r]));
  const pinned = new Map(overrides.map((r) => [r.domain, r.priority]));
  const tried = new Map(attempts.map((r) => [r.domain, r]));
  const next = new Map(states.map((r) => [r.domain, r.next_attempt_at]));
  const history = new Map(before.map((r) => [r.domain, r]));
  const latest = new Map(provider.map((r) => [r.domain, r.month]));
  const lastRequests = new Map(requests.map((r) => [r.domain, r]));
  const trafficAt = new Map(traffic.map((r) => [r.domain, r.fetched_at.toISOString()]));
  const profileAt = new Map(profiles.map((r) => [r.domain, r.fetched_at.toISOString()]));
  const domestic = (domain: string) => {
    const h = history.get(domain);
    return !h?.topics.includes('非台灣') && (domain.endsWith('.tw') || (h?.taiwanShareUsed ?? 0) >= 0.5);
  };
  const score = (domain: string) => {
    const h = history.get(domain);
    return (h?.visits ?? 0) * (h?.taiwanShareUsed ?? (domain.endsWith('.tw') ? 1 : 0));
  };
  const core = new Set(
    domains
      .filter((r) => domestic(r.domain))
      .sort((a, b) => score(b.domain) - score(a.domain) || a.domain.localeCompare(b.domain))
      .slice(0, config.coreDomains)
      .map((r) => r.domain),
  );
  const targetPublished = provider.some((p) => p.month >= month);
  const entries = domains
    .map(({ domain, sources }) => {
      const hand = hands.get(domain);
      const coverage = coverageFields(visits.get(domain) || hand?.visits || null, [
        profile.get(domain) ?? null,
        hand ? manualProfile(hand) : null,
      ]);
      const attempt = tried.get(domain);
      const request = lastRequests.get(domain);
      const count = Number(attempt?.attempts ?? 0);
      const budgetAttempts = count - Number(attempt?.old_month_attempts ?? 0);
      // A newer month on another domain does not prove this domain has advanced.
      const latestMonth = latest.get(domain);
      const unavailable = !coverage.fields.visits
        ? month < shiftMonth([latestMonth ?? '', collectionMonth(config, now)].sort().at(-1)!, -2)
        : !!latestMonth && latestMonth > month;
      const complete = coverage.missing.length === 0;
      const manualNeeded = !complete && (unavailable || budgetAttempts >= config.collectionMaxAttempts);
      const retryHours = !targetPublished && attempt?.last_result === 'old-month' ? config.probeIntervalHours : config.collectionRetryHours;
      const retryAt = count && attempt?.last_attempt_at ? new Date(attempt.last_attempt_at.getTime() + retryHours * 3_600_000) : null;
      const nextAt = Math.max(next.get(domain)?.getTime() ?? 0, retryAt?.getTime() ?? 0);
      const priority = pinned.get(domain) ?? (core.has(domain) ? 2 : domestic(domain) ? 3 : 4);
      const status = complete
        ? ('complete' as const)
        : manualNeeded
          ? ('manual-needed' as const)
          : nextAt > now.getTime()
            ? ('retry-wait' as const)
            : count
              ? ('retry' as const)
              : ('pending' as const);
      return {
        domain,
        month,
        name: history.get(domain)?.name ?? domain,
        sources: sources?.split(',') ?? [],
        priority,
        priorityLabel: PRIORITY_LABELS[priority],
        priorityOverride: pinned.get(domain) ?? 0,
        score: score(domain),
        ...coverage,
        complete,
        status,
        attempts: count,
        budgetAttempts,
        lastAttemptAt: attempt?.last_attempt_at?.toISOString() ?? null,
        lastResult: attempt?.last_result ?? null,
        nextAttemptAt: nextAt > now.getTime() && !manualNeeded && !complete ? new Date(nextAt).toISOString() : null,
        automatic: !complete && !manualNeeded && nextAt <= now.getTime(),
        hasAutomatic: profile.has(domain) || (visits.get(domain) ?? 0) > 0,
        hasManual: !!hand,
        automaticVisitsAt: trafficAt.get(domain) ?? null,
        automaticProfileAt: profileAt.get(domain) ?? null,
        manualUpdatedAt: hand?.updatedAt ?? null,
        lastRequestAt: request?.at.toISOString() ?? null,
        lastRequestOutcome: request?.outcome ?? null,
        lastRequestHttpStatus: request?.http_status ?? null,
      };
    })
    .sort(
      (a, b) =>
        Number(a.hasManual) - Number(b.hasManual) ||
        a.priority - b.priority ||
        Number(a.attempts > 0) - Number(b.attempts > 0) ||
        b.score - a.score ||
        (a.lastAttemptAt ?? '').localeCompare(b.lastAttemptAt ?? '') ||
        a.domain.localeCompare(b.domain),
    );
  // Reserve every fifth slot for retries; new work still gets most of the allowance.
  const fresh = entries.filter((e) => e.automatic && !e.attempts);
  const retry = entries.filter((e) => e.automatic && e.attempts);
  const queue: typeof entries = [];
  while (fresh.length || retry.length)
    queue.push(
      ((Number(allocation?.n ?? 0) + queue.length + 1) % 5 === 0 && retry.length ? retry.shift() : (fresh.shift() ?? retry.shift()))!,
    );
  // Manual coverage lowers urgency even when a reserved retry slot is due.
  // Stable sorting preserves the allocation order within each group.
  queue.sort((a, b) => Number(a.hasManual) - Number(b.hasManual));
  const summary = {
    total: entries.length,
    complete: entries.filter((e) => e.complete).length,
    withVisits: entries.filter((e) => e.fields.visits).length,
    partial: entries.filter((e) => e.fields.visits && !e.complete).length,
    missingVisits: entries.filter((e) => !e.fields.visits).length,
    manualNeeded: entries.filter((e) => e.status === 'manual-needed').length,
    waitingRetry: entries.filter((e) => e.status === 'retry-wait').length,
    eligible: queue.length,
    priorities: [1, 2, 3, 4].map((priority) => ({
      priority,
      label: PRIORITY_LABELS[priority],
      total: entries.filter((e) => e.priority === priority).length,
      complete: entries.filter((e) => e.priority === priority && e.complete).length,
    })),
  };
  return {
    month,
    summary,
    entries,
    queue,
    settings: { coreDomains: config.coreDomains, maxAttempts: config.collectionMaxAttempts, retryHours: config.collectionRetryHours },
  };
}
export type Collection = Awaited<ReturnType<typeof loadCollection>>;
export type CollectionEntry = Collection['entries'][number];

export async function recordCollectionAttempt(pool: Pool, month: string, domain: string, at: Date, outcome: string) {
  // Refusals belong to the provider-wide cooldown, not a domain's retry budget.
  if (outcome === 'refused') return;
  await pool.query(
    `INSERT INTO collection_domains (month, domain, enrolled_at, attempts, old_month_attempts, last_attempt_at, last_result) VALUES (?, ?, ?, 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE attempts = attempts + 1, old_month_attempts = old_month_attempts + VALUES(old_month_attempts), last_attempt_at = VALUES(last_attempt_at), last_result = VALUES(last_result)`,
    [month, domain, at, outcome === 'old-month' ? 1 : 0, at, outcome],
  );
}

export async function setCollectionPriority(pool: Pool, domain: string, priority: number, by: string) {
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) throw Error('Invalid collection priority');
  const [known] = await rows<{ n: number }>(pool, 'SELECT COUNT(*) AS n FROM watches WHERE domain = ?', [domain]);
  if (!Number(known?.n)) throw Error('Unknown collection domain');
  if (!priority) await pool.query('DELETE FROM collection_priorities WHERE domain = ?', [domain]);
  else
    await pool.query(
      'INSERT INTO collection_priorities (domain,priority,updated_at,updated_by) VALUES (?,?,UTC_TIMESTAMP(),?) ON DUPLICATE KEY UPDATE priority=VALUES(priority),updated_at=VALUES(updated_at),updated_by=VALUES(updated_by)',
      [domain, priority, by],
    );
}

export const publicCollection = (collection: Collection) => ({
  month: collection.month,
  summary: collection.summary,
  settings: collection.settings,
  entries: collection.entries.map(({ score: _score, fields, ...entry }) => ({
    ...entry,
    availableFields: Object.keys(fields).filter((key) => fields[key]),
  })),
});
