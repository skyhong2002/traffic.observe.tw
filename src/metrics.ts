import { loadCrowd, shownTags } from './crowd.ts';
import { type Pool, rows } from './db.ts';
import { loadManualMonths, manualProfile } from './manual.ts';
import { loadMetadata } from './metadata.ts';
import { divisorOf, siteName } from './sheet.ts';
import { aiShare, estimated, searchShare, type TrafficChannel, type TrafficProfile, taiwanShare, trafficChannels } from './similarweb.ts';
import { latestTopics } from './tags.ts';
import { estimateTaiwanShare, type TaiwanBasis, taiwanVisits } from './taiwan-estimate.ts';

// The sheet's monthly view, computed from stored data: visits, growth, last
// month's rank, search visits (搜尋S = visits × search share) and AI visits
// (visits × GenAi share). Similarweb's own figures win; months it has no
// estimate for take what an editor entered from its platform, then the sheet's. Rows the sheet adjusted by
// hand (「/5」) are never used as visits. Labels (group, topics, name) come
// from the sheet's latest row for the domain up to that month.

export interface SiteMonth {
  domain: string;
  name: string;
  group: string | null;
  topics: string[];
  /** Millions. */
  visits: number | null;
  prevVisits: number | null;
  /** Where the visits come from: Similarweb's free endpoint, entered by hand from its platform, or the sheet. */
  visitsSource: 'similarweb' | 'manual' | 'sheet' | null;
  searchShare: number | null;
  aiShare: number | null;
  /** Similarweb's (or the sheet's) Taiwan share; null when it has none. */
  taiwanShare: number | null;
  /** The share the ranking uses: taiwanShare, else an estimate (see taiwan-estimate.ts). */
  taiwanShareUsed: number | null;
  taiwanBasis: TaiwanBasis | null;
  /** The most Taiwan can have, from Similarweb's other top countries. */
  taiwanShareMax: number | null;
  /** A manual or earlier share was above taiwanShareMax and was replaced by it. */
  taiwanCapped: boolean;
  prevSearchShare: number | null;
  prevAiShare: number | null;
  /** Fetched or manually entered channel shares; omitted manual channels are unknown (no sheet fallback). */
  channels: Partial<Record<TrafficChannel, number>> | null;
  /** The comparison month's 台灣 share and channels, set by the rankings when a month is compared. */
  prevTaiwanShare?: number | null;
  prevTaiwanShareUsed?: number | null;
  prevChannels?: Partial<Record<TrafficChannel, number>> | null;
}

export const shiftMonth = (month: string, by: number) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4)) - 1 + by, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export { latestTopics, splitTopics } from './tags.ts';

interface SheetRow {
  month: string;
  domain: string;
  name: string;
  group_label: string | null;
  topics: string | null;
  visits: number | null;
  adjusted: number;
  search_share: number | null;
  ai_share: number | null;
  taiwan_share: number | null;
}

export async function monthView(pool: Pool, month: string): Promise<SiteMonth[]> {
  const prev = shiftMonth(month, -1);
  const [months, profiles, sheet, metadata, manualRows, crowd, adjusted] = await Promise.all([
    rows<{ domain: string; month: string; visits: number }>(
      pool,
      'SELECT domain, month, visits FROM traffic_months WHERE month IN (?, ?)',
      [month, prev],
    ),
    rows<{ domain: string; month: string; profile: unknown }>(
      pool,
      'SELECT domain, month, profile FROM traffic_profiles WHERE month IN (?, ?)',
      [month, prev],
    ),
    rows<SheetRow>(
      pool,
      `SELECT month, domain, name, group_label, topics, visits, adjusted, search_share, ai_share, taiwan_share
       FROM sheet_rows WHERE domain IS NOT NULL AND month <= ? ORDER BY month, row_no`,
      [month],
    ),
    loadMetadata(pool),
    loadManualMonths(pool, { months: [month, prev] }),
    loadCrowd(pool),
    rows<{ domain: string; name: string; raw: unknown }>(
      pool,
      'SELECT domain, name, raw FROM sheet_rows WHERE adjusted = 1 AND domain IS NOT NULL AND month <= ? ORDER BY month, row_no',
      [month],
    ),
  ]);
  const manual = new Map(manualRows.map((r) => [`${r.domain} ${r.month}`, r]));
  // A month Similarweb has no estimate for falls back to the sheet, like a month it was never asked about.
  const visits = new Map(months.filter((r) => estimated(Number(r.visits))).map((r) => [`${r.domain} ${r.month}`, Number(r.visits) / 1e6]));
  const profile = new Map(
    profiles.map((r) => [`${r.domain} ${r.month}`, (typeof r.profile === 'string' ? JSON.parse(r.profile) : r.profile) as TrafficProfile]),
  );
  // Latest label per domain, and the sheet's own row per domain and month (first row with visits wins: the sheet lists a site once per topic).
  const label = new Map<string, SheetRow>();
  const labels = new Map<string, SheetRow[]>();
  const sheetRow = new Map<string, SheetRow>();
  for (const r of sheet) {
    if (label.get(r.domain)?.month !== r.month) labels.set(r.domain, []);
    labels.get(r.domain)?.push(r);
    label.set(r.domain, r);
    const key = `${r.domain} ${r.month}`;
    if ((!sheetRow.has(key) || sheetRow.get(key)?.visits == null) && !r.adjusted) sheetRow.set(key, r);
  }
  // The editors' 「/N」 guesses (1/N of the visits are Taiwan's), the latest per domain, and the latest share the sheet printed before this month.
  const divisor = new Map<string, number>();
  for (const r of adjusted) {
    const raw = (typeof r.raw === 'string' ? JSON.parse(r.raw) : r.raw) as Record<string, string | number>;
    const cell = Object.values(raw).find((v): v is string => typeof v === 'string' && divisorOf(v) !== null && siteName(v) === r.name);
    const n = cell ? divisorOf(cell) : null;
    if (n !== null) divisor.set(r.domain, n);
  }
  const sheetShare = new Map<string, number>();
  for (const r of sheet) if (r.month < month && r.taiwan_share != null) sheetShare.set(r.domain, r.taiwan_share);
  const domains = new Set([
    ...label.keys(),
    ...months.filter((r) => r.month === month).map((r) => r.domain),
    ...manualRows.filter((r) => r.month === month).map((r) => r.domain),
  ]);
  const pick = (domain: string, m: string) => {
    const sw = visits.get(`${domain} ${m}`);
    const sh = sheetRow.get(`${domain} ${m}`);
    const p = sw === undefined ? undefined : profile.get(`${domain} ${m}`);
    // Without a Similarweb estimate, a month entered from its platform comes before the sheet.
    const hand = sw === undefined ? manual.get(`${domain} ${m}`) : undefined;
    const fallback = {
      search: hand ? hand.searchShare : (sh?.search_share ?? null),
      ai: hand ? hand.aiShare : (sh?.ai_share ?? null),
      taiwan: hand ? hand.taiwanShare : (sh?.taiwan_share ?? null),
    };
    return {
      visits: sw ?? (hand ? hand.visits / 1e6 : null) ?? sh?.visits ?? null,
      source: sw !== undefined ? ('similarweb' as const) : hand ? ('manual' as const) : sh?.visits != null ? ('sheet' as const) : null,
      channels: p
        ? Object.fromEntries(trafficChannels.map((key) => [key, p.channels[key] ?? 0]))
        : hand
          ? manualProfile(hand).channels
          : null,
      search: p ? searchShare(p) : fallback.search,
      ai: p ? aiShare(p) : fallback.ai,
      taiwan: p ? taiwanShare(p) : fallback.taiwan,
      // A hand-entered country list may be partial, so do not use it as a top-five bound.
      countries: p ? p.countries : null,
    };
  };
  const out: SiteMonth[] = [];
  for (const domain of domains) {
    const now = pick(domain, month);
    if (now.visits === null) continue;
    const before = pick(domain, prev);
    const taiwan = estimateTaiwanShare({
      measured: now.taiwan,
      countries: now.countries,
      divisor: divisor.get(domain) ?? null,
      earlier: before.taiwan ?? sheetShare.get(domain) ?? null,
    });
    const l = label.get(domain);
    out.push({
      domain,
      name: metadata.get(domain)?.name ?? l?.name ?? domain,
      group: l?.group_label ?? null,
      topics: shownTags(
        metadata.get(domain)?.topics ?? latestTopics((labels.get(domain) ?? []).map((r) => ({ ...r, group: r.group_label }))),
        crowd.get(domain),
      ),
      visits: now.visits,
      prevVisits: before.visits,
      visitsSource: now.source,
      searchShare: now.search,
      aiShare: now.ai,
      taiwanShare: now.taiwan,
      taiwanShareUsed: taiwan?.share ?? null,
      taiwanBasis: taiwan?.basis ?? null,
      taiwanShareMax: taiwan?.max ?? null,
      taiwanCapped: taiwan?.capped ?? false,
      prevSearchShare: before.search,
      prevAiShare: before.ai,
      channels: now.channels,
    });
  }
  return out.sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0));
}

/** Larger 台灣造訪量 first; sites without a Taiwan share follow, among themselves by plain visits. */
const byTaiwanVisits = (a: { tw: number | null; visits: number | null }, b: { tw: number | null; visits: number | null }) =>
  a.tw !== null && b.tw !== null && a.tw !== b.tw
    ? b.tw - a.tw
    : (a.tw === null) !== (b.tw === null)
      ? a.tw === null
        ? 1
        : -1
      : (b.visits ?? 0) - (a.visits ?? 0);

/** Rows of one topic, ranked by 台灣造訪量 (visits × Taiwan share), with last month's rank in the same topic. */
export function ranking<T extends SiteMonth>(view: T[], topic: string | null) {
  const now = (s: T) => ({ tw: taiwanVisits(s.visits, s.taiwanShareUsed), visits: s.visits });
  const inTopic = (topic ? view.filter((s) => s.topics.includes(topic)) : [...view]).sort((a, b) => byTaiwanVisits(now(a), now(b)));
  const places = (list: T[]) => new Map(list.map((s, i) => [s.domain, i + 1]));
  const rank = places(inTopic);
  const prev = (s: T) => ({ tw: taiwanVisits(s.prevVisits, s.prevTaiwanShareUsed), visits: s.prevVisits });
  const prevRank = places(inTopic.filter((s) => s.prevVisits !== null).sort((a, b) => byTaiwanVisits(prev(a), prev(b))));
  return inTopic.map((s) => ({
    ...s,
    taiwanVisits: taiwanVisits(s.visits, s.taiwanShareUsed),
    rank: rank.get(s.domain) ?? null,
    prevRank: prevRank.get(s.domain) ?? null,
    growth: s.prevVisits ? (s.visits ?? 0) / s.prevVisits - 1 : null,
    searchVisits: s.searchShare !== null && s.visits !== null ? s.visits * s.searchShare : null,
    aiVisits: s.aiShare !== null && s.visits !== null ? s.visits * s.aiShare : null,
  }));
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** The「網站概況」table: per topic, growth and shares summed over its sites. */
export function topicSummary(view: SiteMonth[]) {
  const topics = new Map<string, SiteMonth[]>();
  for (const s of view) for (const t of s.topics) topics.set(t, [...(topics.get(t) ?? []), s]);
  return [...topics]
    .map(([topic, sites]) => {
      const both = sites.filter((s) => s.prevVisits);
      const withSearch = sites.filter((s) => s.searchShare !== null);
      const withAi = sites.filter((s) => s.aiShare !== null);
      const aiBoth = both.filter((s) => s.aiShare !== null && s.prevAiShare !== null);
      const searchBoth = both.filter((s) => s.searchShare !== null && s.prevSearchShare !== null);
      const sum = (list: SiteMonth[], f: (s: SiteMonth) => number) => list.reduce((n, s) => n + f(s), 0);
      const v = (s: SiteMonth) => s.visits ?? 0;
      const pv = (s: SiteMonth) => s.prevVisits ?? 0;
      return {
        topic,
        sites: sites.length,
        visits: sum(sites, v),
        visitsGrowth: both.length ? (ratio(sum(both, v), sum(both, pv)) ?? 1) - 1 : null,
        searchShare: ratio(
          sum(withSearch, (s) => v(s) * (s.searchShare ?? 0)),
          sum(withSearch, v),
        ),
        aiShare: ratio(
          sum(withAi, (s) => v(s) * (s.aiShare ?? 0)),
          sum(withAi, v),
        ),
        aiGrowth: aiBoth.length
          ? (ratio(
              sum(aiBoth, (s) => v(s) * (s.aiShare ?? 0)),
              sum(aiBoth, (s) => pv(s) * (s.prevAiShare ?? 0)),
            ) ?? 1) - 1
          : null,
        searchGrowth: searchBoth.length
          ? (ratio(
              sum(searchBoth, (s) => v(s) * (s.searchShare ?? 0)),
              sum(searchBoth, (s) => pv(s) * (s.prevSearchShare ?? 0)),
            ) ?? 1) - 1
          : null,
      };
    })
    .sort((a, b) => b.visits - a.visits);
}

/** Months that have any visits, newest first. */
export async function availableMonths(pool: Pool) {
  const list = await rows<{ month: string }>(
    pool,
    `SELECT month FROM traffic_months UNION SELECT month FROM sheet_rows WHERE visits IS NOT NULL
     UNION SELECT month FROM manual_months ORDER BY month DESC`,
  );
  return list.map((r) => r.month);
}
