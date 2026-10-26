import { type Pool, rows } from './db.ts';
import { availableMonths, monthView } from './metrics.ts';
import { sourceOf } from './pages.ts';
import { loadRadar } from './radar.ts';

// Every month's view in one payload for the report page (/), which compares
// any two months and draws rank trajectories client-side. Per site and month:
// [visits (millions), search visits, AI visits, Taiwan share, origin of the
// visits: 0 Similarweb, 1 the sheet, 2 entered by hand from Similarweb's platform,
// Taiwan share in use (the measured one, else an estimate), its basis: 0 measured, 1 the editors' 「/N」 guess,
// 2 an earlier month's, 3 the ceiling Similarweb's other top countries leave; that ceiling; 1 if it replaced a contradicting guess]. `src` lists the requesters with a standing watch on
// the domain (raw: tag, blog, sheet, manual). `sources` counts distinct domains
// per source as the pages show it: tag, blog and 手動 (the sheet + /watch/).

export interface History {
  generatedAt: string;
  /** Oldest first. */
  months: string[];
  fields: string[];
  topics: string[];
  sources: Array<{ source: string; domains: number }>;
  sites: Record<
    string,
    {
      name: string;
      group: string | null;
      topics: string[];
      src: string[];
      m: Record<
        string,
        [
          number | null,
          number | null,
          number | null,
          number | null,
          0 | 1 | 2,
          (number | null)?,
          (0 | 1 | 2 | 3 | null)?,
          (number | null)?,
          (0 | 1)?,
        ]
      >;
    }
  >;
  /** Cloudflare Radar periods, oldest first: rank (top 100 place), bucket (top N) or gt (not in the top N). */
  radar: Record<string, Array<{ date: string; rank: number | null; bucket: number | null; gt: number | null }>>;
}

const BASIS_CODE = { measured: 0, manual: 1, history: 2, bound: 3 } as const;
const SOURCE_ORDER = ['tag', 'blog', 'sheet', 'manual'];
const GROUP_ORDER = ['tag', 'blog', 'manual'];

export async function buildHistory(pool: Pool, now = new Date()): Promise<History> {
  const months = [...(await availableMonths(pool))].reverse();
  const [views, watched, radar] = await Promise.all([
    Promise.all(months.map((month) => monthView(pool, month))),
    rows<{ requester: string; domain: string }>(pool, "SELECT DISTINCT requester, domain FROM watches WHERE kind = 'watch'"),
    loadRadar(pool),
  ]);
  const src = new Map<string, string[]>();
  const groups = new Map<string, Set<string>>();
  for (const w of watched) {
    src.set(w.domain, [...(src.get(w.domain) ?? []), w.requester]);
    const g = sourceOf(w.requester);
    (groups.get(g) ?? groups.set(g, new Set()).get(g))?.add(w.domain);
  }
  const rank = (r: string) => SOURCE_ORDER.indexOf(r) + 1 || 9;
  const sites: History['sites'] = {};
  months.forEach((month, i) => {
    for (const s of views[i]) {
      if (s.visits === null) continue;
      // Labels follow the latest month the site appears in (months run oldest first).
      const entry = sites[s.domain] ?? { name: s.name, group: s.group, topics: s.topics, src: [], m: {} };
      Object.assign(entry, { name: s.name, group: s.group, topics: s.topics });
      entry.m[month] = [
        s.visits,
        s.searchShare !== null ? s.visits * s.searchShare : null,
        s.aiShare !== null ? s.visits * s.aiShare : null,
        s.taiwanShare,
        s.visitsSource === 'sheet' ? 1 : s.visitsSource === 'manual' ? 2 : 0,
        s.taiwanShareUsed,
        s.taiwanBasis === null ? null : BASIS_CODE[s.taiwanBasis],
        s.taiwanShareMax,
        s.taiwanCapped ? 1 : 0,
      ];
      sites[s.domain] = entry;
    }
  });
  for (const [domain, entry] of Object.entries(sites)) entry.src = (src.get(domain) ?? []).sort((a, b) => rank(a) - rank(b));
  return {
    generatedAt: now.toISOString(),
    months,
    fields: [
      'visits(M)',
      'search(M)',
      'ai(M)',
      'taiwanShare',
      'origin(0 similarweb, 1 sheet, 2 platform by hand)',
      'taiwanShareUsed',
      'taiwanBasis(0 measured, 1 editors /N, 2 earlier month, 3 ceiling)',
      'taiwanShareMax',
      'taiwanCapped(1 a guess above the ceiling was replaced)',
    ],
    topics: [...new Set(Object.values(sites).flatMap((s) => s.topics))],
    sources: [...groups]
      .map(([source, domains]) => ({ source, domains: domains.size }))
      .sort((a, b) => (GROUP_ORDER.indexOf(a.source) + 1 || 9) - (GROUP_ORDER.indexOf(b.source) + 1 || 9)),
    sites,
    radar: Object.fromEntries(
      [...radar].map(([domain, periods]) => [
        domain,
        periods.map((p) => ({ date: p.dateEnd.slice(0, 10), rank: p.rank, bucket: p.bucket, gt: p.bucketLowerBound })),
      ]),
    ),
  };
}
