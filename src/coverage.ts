import { coverageFields } from './collection.ts';
import { communityProfile, loadCommunity } from './contributor.ts';
import { type Pool, rows } from './db.ts';
import { loadManualMonths, manualProfile } from './manual.ts';
import type { TrafficProfile } from './similarweb.ts';

export const COVERAGE_THRESHOLD = 0.8;
export interface MonthCoverage {
  month: string;
  scope: 'tracked';
  tracked: number;
  withVisits: number;
  complete: number;
  lastUpdatedAt: string | null;
}

/** The same raw-field completeness as collection; estimates never fill missing fields. */
export async function loadMonthCoverage(pool: Pool, months: string[]): Promise<Record<string, MonthCoverage>> {
  if (!months.length) return {};
  const [watched, enrolled, traffic, profiles, manual, sheet, community] = await Promise.all([
    rows<{ domain: string }>(pool, "SELECT DISTINCT domain FROM watches WHERE kind = 'watch'"),
    rows<{ domain: string; month: string }>(pool, 'SELECT month, domain FROM collection_domains WHERE month IN (?)', [months]),
    rows<{ domain: string; month: string; visits: number; fetched_at: Date }>(
      pool,
      'SELECT domain, month, visits, fetched_at FROM traffic_months WHERE month IN (?)',
      [months],
    ),
    rows<{ domain: string; month: string; profile: TrafficProfile | string; fetched_at: Date }>(
      pool,
      'SELECT domain, month, profile, fetched_at FROM traffic_profiles WHERE month IN (?)',
      [months],
    ),
    loadManualMonths(pool, { months }),
    rows<{ domain: string; month: string; visits: number; imported_at: Date }>(
      pool,
      'SELECT domain, month, visits, imported_at FROM sheet_rows WHERE month IN (?) AND adjusted = 0 AND visits > 0',
      [months],
    ),
    loadCommunity(pool, months),
  ]);
  const communities = new Map(community.map((r) => [`${r.targetMonth}:${r.domain}`, r]));
  const key = (r: { domain: string; month: string }) => `${r.month}:${r.domain}`;
  const visits = new Map(traffic.map((r) => [key(r), r]));
  const prof = new Map(profiles.map((r) => [key(r), r]));
  const hands = new Map(manual.map((r) => [key(r), r]));
  const sheets = new Map(sheet.map((r) => [key(r), r]));
  return Object.fromEntries(
    months.map((month) => {
      const domains = new Set([...watched.map((r) => r.domain), ...enrolled.filter((r) => r.month === month).map((r) => r.domain)]);
      let complete = 0;
      let withVisits = 0;
      let updated = 0;
      for (const domain of domains) {
        const id = `${month}:${domain}`;
        const auto = visits.get(id);
        const profile = prof.get(id);
        const hand = hands.get(id);
        const sh = sheets.get(id);
        const contributor = communities.get(id);
        const positive = Number(auto?.visits ?? 0) > 0 ? Number(auto!.visits) : (hand?.visits ?? contributor?.payload.visits ?? null);
        const fields = coverageFields(positive, [
          profile ? (typeof profile.profile === 'string' ? JSON.parse(profile.profile) : profile.profile) : null,
          hand ? manualProfile(hand) : null,
          contributor ? communityProfile(contributor) : null,
        ]);
        if (fields.fields.visits || Number(sh?.visits ?? 0) > 0) withVisits++;
        if (!fields.missing.length) complete++;
        updated = Math.max(
          updated,
          auto?.fetched_at.getTime() ?? 0,
          profile?.fetched_at.getTime() ?? 0,
          hand ? Date.parse(hand.updatedAt) : 0,
          sh?.imported_at.getTime() ?? 0,
          contributor ? Date.parse(contributor.fetchedAt) : 0,
        );
      }
      return [
        month,
        {
          month,
          scope: 'tracked',
          tracked: domains.size,
          withVisits,
          complete,
          lastUpdatedAt: updated ? new Date(updated).toISOString() : null,
        } satisfies MonthCoverage,
      ];
    }),
  );
}

export function defaultCoverageMonth(months: string[], coverage: Record<string, MonthCoverage>) {
  return (
    [...months]
      .sort()
      .reverse()
      .find((m) => coverage[m]?.tracked > 0 && coverage[m].complete / coverage[m].tracked >= COVERAGE_THRESHOLD) ??
    [...months].sort().at(-1) ??
    null
  );
}
