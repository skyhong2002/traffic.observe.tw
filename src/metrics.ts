import { type Pool, rows } from './db.ts';
import { aiShare, searchShare, type TrafficProfile, taiwanShare } from './similarweb.ts';

// The sheet's monthly view, computed from stored data: visits, growth, last
// month's rank, search visits (搜尋S = visits × search share) and AI visits
// (visits × GenAi share). Similarweb's own figures win; the sheet's fill the
// months and domains Similarweb has not given us. Rows the sheet adjusted by
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
  visitsSource: 'similarweb' | 'sheet' | null;
  searchShare: number | null;
  aiShare: number | null;
  taiwanShare: number | null;
  prevSearchShare: number | null;
  prevAiShare: number | null;
}

export const UNLABELLED = '未分類';
export const shiftMonth = (month: string, by: number) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4)) - 1 + by, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const splitTopics = (topics: string | null) =>
  (topics ?? '')
    .split(/[,，、]/)
    .map((t) => t.trim())
    .filter(Boolean);

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
  const [months, profiles, sheet] = await Promise.all([
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
  ]);
  const visits = new Map(months.map((r) => [`${r.domain} ${r.month}`, Number(r.visits) / 1e6]));
  const profile = new Map(
    profiles.map((r) => [`${r.domain} ${r.month}`, (typeof r.profile === 'string' ? JSON.parse(r.profile) : r.profile) as TrafficProfile]),
  );
  // Latest label per domain, and the sheet's own row per domain and month (first row wins: the sheet lists a site once per topic).
  const label = new Map<string, SheetRow>();
  const sheetRow = new Map<string, SheetRow>();
  for (const r of sheet) {
    label.set(r.domain, r);
    const key = `${r.domain} ${r.month}`;
    if (!sheetRow.has(key) && !r.adjusted) sheetRow.set(key, r);
  }
  const domains = new Set([...label.keys(), ...months.filter((r) => r.month === month).map((r) => r.domain)]);
  const pick = (domain: string, m: string) => {
    const sw = visits.get(`${domain} ${m}`);
    const sh = sheetRow.get(`${domain} ${m}`);
    const p = profile.get(`${domain} ${m}`);
    return {
      visits: sw ?? sh?.visits ?? null,
      source: sw !== undefined ? ('similarweb' as const) : sh?.visits != null ? ('sheet' as const) : null,
      search: p ? searchShare(p) : (sh?.search_share ?? null),
      ai: p ? aiShare(p) : (sh?.ai_share ?? null),
      taiwan: p ? taiwanShare(p) : (sh?.taiwan_share ?? null),
    };
  };
  const out: SiteMonth[] = [];
  for (const domain of domains) {
    const now = pick(domain, month);
    if (now.visits === null) continue;
    const before = pick(domain, prev);
    const l = label.get(domain);
    out.push({
      domain,
      name: l?.name ?? domain,
      group: l?.group_label ?? null,
      topics: splitTopics(l?.topics ?? null),
      visits: now.visits,
      prevVisits: before.visits,
      visitsSource: now.source,
      searchShare: now.search,
      aiShare: now.ai,
      taiwanShare: now.taiwan,
      prevSearchShare: before.search,
      prevAiShare: before.ai,
    });
  }
  return out.sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0));
}

export const topicsOf = (site: Pick<SiteMonth, 'topics'>) => (site.topics.length ? site.topics : [UNLABELLED]);

/** Rows of one topic, ranked by visits, with last month's rank in the same topic. */
export function ranking(view: SiteMonth[], topic: string | null) {
  const inTopic = topic ? view.filter((s) => topicsOf(s).includes(topic)) : view;
  const prevRank = new Map(
    inTopic
      .filter((s) => s.prevVisits !== null)
      .sort((a, b) => (b.prevVisits ?? 0) - (a.prevVisits ?? 0))
      .map((s, i) => [s.domain, i + 1]),
  );
  return inTopic.map((s, i) => ({
    ...s,
    rank: i + 1,
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
  for (const s of view) for (const t of topicsOf(s)) topics.set(t, [...(topics.get(t) ?? []), s]);
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
    `SELECT month FROM traffic_months UNION SELECT month FROM sheet_rows WHERE visits IS NOT NULL ORDER BY month DESC`,
  );
  return list.map((r) => r.month);
}
