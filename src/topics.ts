import type { History } from './history.ts';
import type { ManagedSite } from './metadata.ts';

type Totals = {
  months: number;
  visits: number;
  searchVisits: number;
  searchBase: number;
  aiVisits: number;
  aiBase: number;
};
const empty = (): Totals => ({ months: 0, visits: 0, searchVisits: 0, searchBase: 0, aiVisits: 0, aiBase: 0 });
const metrics = (t: Totals) => ({
  visits: t.months ? t.visits : null,
  searchShare: t.searchBase > 0 ? t.searchVisits / t.searchBase : null,
  aiShare: t.aiBase > 0 ? t.aiVisits / t.aiBase : null,
});

/** Current tag membership, with each domain's known monthly traffic summed once. */
export function aggregateTopics(history: Pick<History, 'sites'>, inventory: Pick<ManagedSite, 'domain' | 'name' | 'topics'>[]) {
  const months = new Set<string>();
  const topics = new Map<string, { sites: number; sitesWithData: number; totals: Totals }>();
  const sites = [...new Map(inventory.map((s) => [s.domain, s])).values()].map((site) => {
    const totals = empty();
    for (const [month, [visits, search, ai]] of Object.entries(history.sites[site.domain]?.m ?? {})) {
      if (visits === null) continue;
      months.add(month);
      totals.months++;
      totals.visits += visits;
      if (search !== null) {
        totals.searchVisits += search;
        totals.searchBase += visits;
      }
      if (ai !== null) {
        totals.aiVisits += ai;
        totals.aiBase += visits;
      }
    }
    const labels = [...new Set(site.topics)];
    for (const tag of labels) {
      const entry = topics.get(tag) ?? { sites: 0, sitesWithData: 0, totals: empty() };
      entry.sites++;
      if (totals.months) entry.sitesWithData++;
      for (const key of Object.keys(totals) as (keyof Totals)[]) entry.totals[key] += totals[key];
      topics.set(tag, entry);
    }
    return { domain: site.domain, name: site.name, topics: labels, months: totals.months, ...metrics(totals) };
  });
  return {
    months: [...months].sort(),
    topics: [...topics]
      .map(([topic, t]) => ({ topic, sites: t.sites, sitesWithData: t.sitesWithData, ...metrics(t.totals) }))
      .sort((a, b) => (b.visits ?? -1) - (a.visits ?? -1) || b.sites - a.sites || a.topic.localeCompare(b.topic)),
    sites: sites.sort((a, b) => (b.visits ?? -1) - (a.visits ?? -1) || a.domain.localeCompare(b.domain)),
  };
}

export type TopicOverview = ReturnType<typeof aggregateTopics>;
