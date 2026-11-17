import { communityEnabled, contributorTrust } from './contributor.ts';
import { configuredNodes } from './contributor-jobs.ts';
import { type Pool, rows } from './db.ts';

/** Public, read-only summaries. A heartbeat is independent of upstream success. */
export async function contributorStatus(pool: Pool, now = new Date()) {
  const [heartbeats, jobs, activity, contributions, latest] = await Promise.all([
    rows<{ source_node: string; last_seen_at: Date }>(pool, 'SELECT source_node,last_seen_at FROM contributor_nodes'),
    rows<{
      source_node: string;
      send_id: number;
      domain: string;
      created_at: Date;
      expires_at: Date;
      claimed_at: Date | null;
      completed_at: Date | null;
      outcome: string;
      http_status: number | null;
    }>(
      pool,
      `SELECT j.source_node,j.send_id,j.domain,j.created_at,j.expires_at,j.claimed_at,j.completed_at,s.outcome,s.http_status
      FROM contributor_jobs j JOIN (SELECT source_node,MAX(send_id) AS send_id FROM contributor_jobs GROUP BY source_node) recent
      ON j.send_id=recent.send_id JOIN sends s ON s.id=j.send_id`,
    ),
    rows<{ source_node: string; outcome: string; n: number }>(
      pool,
      `SELECT j.source_node,s.outcome,COUNT(*) AS n FROM contributor_jobs j JOIN sends s ON s.id=j.send_id
       WHERE s.at>=? AND s.at<=? GROUP BY j.source_node,s.outcome`,
      [new Date(now.getTime() - 86_400_000), now],
    ),
    rows<{ source_node: string; domains: number; observations: number }>(
      pool,
      'SELECT source_node,COUNT(DISTINCT domain) AS domains,COUNT(*) AS observations FROM contributor_observations WHERE response_status BETWEEN 200 AND 299 GROUP BY source_node',
    ),
    rows<{ source_node: string; domain: string; target_month: string; fetched_at: Date; selected: number }>(
      pool,
      `SELECT o.source_node,o.domain,o.target_month,o.fetched_at,EXISTS(SELECT 1 FROM contributor_canonical c WHERE c.observation_id=o.id) AS selected
       FROM contributor_observations o JOIN (SELECT source_node,MAX(id) AS id FROM contributor_observations WHERE response_status BETWEEN 200 AND 299 GROUP BY source_node) recent ON o.id=recent.id`,
    ),
  ]);
  const configured = configuredNodes();
  const trust = contributorTrust();
  const enabled = communityEnabled();
  const ids = new Set([...configured, ...heartbeats.map((row) => row.source_node), ...contributions.map((row) => row.source_node)]);
  return {
    generatedAt: now.toISOString(),
    onlineWindowSeconds: 60,
    nodes: [...ids].sort().map((id) => {
      const heartbeat = heartbeats.find((row) => row.source_node === id);
      const job = jobs.find((row) => row.source_node === id);
      const contribution = contributions.find((row) => row.source_node === id);
      const last = latest.find((row) => row.source_node === id);
      const schedulingEnabled = enabled && configured.includes(id) && (trust[id] ?? 0) > 0;
      const online = !!heartbeat && now.getTime() - heartbeat.last_seen_at.getTime() < 60_000;
      const state = !schedulingEnabled ? 'disabled' : !heartbeat ? 'unseen' : online ? 'online' : 'offline';
      const counts = new Map(activity.filter((row) => row.source_node === id).map((row) => [row.outcome, Number(row.n)]));
      return {
        id,
        state,
        online,
        schedulingEnabled,
        lastSeenAt: heartbeat?.last_seen_at.toISOString() ?? null,
        lastRequest: job
          ? {
              sendId: job.send_id,
              domain: job.domain,
              requestedAt: job.created_at.toISOString(),
              claimedAt: job.claimed_at?.toISOString() ?? null,
              completedAt: job.completed_at?.toISOString() ?? null,
              outcome: job.outcome,
              httpStatus: job.http_status,
              expired: job.outcome === 'pending' && job.expires_at <= now,
            }
          : null,
        last24h: {
          requests: [...counts.values()].reduce((sum, n) => sum + n, 0),
          successfulRequests: counts.get('ok') ?? 0,
          refused: counts.get('refused') ?? 0,
          failed: [...counts.entries()].reduce((sum, [outcome, n]) => sum + (['ok', 'refused', 'pending'].includes(outcome) ? 0 : n), 0),
          pending: counts.get('pending') ?? 0,
        },
        contribution: {
          domains: Number(contribution?.domains ?? 0),
          observations: Number(contribution?.observations ?? 0),
          latest: last
            ? {
                domain: last.domain,
                month: last.target_month,
                fetchedAt: last.fetched_at.toISOString(),
                selected: enabled && (trust[id] ?? 0) > 0 && !!last.selected,
              }
            : null,
        },
      };
    }),
  };
}
