import { expect, it } from 'vitest';
import type { SiteMonth } from '../src/metrics.ts';
import { reportComparison } from '../src/report-comparison.ts';
import { publicTraffic, trafficAccess } from '../src/traffic-access.ts';

const site = (domain: string, visits: number, searchShare: number | null = 0.2, aiShare: number | null = 0.01): SiteMonth => ({
  domain,
  name: domain,
  topics: ['電商'],
  group: null,
  visits,
  prevVisits: null,
  visitsSource: 'manual',
  searchShare,
  aiShare,
  taiwanShare: 0.9,
  taiwanShareUsed: 0.9,
  taiwanBasis: 'measured',
  taiwanShareMax: null,
  taiwanCapped: false,
  prevSearchShare: null,
  prevAiShare: null,
  channels: null,
});

it('uses the full comparison-month population and exports previous-only sites without inventing current values', () => {
  const current = [site('a.tw', 10, 0.1, 0), site('b.tw', 8, 0.5, null)];
  const previous = [site('missing.tw', 20, 0.5, 0.1), site('a.tw', 12, 0.25, 0.01), site('b.tw', 6, 0.5, null)];
  const rows = reportComparison(current, previous, true);
  expect(rows).toHaveLength(3);
  expect(rows.find((row) => row.domain === 'a.tw')).toMatchObject({
    rank: 1,
    prevRank: 2,
    prevVisits: 12,
    prevSearchVisits: 3,
    prevAiVisits: 0.12,
    searchRank: 2,
    aiRank: 1,
    prevSearchRank: 2,
    prevAiRank: 2,
  });
  expect(rows.find((row) => row.domain === 'b.tw')).toMatchObject({ searchRank: 1, aiRank: null });
  expect(rows.find((row) => row.domain === 'missing.tw')).toMatchObject({
    visits: null,
    searchVisits: null,
    aiVisits: null,
    rank: null,
    searchRank: null,
    aiRank: null,
    growth: null,
    prevVisits: 20,
    prevRank: 1,
    prevSearchRank: 1,
  });
  expect(reportComparison(current, previous)).toHaveLength(2);
});

it('keeps comparison volumes subject to public precision without rounding ranks', () => {
  const rows = reportComparison([site('a.tw', 10)], [site('a.tw', 12.34567, 0.23456)]);
  const publicRows = trafficAccess.run(false, () => publicTraffic(rows));
  expect(publicRows[0].prevVisits).toBe(12);
  expect(publicRows[0].prevSearchVisits).toBe(Number((12.34567 * 0.23456).toPrecision(2)));
  expect(publicRows[0].prevRank).toBe(1);
});
