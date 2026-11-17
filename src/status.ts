import { collectionMonth, loadCollection } from './collection.ts';
import { cruxStatus, untrackedPopular } from './crux.ts';
import { type Pool, rows } from './db.ts';
import { egressExperimentStatus } from './egress-experiment.ts';
import { type FetchPolicy, fetchPolicy } from './fetch-policy.ts';
import { radarConfig } from './radar.ts';
import { releaseRevision } from './release.ts';
import { recentRequestDiagnostics } from './request-diagnostics.ts';
import {
  type Candidate,
  catchUpQuota,
  coolingDown,
  dueQueue,
  lastMonthShare,
  loadCandidates,
  type MonthShare,
  type RunConfig,
  refusedSince,
} from './scheduler.ts';
import { techConfig } from './tech-scan.ts';
import { loadThroughput } from './throughput.ts';

const HOUR = 3_600_000;
/** The worker's next run at :runMinute that is not before `from`. */
function nextRunAt(from: Date, minute: number) {
  const at = new Date(from);
  at.setUTCSeconds(0, 0);
  at.setUTCMinutes(minute);
  if (at < from) at.setUTCHours(at.getUTCHours() + 1);
  return at;
}

/**
 * Everything due, in the order it will be sent, with the run expected to send it:
 * batches of `budget`, one per hour from the next run (after a cooldown, if one is on).
 * No times while Similarweb refuses every run (`refused`): nothing says when it will stop.
 */
export function fetchQueue(
  candidates: Candidate[],
  config: RunConfig,
  cooling: Date | null,
  now = new Date(),
  share?: MonthShare,
  refused: Date | null = null,
  policy?: FetchPolicy,
) {
  const first = nextRunAt(cooling && cooling > now ? cooling : now, config.runMinute);
  const cadence = config.minIntervalSeconds ? config.minIntervalSeconds * 1000 : HOUR;
  if (config.minIntervalSeconds) first.setTime(Math.ceil(Math.max(now.getTime(), cooling?.getTime() ?? 0) / cadence) * cadence);
  const perRun = policy?.maxPerRun ?? config.budget;
  const due = dueQueue(candidates, now, share ? catchUpQuota(share, config.budget) : Infinity);
  const initial = due.filter((c) => !c.lastAttempt).length;
  return due.map((c, i) => ({
    domain: c.domain,
    position: i + 1,
    requester: config.priority[c.tier] ?? null,
    reason: c.reason,
    targetMonth: c.collection?.month ?? null,
    importance: c.collection?.priorityLabel ?? null,
    missing: c.collection?.missing ?? null,
    decision: c.collection?.decision ?? null,
    lastSuccessAt: c.lastSuccess ? new Date(c.lastSuccess).toISOString() : null,
    // Do not promise times beyond the known allowance or before the next probe.
    expectedAt:
      perRun &&
      !refused &&
      (!policy ||
        (i < policy.hourly.remaining &&
          (!policy.recovery || i === 0) &&
          (policy.weekly.remaining === null || i < policy.weekly.remaining) &&
          (!policy.waitingForMonth || (config.collectionEnabled ? i === 0 : initial ? !c.lastAttempt : i === 0)) &&
          (policy.weekly.limit === null ||
            first.getTime() + Math.floor(i / perRun) * cadence < new Date(policy.weekly.resetsAt).getTime())))
        ? new Date(first.getTime() + Math.floor(i / perRun) * cadence).toISOString()
        : null,
  }));
}
export type QueueEntry = ReturnType<typeof fetchQueue>[number];

/** The queue alone, for pages that only mark where a domain stands. */
export async function loadQueue(pool: Pool, config: RunConfig, now = new Date()) {
  const [candidates, cooling, share, refused, policy] = await Promise.all([
    loadCandidates(pool, config, now),
    coolingDown(pool, config, now),
    lastMonthShare(pool, now),
    refusedSince(pool),
    fetchPolicy(pool, config, now),
  ]);
  return { entries: fetchQueue(candidates, config, cooling, now, share, refused, policy), refusedSince: refused };
}

/** Worker health for /status/ and /api/v1/status. */
export async function serviceStatus(pool: Pool, config: RunConfig, now = new Date()) {
  const [
    runs,
    watchers,
    sends,
    candidates,
    cooling,
    share,
    refused,
    policy,
    collection,
    [lastSend],
    [technology],
    [radar],
    egressExperiment,
    requests,
    crux,
    untracked,
  ] = await Promise.all([
    rows<{
      id: number;
      started_at: Date;
      finished_at: Date | null;
      budget: number;
      sent: number;
      ok: number;
      failed: number;
      refused: number;
      note: string | null;
    }>(pool, 'SELECT * FROM runs ORDER BY id DESC LIMIT 24'),
    rows<{ requester: string; kind: string; n: number }>(
      pool,
      'SELECT requester, kind, COUNT(*) AS n FROM watches GROUP BY requester, kind ORDER BY requester, kind',
    ),
    rows<{ outcome: string; n: number }>(pool, 'SELECT outcome, COUNT(*) AS n FROM sends WHERE at >= ? GROUP BY outcome', [
      new Date(now.getTime() - 86_400_000),
    ]),
    loadCandidates(pool, config, now),
    coolingDown(pool, config, now),
    lastMonthShare(pool, now),
    refusedSince(pool),
    fetchPolicy(pool, config, now),
    config.collectionEnabled ? loadCollection(pool, config, collectionMonth(config, now), now) : null,
    rows<{ at: Date | null }>(pool, 'SELECT MAX(at) AS at FROM sends'),
    rows<{ at: Date | null; domains: number }>(
      pool,
      'SELECT MAX(started_at) AS at, COALESCE(SUM(IF(started_at >= ?,sent,0)),0) AS domains FROM tech_runs',
      [new Date(now.getTime() - 86_400_000)],
    ),
    rows<{ at: Date | null; requests: number }>(
      pool,
      'SELECT MAX(started_at) AS at, COALESCE(SUM(IF(started_at >= ?,sent,0)),0) AS requests FROM radar_runs',
      [new Date(now.getTime() - 86_400_000)],
    ),
    egressExperimentStatus(pool),
    recentRequestDiagnostics(pool),
    cruxStatus(pool),
    untrackedPopular(pool, 5000),
  ]);
  const queue = fetchQueue(candidates, config, cooling, now, share, refused, policy);
  const tech = techConfig();
  const sent24 = sends.reduce((n, s) => n + Number(s.n), 0);
  return {
    sourceCommit: releaseRevision(),
    throughput: collection
      ? await loadThroughput(
          pool,
          collection.month,
          collection.summary.total - collection.summary.complete,
          collection.summary.missingVisits,
          now,
        )
      : null,
    activities: {
      similarweb: {
        label: 'Similarweb 流量資料',
        destination: 'data.similarweb.com',
        usesSimilarwebQuota: true,
        lastRequestAt: lastSend?.at?.toISOString() ?? null,
        lastScheduleCheckAt: runs[0]?.started_at.toISOString() ?? null,
        last24hRequests: sent24,
        minIntervalSeconds: config.minIntervalSeconds,
        hourlyLimit: config.hourlyBudget,
        waitingCheckIntervalHours: 1,
      },
      websiteTechnology: {
        label: '網站技術掃描',
        destination: '各網站首頁',
        usesSimilarwebQuota: false,
        intervalHours: tech.intervalHours,
        maxDomainsPerBatch: tech.budget,
        pauseSeconds: tech.pauseSeconds,
        manualCacheHours: tech.manualCacheHours,
        lastRunAt: technology?.at?.toISOString() ?? null,
        last24hAutomaticDomainScans: Number(technology?.domains ?? 0),
      },
      cloudflareRadar: {
        label: 'Cloudflare Radar 排名',
        pauseSeconds: radarConfig().pauseSeconds,
        destination: 'api.cloudflare.com',
        usesSimilarwebQuota: false,
        intervalHours: 24,
        lastRunAt: radar?.at?.toISOString() ?? null,
        last24hRequests: Number(radar?.requests ?? 0),
      },
      chromeUxReport: {
        label: 'Chrome UX Report 台灣熱門度',
        destination: 'bigquery.googleapis.com',
        usesSimilarwebQuota: false,
        intervalHours: 24,
        ...crux,
      },
      storedDataApi: {
        label: '本站狀態／流量／技術查詢',
        destination: '本站資料庫',
        usesSimilarwebQuota: false,
        triggersUpstreamFetch: false,
        recommendedPollSeconds: 3600,
      },
    },
    budget: config.budget,
    /** Hosts in Chrome's Taiwan top 5,000 (latest CrUX month) that no watched domain covers. */
    cruxUntracked: { month: untracked.month, top: 5000, hosts: untracked.hosts.slice(0, 300), total: untracked.hosts.length },
    policy,
    egressExperiment,
    requests,
    collection: collection ? { month: collection.month, ...collection.summary } : null,
    priority: config.priority,
    coolingDownUntil: cooling?.toISOString() ?? null,
    refusedSince: refused?.toISOString() ?? null,
    lastMonth: { ...share, catchUpPerRun: catchUpQuota(share, config.budget) },
    watched: candidates.length,
    due: queue.length,
    queue,
    watchers: watchers.map((w) => ({ requester: w.requester, kind: w.kind, domains: Number(w.n) })),
    last24h: Object.fromEntries(sends.map((s) => [s.outcome, Number(s.n)])),
    runs: runs.map((r) => ({
      activity: r.sent ? 'provider-request' : 'schedule-check',
      destination: r.sent ? 'data.similarweb.com' : 'local-database',
      usesSimilarwebQuota: r.sent > 0,
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
      budget: r.budget,
      sent: r.sent,
      ok: r.ok,
      failed: r.failed,
      refused: !!r.refused,
      note: r.note,
    })),
  };
}
