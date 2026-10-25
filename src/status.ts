import { type Pool, rows } from './db.ts';
import {
  type Candidate,
  catchUpQuota,
  coolingDown,
  dueQueue,
  lastMonthShare,
  loadCandidates,
  type MonthShare,
  type RunConfig,
} from './scheduler.ts';

const HOUR = 3_600_000;
/** The worker's next run at :runMinute that is not before `from`. */
function nextRunAt(from: Date, minute: number) {
  const at = new Date(from);
  at.setUTCSeconds(0, 0);
  at.setUTCMinutes(minute);
  if (at < from) at.setUTCHours(at.getUTCHours() + 1);
  return at;
}

/**
 * Everything due, in the order it will be sent, with the run expected to send it:
 * batches of `budget`, one per hour from the next run (after a cooldown, if one is on).
 */
export function fetchQueue(candidates: Candidate[], config: RunConfig, cooling: Date | null, now = new Date(), share?: MonthShare) {
  const first = nextRunAt(cooling && cooling > now ? cooling : now, config.runMinute);
  return dueQueue(candidates, now, share ? catchUpQuota(share, config.budget) : Infinity).map((c, i) => ({
    domain: c.domain,
    position: i + 1,
    requester: config.priority[c.tier] ?? null,
    reason: c.reason,
    lastSuccessAt: c.lastSuccess ? new Date(c.lastSuccess).toISOString() : null,
    expectedAt: config.budget ? new Date(first.getTime() + Math.floor(i / config.budget) * HOUR).toISOString() : null,
  }));
}
export type QueueEntry = ReturnType<typeof fetchQueue>[number];

/** The queue alone, for pages that only mark where a domain stands. */
export async function loadQueue(pool: Pool, config: RunConfig, now = new Date()) {
  const [candidates, cooling, share] = await Promise.all([
    loadCandidates(pool, config),
    coolingDown(pool, config, now),
    lastMonthShare(pool, now),
  ]);
  return fetchQueue(candidates, config, cooling, now, share);
}

/** Worker health for /status/ and /api/v1/status. */
export async function serviceStatus(pool: Pool, config: RunConfig, now = new Date()) {
  const [runs, watchers, sends, candidates, cooling, share] = await Promise.all([
    rows<{
      id: number;
      started_at: Date;
      finished_at: Date | null;
      budget: number;
      sent: number;
      ok: number;
      failed: number;
      refused: number;
      note: string | null;
    }>(pool, 'SELECT * FROM runs ORDER BY id DESC LIMIT 24'),
    rows<{ requester: string; kind: string; n: number }>(
      pool,
      'SELECT requester, kind, COUNT(*) AS n FROM watches GROUP BY requester, kind ORDER BY requester, kind',
    ),
    rows<{ outcome: string; n: number }>(pool, 'SELECT outcome, COUNT(*) AS n FROM sends WHERE at >= ? GROUP BY outcome', [
      new Date(now.getTime() - 86_400_000),
    ]),
    loadCandidates(pool, config),
    coolingDown(pool, config, now),
    lastMonthShare(pool, now),
  ]);
  const queue = fetchQueue(candidates, config, cooling, now, share);
  return {
    budget: config.budget,
    priority: config.priority,
    coolingDownUntil: cooling?.toISOString() ?? null,
    lastMonth: { ...share, catchUpPerRun: catchUpQuota(share, config.budget) },
    watched: candidates.length,
    due: queue.length,
    queue,
    watchers: watchers.map((w) => ({ requester: w.requester, kind: w.kind, domains: Number(w.n) })),
    last24h: Object.fromEntries(sends.map((s) => [s.outcome, Number(s.n)])),
    runs: runs.map((r) => ({
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
      budget: r.budget,
      sent: r.sent,
      ok: r.ok,
      failed: r.failed,
      refused: !!r.refused,
      note: r.note,
    })),
  };
}
