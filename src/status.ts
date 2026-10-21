import { type Pool, rows } from './db.ts';
import { coolingDown, dueDomains, loadCandidates, type RunConfig } from './scheduler.ts';

/** Worker health for /status/ and /api/v1/status. */
export async function serviceStatus(pool: Pool, config: RunConfig, now = new Date()) {
  const [runs, watchers, sends, candidates, cooling] = await Promise.all([
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
  ]);
  return {
    budget: config.budget,
    priority: config.priority,
    coolingDownUntil: cooling?.toISOString() ?? null,
    watched: candidates.length,
    due: dueDomains(candidates, now).length,
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
