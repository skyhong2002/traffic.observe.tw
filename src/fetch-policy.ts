import { type Pool, rows } from './db.ts';
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
  const until = Math.max(r?.refused ? r.refused.getTime() + config.cooldownMinutes * 60_000 : 0, r?.retry?.getTime() ?? 0);
  return until > now.getTime() ? new Date(until) : null;
}

/** Local conservative policy, not a claim about the data server's actual quota. */
export async function fetchPolicy(pool: Pool, config: RunConfig, now = new Date()) {
  const { start, end } = utcWeek(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const target = `${previous.getUTCFullYear()}${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
  const [[usage], [latest], [profile], [attempt], cooling] = await Promise.all([
    rows<{ used: number }>(pool, 'SELECT COUNT(*) AS used FROM sends WHERE at >= ? AND at < ?', [start, end]),
    rows<{ month: string | null }>(pool, 'SELECT MAX(month) AS month FROM traffic_months'),
    rows<{ month: string | null }>(pool, 'SELECT MAX(month) AS month FROM traffic_profiles'),
    rows<{ at: Date | null }>(pool, 'SELECT MAX(at) AS at FROM sends WHERE at >= ? AND at <= ?', [monthStart, now]),
    coolingDown(pool, config, now),
  ]);
  const used = Number(usage?.used ?? 0);
  const remaining = config.weeklyBudget === null ? null : Math.max(0, config.weeklyBudget - used);
  const waitingForMonth = (profile?.month ?? '') < target;
  const probeAt = waitingForMonth && attempt?.at ? new Date(attempt.at.getTime() + config.probeIntervalHours * 3_600_000) : null;
  const holds = [
    ...(remaining === 0 ? [{ reason: 'weekly-limit' as const, at: end }] : []),
    ...(cooling ? [{ reason: 'provider-cooldown' as const, at: cooling }] : []),
    ...(probeAt && probeAt > now ? [{ reason: 'waiting-for-month' as const, at: probeAt }] : []),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const disabled = config.budget === 0 || config.weeklyBudget === 0;
  const reason = disabled ? 'disabled' : cooling ? 'provider-cooldown' : remaining === 0 ? 'weekly-limit' : (holds[0]?.reason ?? null);
  return {
    reason,
    resumeAt: disabled ? null : (holds[0]?.at.toISOString() ?? null),
    maxPerRun: reason ? 0 : Math.min(config.budget, remaining ?? config.budget, waitingForMonth ? 1 : config.budget),
    weekly: { limit: config.weeklyBudget, used, remaining, startsAt: start.toISOString(), resetsAt: end.toISOString() },
    waitingForMonth,
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
    case 'provider-cooldown':
      return `cooling down${until}`;
    case 'waiting-for-month':
      return `waiting for ${policy.targetMonth}; next probe${until}`;
    default:
      return null;
  }
}
