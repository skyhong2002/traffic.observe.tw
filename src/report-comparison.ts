import { ranking, type SiteMonth } from './metrics.ts';

/** Rank before search/pagination; unknown values remain unranked, while a reported zero participates. */
const metricRanks = (rows: ReturnType<typeof ranking>, key: 'visits' | 'searchVisits' | 'aiVisits') =>
  new Map(
    rows
      .filter((row) => row[key] !== null)
      .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0) || a.domain.localeCompare(b.domain))
      .map((row, index) => [row.domain, index + 1]),
  );

export function reportComparison(current: SiteMonth[], previous: SiteMonth[], includePreviousOnly = false) {
  const beforeRows = ranking(previous, null);
  const before = new Map(beforeRows.map((row) => [row.domain, row]));
  const domains = new Set(current.map((row) => row.domain));
  const inputs = includePreviousOnly
    ? [
        ...current,
        ...previous
          .filter((row) => !domains.has(row.domain))
          .map((row) => ({
            ...row,
            visits: null,
            visitsSource: null,
            searchShare: null,
            aiShare: null,
            taiwanShare: null,
            taiwanShareUsed: null,
            taiwanBasis: null,
            taiwanShareMax: null,
            taiwanCapped: false,
            channels: null,
          })),
      ]
    : current;
  const rows = ranking(
    inputs.map((row) => {
      const prev = before.get(row.domain);
      return {
        ...row,
        prevVisits: prev?.visits ?? null,
        prevSearchShare: prev?.searchShare ?? null,
        prevAiShare: prev?.aiShare ?? null,
        prevTaiwanShare: prev?.taiwanShare ?? null,
        prevTaiwanShareUsed: prev?.taiwanShareUsed ?? null,
        prevChannels: prev?.channels ?? null,
      };
    }),
    null,
  );
  const metrics = ['visits', 'searchVisits', 'aiVisits'] as const;
  const currentRanks = metrics.map((key) => metricRanks(rows, key));
  const previousRanks = metrics.map((key) => metricRanks(beforeRows, key));
  return rows.map((row) => {
    const prev = before.get(row.domain);
    return {
      ...row,
      rank: row.visits === null ? null : row.rank,
      growth: row.visits === null ? null : row.growth,
      prevRank: prev?.rank ?? null,
      visitsRank: currentRanks[0].get(row.domain) ?? null,
      searchRank: currentRanks[1].get(row.domain) ?? null,
      aiRank: currentRanks[2].get(row.domain) ?? null,
      prevVisitsRank: previousRanks[0].get(row.domain) ?? null,
      prevSearchRank: previousRanks[1].get(row.domain) ?? null,
      prevAiRank: previousRanks[2].get(row.domain) ?? null,
      prevSearchVisits: prev?.searchVisits ?? null,
      prevAiVisits: prev?.aiVisits ?? null,
      prevTaiwanVisits: prev?.taiwanVisits ?? null,
      prevTaiwanSearchVisits: prev?.taiwanSearchVisits ?? null,
      prevTaiwanAiVisits: prev?.taiwanAiVisits ?? null,
    };
  });
}
