import { collectionMonth } from './collection.ts';
import { type Pool, rows } from './db.ts';
import { backoffState, recoveryAllowance } from './provider-backoff.ts';
import type { RunConfig } from './scheduler.ts';

const DAY = 86_400_000;

/** The extension's local counter uses ISO weeks in UTC, starting Monday. */
export function utcWeek(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return { start, end: new Date(start.getTime() + 7 * DAY) };
}

/** Respect a provider's retry time across restarts, as well as the ordinary refusal cooldown. */
export async function coolingDown(pool: Pool, config: RunConfig, now = new Date()) {
  const [r] = await rows<{ refused: Date | null; retry: Date | null }>(
    pool,
    'SELECT MAX(refused_at) AS refused, MAX(retry_after_at) AS retry FROM fetch_state',
  );
  const adaptive = await backoffState(pool, config);
  const until = Math.max(
    adaptive?.phase !== 'closed' ? (adaptive?.next_attempt_at?.getTime() ?? 0) : 0,
    r?.refused ? r.refused.getTime() + config.cooldownMinutes * 60_000 : 0,
    r?.retry?.getTime() ?? 0,
  );
  return until > now.getTime() ? new Date(until) : null;
}

/** Local policy, not the provider's quota. A runner may supply its own queue's first-fetch count (including manual domains). */
export async function fetchPolicy(pool: Pool, config: RunConfig, now = new Date(), initialPending?: number) {
  const { start, end } = utcWeek(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const target = collectionMonth(config, now);
  const hourStart = new Date(now.getTime() - 3_600_000);
  const [[usage], [latest], [profile], [attempt], [initial], cooling, [hour], [lastSend], recovery] = await Promise.all([
    rows<{ used: number }>(pool, 'SELECT COUNT(*) AS used FROM sends WHERE at >= ? AND at < ?', [start, end]),
    rows<{ month: string | null }>(pool, 'SELECT MAX(month) AS month FROM traffic_months'),
    rows<{ month: string | null }>(pool, 'SELECT MAX(month) AS month FROM traffic_profiles'),
    rows<{ at: Date | null }>(pool, 'SELECT MAX(at) AS at FROM sends WHERE at >= ? AND at <= ?', [monthStart, now]),
    initialPending === undefined
      ? rows<{ n: number }>(
          pool,
          `SELECT COUNT(DISTINCT w.domain) AS n FROM watches w LEFT JOIN fetch_state f USING(domain)
           WHERE f.last_attempt_at IS NULL AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= ?)`,
          [now],
        )
      : Promise.resolve([{ n: initialPending }]),
    coolingDown(pool, config, now),
    rows<{ used: number; oldest: Date | null }>(pool, 'SELECT COUNT(*) AS used,MIN(at) AS oldest FROM sends WHERE at > ? AND at <= ?', [
      hourStart,
      now,
    ]),
    rows<{ at: Date | null }>(pool, 'SELECT MAX(at) AS at FROM sends WHERE at <= ?', [now]),
    recoveryAllowance(pool, config, now),
  ]);
  const used = Number(usage?.used ?? 0);
  const remaining = config.weeklyBudget === null ? null : Math.max(0, config.weeklyBudget - used);
  const waitingForMonth = (profile?.month ?? '') < target;
  const initialDomains = config.collectionEnabled ? 0 : Number(initial?.n ?? 0);
  const hourlyUsed = Number(hour?.used ?? 0);
  const hourlyRemaining = Math.max(0, config.hourlyBudget - hourlyUsed);
  const hourAt = hour?.oldest ? new Date(hour.oldest.getTime() + 3_600_000) : null;
  const spacingAt = lastSend?.at ? new Date(lastSend.at.getTime() + config.minIntervalSeconds * 1000) : null;
  const probeAt = waitingForMonth && attempt?.at ? new Date(attempt.at.getTime() + config.probeIntervalHours * 3_600_000) : null;
  const holds = [
    ...(recovery?.budgetResumesAt ? [{ reason: 'recovery-probe-limit' as const, at: new Date(recovery.budgetResumesAt) }] : []),
    ...(recovery?.spacingUntil && new Date(recovery.spacingUntil) > now
      ? [{ reason: 'request-spacing' as const, at: new Date(recovery.spacingUntil) }]
      : []),
    ...(remaining === 0 ? [{ reason: 'weekly-limit' as const, at: end }] : []),
    ...(hourlyRemaining === 0 && hourAt ? [{ reason: 'hourly-limit' as const, at: hourAt }] : []),
    ...(spacingAt && spacingAt > now ? [{ reason: 'request-spacing' as const, at: spacingAt }] : []),
    ...(cooling ? [{ reason: 'provider-cooldown' as const, at: cooling }] : []),
    ...(probeAt && probeAt > now && !initialDomains ? [{ reason: 'waiting-for-month' as const, at: probeAt }] : []),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const disabled = config.budget === 0 || config.weeklyBudget === 0 || config.hourlyBudget === 0;
  const reason = disabled
    ? 'disabled'
    : cooling
      ? 'provider-cooldown'
      : remaining === 0
        ? 'weekly-limit'
        : hourlyRemaining === 0
          ? 'hourly-limit'
          : (holds.at(0)?.reason ?? null);
  return {
    reason,
    resumeAt: disabled ? null : (holds[0]?.at.toISOString() ?? null),
    maxPerRun: reason
      ? 0
      : Math.min(
          config.budget,
          remaining ?? config.budget,
          hourlyRemaining,
          config.minIntervalSeconds || recovery ? 1 : config.budget,
          waitingForMonth ? initialDomains || 1 : config.budget,
        ),
    recovery,
    weekly: { limit: config.weeklyBudget, used, remaining, startsAt: start.toISOString(), resetsAt: end.toISOString() },
    hourly: { limit: config.hourlyBudget, used: hourlyUsed, remaining: hourlyRemaining },
    minIntervalSeconds: config.minIntervalSeconds,
    waitingForMonth,
    initialPending: initialDomains,
    nextProbeAt: probeAt?.toISOString() ?? null,
    targetMonth: target,
    latestMonth: latest?.month ?? null,
    latestProfileMonth: profile?.month ?? null,
    probeIntervalHours: config.probeIntervalHours,
    coolingDownUntil: cooling?.toISOString() ?? null,
  };
}

export type FetchPolicy = Awaited<ReturnType<typeof fetchPolicy>>;

export function policyNote(policy: FetchPolicy) {
  const until = policy.resumeAt ? ` until ${policy.resumeAt}` : '';
  switch (policy.reason) {
    case 'disabled':
      return 'Similarweb fetching is disabled';
    case 'weekly-limit':
      return `weekly request limit reached${until}`;
    case 'recovery-probe-limit':
      return `recovery probe budget reached${until}`;
    case 'hourly-limit':
      return `hourly request limit reached${until}`;
    case 'request-spacing':
      return `request spacing${until}`;
    case 'provider-cooldown':
      return `cooling down${until}`;
    case 'waiting-for-month':
      return `waiting for ${policy.targetMonth}; next probe${until}`;
    default:
      return null;
  }
}
