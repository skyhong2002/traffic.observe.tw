import { expect, it } from 'vitest';
import { backtestQueue, baselineQueue, optimizedQueue, type QueueSite, queueDecision, queueLane } from '../src/queue-plan.ts';
import { type ThroughputEvent, throughputReport } from '../src/throughput.ts';

const now = new Date('2026-11-17T12:00:00Z');
const site = (domain: string, extra: Partial<QueueSite> = {}): QueueSite => ({
  domain,
  priority: 3,
  score: 1,
  rareTags: [],
  cruxRank: null,
  fields: { visits: false, countries: false },
  complete: false,
  attempts: 0,
  lastAttemptAt: null,
  enrolledAt: '2026-11-16T00:00:00Z',
  automatic: true,
  automaticVisitsAt: null,
  manualUpdatedAt: null,
  hasManual: false,
  ...extra,
});
it('reserves all four lanes across one-request worker restarts', () => {
  const entries = [
    site('missing'),
    site('partial', { fields: { visits: true, countries: false } }),
    site('retry', { attempts: 1 }),
    site('refresh', { complete: true }),
  ];
  expect(entries.map(queueLane)).toEqual(['missing', 'partial', 'retry', 'refresh']);
  expect(Array.from({ length: 5 }, (_, i) => queueLane(optimizedQueue(entries, i, now)[0]))).toEqual([
    'missing',
    'partial',
    'missing',
    'retry',
    'refresh',
  ]);
  expect(queueDecision(entries[1], now).components.missingFields).toBe(1);
});
it('services aging low-priority work despite continuous higher-traffic arrivals in each lane', () => {
  for (const partial of [false, true]) {
    const old = site('old-low.tw', { priority: 4, fields: { visits: partial }, enrolledAt: '2026-11-01T00:00:00Z' });
    const arrivals = Array.from({ length: 100 }, (_, i) =>
      site(`new-${i}.tw`, { priority: 1, score: 1000000, fields: { visits: partial } }),
    );
    const queue = optimizedQueue([...arrivals, old], 0, now);
    expect(queue.findIndex((e) => e.domain === old.domain)).toBe(0);
  }
});
it('preserves priority and value when overdue sites joined in the same batch', () => {
  const enrolledAt = '2026-11-01T00:00:00Z';
  const entries = [
    site('a-low.tw', { priority: 4, score: 1000, enrolledAt }),
    site('z-core.tw', { priority: 2, score: 1, enrolledAt }),
    site('b-small.tw', { priority: 3, score: 1, enrolledAt }),
    site('y-large.tw', { priority: 3, score: 100, enrolledAt }),
  ];
  expect(optimizedQueue(entries, 0, now).map((e) => e.domain)).toEqual(['z-core.tw', 'y-large.tw', 'b-small.tw', 'a-low.tw']);
});
it('keeps the rare-tag baseline and uses recorded failures instead of assuming every attempt completes', () => {
  const entries = [
    site('large', { score: 100 }),
    site('rare', { score: 20, rareTags: ['rare'] }),
    site('partial', { attempts: 1, fields: { visits: true } }),
  ];
  expect(baselineQueue(entries)[0].domain).toBe('rare');
  const outcomes = [
    { domain: 'rare', at: '2026-11-16T00:00:00Z', saved: false, complete: false, refused: true },
    { domain: 'large', at: '2026-11-16T01:00:00Z', saved: true, complete: true },
  ];
  const reports = backtestQueue(entries, 1, now, outcomes);
  expect(reports.find((r) => r.strategy === 'baseline')).toMatchObject({
    selected: ['rare'],
    completedDomains: 0,
    refusals: 1,
    rareTagCoverage: 0,
  });
  expect(reports.find((r) => r.strategy === 'traffic')).toMatchObject({ selected: ['large'], completedDomains: 1, refusals: 0 });
  expect(backtestQueue(entries, 1, now, outcomes)).toEqual(reports);
});
it('counts unique target-month successes, excludes unknown/old/future outcomes and leaves zero-throughput ETA unknown', () => {
  const event = (extra: Partial<ThroughputEvent> = {}): ThroughputEvent => ({
    domain: 'a.tw',
    at: '2026-11-17T11:00:00Z',
    targetMonth: '202610',
    outcome: 'ok',
    saved: true,
    complete: true,
    lane: 'missing',
    ...extra,
  });
  const report = throughputReport(
    [
      event(),
      event(),
      event({ domain: 'old.tw', targetMonth: '202609' }),
      event({ domain: 'future.tw', at: '2026-11-18T00:00:00Z' }),
      event({ domain: 'bad.tw', outcome: 'refused', lane: 'retry', saved: false, complete: false }),
      event({ domain: 'unknown.tw', saved: false, complete: false }),
    ],
    '202610',
    10,
    20,
    now,
  );
  expect(report).toMatchObject({ success24h: 1, success7d: 1, complete7d: 1, refused24h: 1, retryOccupancy24h: 0.25 });
  expect(report.conditionalCompletionAt).toBe('2027-01-26T12:00:00.000Z');
  expect(report.daily.at(-1)?.success).toBe(1);
  expect(throughputReport([], '202610', 10, 20, now)).toMatchObject({ conditionalCompletionAt: null, conditionalVisitsAt: null });
});
