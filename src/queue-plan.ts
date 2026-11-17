/** Offline, deterministic queue policy. It performs no upstream requests. */
export const QUEUE_LANES = ['missing', 'partial', 'retry', 'refresh'] as const;
export type QueueLane = (typeof QUEUE_LANES)[number];
export interface QueueSite {
  domain: string;
  priority: number;
  score: number;
  rareTags: string[];
  cruxRank: number | null;
  fields: Record<string, boolean>;
  complete: boolean;
  attempts: number;
  lastAttemptAt: string | null;
  enrolledAt?: string;
  automatic: boolean;
  automaticVisitsAt: string | null;
  manualUpdatedAt: string | null;
  hasManual: boolean;
}
export function queueLane(e: QueueSite): QueueLane {
  return e.complete ? 'refresh' : e.attempts ? 'retry' : e.fields.visits ? 'partial' : 'missing';
}
export function queueDecision(e: QueueSite, now: Date) {
  const since = e.lastAttemptAt ?? e.enrolledAt ?? `${now.toISOString().slice(0, 7)}-01T00:00:00Z`;
  const ageDays = Math.max(0, (now.getTime() - Date.parse(since)) / 86_400_000);
  const missing = Object.values(e.fields).filter((value) => !value).length;
  const components = {
    priority: e.priority,
    taiwanVisits: e.score,
    rareTagBoost: e.rareTags.length ? 10 : 1,
    cruxRank: e.cruxRank,
    missingFields: missing,
    ageDays,
    starvationProtection: ageDays >= 7,
  };
  return {
    lane: queueLane(e),
    components,
    score: Math.log1p(e.score) * components.rareTagBoost + missing + ageDays + (e.cruxRank ? 1 / Math.log10(e.cruxRank + 10) : 0),
    since,
  };
}
export function optimizedQueue<T extends QueueSite>(entries: T[], ordinal: number, now: Date) {
  const pending = entries.filter((e) => e.automatic);
  const compare = (a: T, b: T) => {
    const x = queueDecision(a, now),
      y = queueDecision(b, now);
    return (
      Number(y.components.starvationProtection) - Number(x.components.starvationProtection) ||
      (x.components.starvationProtection && y.components.starvationProtection
        ? x.since.localeCompare(y.since)
        : a.priority - b.priority || y.score - x.score) ||
      a.domain.localeCompare(b.domain)
    );
  };
  const groups = Object.fromEntries(
    QUEUE_LANES.map((lane) => [lane, pending.filter((e) => queueLane(e) === lane).sort(compare)]),
  ) as Record<QueueLane, T[]>;
  // Every lane has a reserved slot; empty lanes donate theirs. Persisted sends
  // supply ordinal, so one-request workers cannot restart the cycle each run.
  const cycle: QueueLane[] = ['missing', 'partial', 'missing', 'retry', 'refresh'];
  const result: T[] = [];
  while (result.length < pending.length) {
    const desired = cycle[(ordinal + result.length) % cycle.length];
    const lane = groups[desired].length ? desired : QUEUE_LANES.find((key) => groups[key].length)!;
    result.push(groups[lane].shift()!);
  }
  return result;
}
/** Matches the persisted baseline: priority, rare-tag x10, CrUX, reserved retry slots. */
export function baselineQueue<T extends QueueSite>(entries: T[], ordinal = 0) {
  const sorted = entries
    .filter((e) => e.automatic)
    .sort(
      (a, b) =>
        Number(a.hasManual) - Number(b.hasManual) ||
        a.priority - b.priority ||
        Number(a.attempts > 0) - Number(b.attempts > 0) ||
        b.score * (b.rareTags.length ? 10 : 1) - a.score * (a.rareTags.length ? 10 : 1) ||
        (a.cruxRank ?? 1e12) - (b.cruxRank ?? 1e12) ||
        (a.lastAttemptAt ?? '').localeCompare(b.lastAttemptAt ?? '') ||
        a.domain.localeCompare(b.domain),
    );
  const fresh = sorted.filter((e) => !e.attempts),
    retry = sorted.filter((e) => e.attempts),
    result: T[] = [];
  while (fresh.length || retry.length)
    result.push(((ordinal + result.length + 1) % 5 === 0 && retry.length ? retry.shift() : (fresh.shift() ?? retry.shift()))!);
  return result.sort((a, b) => Number(a.hasManual) - Number(b.hasManual));
}
export type BacktestStrategy = 'baseline' | 'rare-tag' | 'traffic' | 'fair';
export interface ReplayObservation {
  domain: string;
  at: string;
  saved: boolean;
  complete: boolean;
  refused?: boolean;
}
/** Observed outcomes follow each domain's chronological attempt sequence, without network requests. */
export function backtestQueue<T extends QueueSite>(entries: T[], budget: number, now: Date, observations?: ReplayObservation[]) {
  const strategies: BacktestStrategy[] = ['baseline', 'rare-tag', 'traffic', 'fair'];
  const allTags = new Set(entries.flatMap((e) => e.rareTags));
  const totalTraffic = entries.reduce((n, e) => n + e.score, 0);
  return strategies.map((strategy) => {
    const working = entries.map((e) => ({ ...e }));
    const selected: string[] = [],
      completed = new Set<string>(),
      saved = new Set<string>();
    const used = new Map<string, number>(),
      latest = new Map<string, string>();
    const traces = new Map(
      entries.map((e) => [
        e.domain,
        (observations ?? [])
          .filter((o) => o.domain === e.domain && Date.parse(o.at) <= now.getTime())
          .sort((a, b) => a.at.localeCompare(b.at)),
      ]),
    );
    let refusals = 0;
    for (let slot = 0; slot < budget; slot++) {
      const eligible = working.filter((e) => e.automatic && (!observations || (used.get(e.domain) ?? 0) < traces.get(e.domain)!.length));
      const order =
        strategy === 'fair'
          ? optimizedQueue(eligible, slot, now)
          : strategy === 'baseline'
            ? baselineQueue(eligible, slot)
            : eligible.sort(
                (a, b) =>
                  (strategy === 'rare-tag'
                    ? b.score * (b.rareTags.length ? 10 : 1) - a.score * (a.rareTags.length ? 10 : 1)
                    : b.score - a.score) || a.domain.localeCompare(b.domain),
              );
      const chosen = order[0];
      if (!chosen) break;
      selected.push(chosen.domain);
      const cursor = used.get(chosen.domain) ?? 0;
      const outcome = observations
        ? traces.get(chosen.domain)![cursor]
        : { domain: chosen.domain, at: now.toISOString(), saved: true, complete: true };
      used.set(chosen.domain, cursor + 1);
      if (outcome.refused) refusals++;
      if (outcome.saved && !outcome.refused) {
        saved.add(chosen.domain);
        latest.set(chosen.domain, outcome.at);
      }
      if (outcome.complete && !outcome.refused) {
        if (!chosen.complete) completed.add(chosen.domain);
        chosen.complete = true;
        chosen.automatic = false;
      } else {
        chosen.attempts++;
        chosen.lastAttemptAt = outcome.at;
        if (outcome.saved) chosen.fields = { ...chosen.fields, visits: true };
      }
    }
    const tags = new Set(entries.filter((e) => saved.has(e.domain)).flatMap((e) => e.rareTags));
    const ages = entries
      .map((e) => latest.get(e.domain) ?? e.automaticVisitsAt)
      .filter((v): v is string => !!v)
      .map((v) => Math.max(0, (now.getTime() - Date.parse(v)) / 86400000));
    return {
      strategy,
      assumptions: observations
        ? 'historical per-domain outcome replay; counterfactual ordering assumes outcomes independent of request time; no upstream calls'
        : 'one valid complete response per selected domain; counterfactual coverage, not measured provider success',
      selected,
      completedDomains: completed.size,
      savedDomains: saved.size,
      refusals,
      rareTagCoverage: allTags.size ? tags.size / allTags.size : null,
      taiwanTrafficCoverage: totalTraffic
        ? entries.filter((e) => saved.has(e.domain)).reduce((n, e) => n + e.score, 0) / totalTraffic
        : null,
      meanFreshnessDays: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null,
      unknownFreshnessDomains: entries.length - ages.length,
      priorities: [...new Set(entries.map((e) => e.priority))].sort().map((priority) => ({
        priority,
        total: entries.filter((e) => e.priority === priority).length,
        complete: entries.filter((e) => e.priority === priority && (e.complete || completed.has(e.domain))).length,
      })),
      tags: [...allTags].sort().map((tag) => ({
        tag,
        total: entries.filter((e) => e.rareTags.includes(tag)).length,
        saved: entries.filter((e) => e.rareTags.includes(tag) && saved.has(e.domain)).length,
      })),
    };
  });
}
