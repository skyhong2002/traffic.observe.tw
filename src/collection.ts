import { communityProfile, loadCommunity } from './contributor.ts';
import { latestCruxRanks } from './crux.ts';
import { type Pool, rows } from './db.ts';
import { loadManualMonths, manualProfile } from './manual.ts';
import { monthView, shiftMonth } from './metrics.ts';
import { baselineQueue, optimizedQueue, queueDecision } from './queue-plan.ts';
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
/**
 * Optional Similarweb channels. Small or sparse sites often have no measurable
 * share in these channels; an absent value therefore does not keep a month in
 * the collection queue. AI remains a required field.
 */
export const OPTIONAL_COLLECTION_CHANNELS = new Set(['SearchPaid', 'SocialPaid', 'Mail', 'Affiliate']);
/** A tag on at most this many collected sites is rare; such sites count RARE_TAG_BOOST times their traffic in the queue. */
export const RARE_TAG_SITES = 20;
export const RARE_TAG_BOOST = 10;
/** Catch-all labels that say nothing about the topic. */
const COMMON_TAGS = new Set(['其他', '非台灣']);
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
      trafficChannels
        .filter((key) => !OPTIONAL_COLLECTION_CHANNELS.has(key))
        .map((key) => [`channels.${key}`, profiles.some((p) => measured(p?.channels?.[key]) && p!.channels![key]! <= 1)]),
    ),
  };
  return { fields, missing: Object.keys(fields).filter((key) => !fields[key]) };
}

export async function syncCollections(pool: Pool, config: RunConfig, now = new Date()) {
  const month = collectionMonth(config, now);
  if (config.queueOptimization)
    await pool.query('INSERT IGNORE INTO queue_canaries (id, started_at, expires_at) VALUES (?, ?, ?)', [
      config.queueCanary,
      now,
      new Date(now.getTime() + config.queueCanaryHours * 3_600_000),
    ]);
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
  const [canary] = config.queueOptimization
    ? await rows<{ rolled_back_at: Date | null; expires_at: Date }>(
        pool,
        'SELECT rolled_back_at, expires_at FROM queue_canaries WHERE id = ?',
        [config.queueCanary],
      )
    : [];
  const optimized = config.queueOptimization && !!canary && !canary.rolled_back_at && canary.expires_at > now;
  if (!validCollectionMonth(month)) throw Error('Invalid collection month');
  const [domains, traffic, profiles, manual, overrides, attempts, states, before, provider, [allocation], requests, crux, community] =
    await Promise.all([
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
      rows<{
        domain: string;
        attempts: number;
        old_month_attempts: number;
        last_attempt_at: Date | null;
        last_result: string | null;
        enrolled_at: Date;
      }>(
        pool,
        'SELECT domain, attempts, old_month_attempts, last_attempt_at, last_result, enrolled_at FROM collection_domains WHERE month = ?',
        [month],
      ),
      rows<{ domain: string; next_attempt_at: Date | null }>(pool, 'SELECT domain, next_attempt_at FROM fetch_state'),
      monthView(pool, shiftMonth(month, -1)),
      rows<{ domain: string; month: string }>(pool, 'SELECT domain, MAX(month) AS month FROM traffic_profiles GROUP BY domain'),
      rows<{ n: number }>(pool, 'SELECT COUNT(*) AS n FROM sends WHERE target_month = ?', [month]),
      rows<{ domain: string; at: Date; outcome: string; http_status: number | null }>(
        pool,
        `SELECT s.domain, s.at, s.outcome, s.http_status FROM sends s
       JOIN (SELECT MAX(id) AS id FROM sends WHERE target_month = ? GROUP BY domain) latest USING (id)`,
        [month],
      ),
      latestCruxRanks(pool),
      loadCommunity(pool, [month]),
    ]);
  const communityRows = new Map(community.map((r) => [r.domain, r]));
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
  // Tags few collected sites carry: their sites go ahead of equally popular ones, so the month
  // covers every topic early instead of only the biggest ones.
  const tagSites = new Map<string, number>();
  for (const { domain } of domains) for (const tag of history.get(domain)?.topics ?? []) tagSites.set(tag, (tagSites.get(tag) ?? 0) + 1);
  const rareTags = (domain: string) =>
    (history.get(domain)?.topics ?? []).filter((tag) => !COMMON_TAGS.has(tag) && (tagSites.get(tag) ?? 0) <= RARE_TAG_SITES);
  const queueScore = (domain: string) => score(domain) * (rareTags(domain).length ? RARE_TAG_BOOST : 1);
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
      const contribution = communityRows.get(domain);
      const coverage = coverageFields(visits.get(domain) || hand?.visits || contribution?.payload.visits || null, [
        profile.get(domain) ?? null,
        hand ? manualProfile(hand) : null,
        contribution ? communityProfile(contribution) : null,
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
      const updated = Math.max(Date.parse(trafficAt.get(domain) ?? '') || 0, Date.parse(profileAt.get(domain) ?? '') || 0);
      const refresh =
        optimized &&
        complete &&
        !hand &&
        !contribution &&
        updated > 0 &&
        now.getTime() - updated >= config.collectionRefreshHours * 3_600_000 &&
        (!latestMonth || latestMonth <= month) &&
        budgetAttempts < config.collectionMaxAttempts;
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
        /** Tags held by at most RARE_TAG_SITES collected sites; they multiply queueScore. */
        rareTags: rareTags(domain),
        queueScore: queueScore(domain),
        /** Chrome UX Report Taiwan bucket in the latest CrUX month (top N), null when absent. */
        cruxRank: crux.get(domain) ?? null,
        ...coverage,
        complete,
        status,
        attempts: count,
        budgetAttempts,
        lastAttemptAt: attempt?.last_attempt_at?.toISOString() ?? null,
        lastResult: attempt?.last_result ?? null,
        nextAttemptAt: nextAt > now.getTime() && !manualNeeded && !complete ? new Date(nextAt).toISOString() : null,
        automatic: (!complete || refresh) && !manualNeeded && nextAt <= now.getTime(),
        enrolledAt: attempt?.enrolled_at?.toISOString() ?? `${month.slice(0, 4)}-${month.slice(4)}-01T00:00:00Z`,
        hasAutomatic: profile.has(domain) || (visits.get(domain) ?? 0) > 0,
        hasManual: !!hand,
        hasCommunity: !!contribution,
        communityProvenance: contribution
          ? { sourceNode: contribution.sourceNode, fetchedAt: contribution.fetchedAt, payloadHash: contribution.payloadHash }
          : null,
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
        b.queueScore - a.queueScore ||
        // Without last month's Similarweb numbers, Chrome's Taiwan popularity picks who goes first.
        (a.cruxRank ?? 1e12) - (b.cruxRank ?? 1e12) ||
        (a.lastAttemptAt ?? '').localeCompare(b.lastAttemptAt ?? '') ||
        a.domain.localeCompare(b.domain),
    );
  let queue = baselineQueue(entries, Number(allocation?.n ?? 0));
  if (optimized) queue = optimizedQueue(entries, Number(allocation?.n ?? 0), now);
  const decisions = new Map(
    queue.map((e) => [
      e.domain,
      {
        ...queueDecision(e, now),
        policy: optimized ? 'fair-v1' : 'baseline',
        canary: config.queueCanary,
        reservedCycle: ['missing', 'partial', 'missing', 'retry', 'refresh'],
      },
    ]),
  );
  const explainedEntries = entries.map((e) => ({ ...e, decision: decisions.get(e.domain) ?? null }));
  const explainedQueue = queue.map((e) => ({ ...e, decision: decisions.get(e.domain)! }));
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
    entries: explainedEntries,
    queue: explainedQueue,
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
  entries: collection.entries.map(({ score: _score, queueScore: _queueScore, fields, ...entry }) => ({
    ...entry,
    availableFields: Object.keys(fields).filter((key) => fields[key]),
  })),
});
