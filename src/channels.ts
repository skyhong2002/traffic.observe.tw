import { type Pool, rows } from './db.ts';
import { estimated, type TrafficChannel, type TrafficProfile, trafficChannels } from './similarweb.ts';

// How traffic sources move month to month. Similarweb returns the channel shares of the latest month only,
// so each month exists once the scheduler has fetched it (catch-up retries every domain until last month's
// profile arrives, scheduler.ts). Months without a Similarweb estimate are left out, as on the pages.

/** Sites below this many visits (millions) in either month are left out of the movers: their shares jump about. */
export const MOVER_MIN_VISITS = 0.1;

export interface SourceMonth {
  month: string;
  /** Sites with an estimated profile that month. */
  sites: number;
  /** Their visits, millions. */
  visits: number;
  /** Visit-weighted share of each channel: the share of all those visits that came through it. */
  shares: Record<TrafficChannel, number>;
}
export interface Mover {
  domain: string;
  channel: TrafficChannel;
  from: number;
  to: number;
  /** to − from, in share (0.05 = 5 percentage points). */
  change: number;
  /** Latest month's visits, millions. */
  visits: number;
}

/** Every estimated profile with its month's visits (millions), oldest first; only `domains` when given. */
export async function loadProfiles(pool: Pick<Pool, 'query'>, domains?: string[]) {
  if (domains && !domains.length) return [];
  const list = await rows<{ domain: string; month: string; profile: unknown; visits: number }>(
    pool,
    `SELECT p.domain, p.month, p.profile, m.visits FROM traffic_profiles p
    JOIN traffic_months m ON m.domain = p.domain AND m.month = p.month ${domains ? 'WHERE p.domain IN (?)' : ''} ORDER BY p.month`,
    domains ? [domains] : [],
  );
  return list
    .filter((r) => estimated(Number(r.visits)))
    .map((r) => ({
      domain: r.domain,
      month: r.month,
      visits: Number(r.visits) / 1e6,
      profile: (typeof r.profile === 'string' ? JSON.parse(r.profile) : r.profile) as TrafficProfile,
    }));
}
export type ProfileRow = Awaited<ReturnType<typeof loadProfiles>>[number];

/** Visit-weighted channel shares per month, and the sites whose sources moved most between the last two months. */
export function sourceTrends(profiles: ProfileRow[], limit = 30) {
  const byMonth = new Map<string, ProfileRow[]>();
  for (const p of profiles) byMonth.set(p.month, [...(byMonth.get(p.month) ?? []), p]);
  const months: SourceMonth[] = [...byMonth]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, list]) => {
      const visits = list.reduce((a, p) => a + p.visits, 0);
      const shares = Object.fromEntries(
        trafficChannels.map((c) => [c, visits ? list.reduce((a, p) => a + p.visits * (p.profile.channels[c] ?? 0), 0) / visits : 0]),
      ) as Record<TrafficChannel, number>;
      return { month, sites: list.length, visits, shares };
    });
  const last = months.at(-1)?.month ?? null;
  const prev = months.length > 1 ? (months.at(-2)?.month ?? null) : null;
  const movers: Mover[] = [];
  if (prev && last) {
    const before = new Map((byMonth.get(prev) ?? []).map((p) => [p.domain, p]));
    for (const now of byMonth.get(last) ?? []) {
      const then = before.get(now.domain);
      if (!then || now.visits < MOVER_MIN_VISITS || then.visits < MOVER_MIN_VISITS) continue;
      // The site's biggest move, whichever channel it was in.
      const best = trafficChannels
        .map((channel) => ({ channel, from: then.profile.channels[channel] ?? 0, to: now.profile.channels[channel] ?? 0 }))
        .map((m) => ({ ...m, change: m.to - m.from }))
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
      if (best.change) movers.push({ domain: now.domain, visits: now.visits, ...best });
    }
    movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  }
  return { months, movers: movers.slice(0, limit), latest: last, previous: prev };
}
export type SourceTrends = ReturnType<typeof sourceTrends>;
