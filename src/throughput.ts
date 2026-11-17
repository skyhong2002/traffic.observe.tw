import { type Pool, rows } from './db.ts';
export interface ThroughputEvent {
  domain: string;
  at: string;
  targetMonth: string | null;
  outcome: string;
  saved: boolean;
  complete: boolean;
  lane: string | null;
}
export function throughputReport(events: ThroughputEvent[], month: string, remaining: number, missingVisits: number, now = new Date()) {
  const since = (days: number) =>
    events.filter(
      (e) => e.targetMonth === month && Date.parse(e.at) >= now.getTime() - days * 86_400_000 && Date.parse(e.at) <= now.getTime(),
    );
  const count = (days: number, field: 'saved' | 'complete') =>
    new Set(
      since(days)
        .filter((e) => e.outcome === 'ok' && e[field])
        .map((e) => e.domain),
    ).size;
  const success24h = count(1, 'saved'),
    success7d = count(7, 'saved'),
    complete7d = count(7, 'complete');
  const eta = (left: number, successes: number) =>
    !left ? now.toISOString() : successes ? new Date(now.getTime() + (left / (successes / 7)) * 86_400_000).toISOString() : null;
  const last = since(1);
  return {
    month,
    remainingDomains: remaining,
    missingVisits,
    success24h,
    complete24h: count(1, 'complete'),
    success7d,
    complete7d,
    conditionalCompletionAt: eta(remaining, complete7d),
    conditionalVisitsAt: eta(missingVisits, success7d),
    assumption:
      'rolling 7-day distinct successful domains / 7 days; assumes unchanged throughput and no new domains; observations with unknown target outcome are excluded',
    zeroSuccessMeansUnknown: true,
    refused24h: last.filter((e) => e.outcome === 'refused').length,
    retryOccupancy24h: last.length ? last.filter((e) => e.lane === 'retry').length / last.length : null,
    lanes: Object.fromEntries(['missing', 'partial', 'retry', 'refresh'].map((lane) => [lane, last.filter((e) => e.lane === lane).length])),
    daily: Array.from({ length: 7 }, (_, i) => {
      const end = now.getTime() - (6 - i) * 86400000;
      const batch = since(7).filter((e) => Date.parse(e.at) > end - 86400000 && Date.parse(e.at) <= end);
      return {
        endingAt: new Date(end).toISOString(),
        requests: batch.length,
        success: new Set(batch.filter((e) => e.outcome === 'ok' && e.saved).map((e) => e.domain)).size,
        complete: new Set(batch.filter((e) => e.outcome === 'ok' && e.complete).map((e) => e.domain)).size,
        refused: batch.filter((e) => e.outcome === 'refused').length,
      };
    }),
    hourly: Array.from({ length: 24 }, (_, i) => {
      const end = now.getTime() - (23 - i) * 3_600_000;
      const batch = last.filter((e) => Date.parse(e.at) > end - 3_600_000 && Date.parse(e.at) <= end);
      return {
        endingAt: new Date(end).toISOString(),
        requests: batch.length,
        success: new Set(batch.filter((e) => e.outcome === 'ok' && e.saved).map((e) => e.domain)).size,
        refused: batch.filter((e) => e.outcome === 'refused').length,
      };
    }),
  };
}
export async function loadThroughput(pool: Pool, month: string, remaining: number, missingVisits: number, now = new Date()) {
  const events = await rows<{
    domain: string;
    at: Date;
    target_month: string | null;
    outcome: string;
    response_meta: string | Record<string, unknown> | null;
    queue_decision: string | Record<string, unknown> | null;
  }>(pool, 'SELECT domain, at, target_month, outcome, response_meta, queue_decision FROM sends WHERE at >= ? AND at <= ?', [
    new Date(now.getTime() - 7 * 86_400_000),
    now,
  ]);
  return throughputReport(
    events.map((r) => {
      const meta = typeof r.response_meta === 'string' ? JSON.parse(r.response_meta) : (r.response_meta ?? {});
      const decision = typeof r.queue_decision === 'string' ? JSON.parse(r.queue_decision) : (r.queue_decision ?? {});
      return {
        domain: r.domain,
        at: r.at.toISOString(),
        targetMonth: r.target_month,
        outcome: r.outcome,
        saved: meta.targetMonthSaved === true,
        complete: meta.targetMonthComplete === true,
        lane: (decision.policy as { lane?: string })?.lane ?? null,
      };
    }),
    month,
    remaining,
    missingVisits,
    now,
  );
}
