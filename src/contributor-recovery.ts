import type { JobResult } from './contributor-jobs.ts';
import { type Pool, rows } from './db.ts';
import { refuseProvider } from './provider-backoff.ts';
import type { RunConfig } from './scheduler.ts';
import { retryAfter, TrafficFetchError } from './similarweb.ts';

/** Apply a persisted refusal if the worker exited before consuming the result. */
export async function recoverContributorRefusals(pool: Pool, config: RunConfig, now = new Date()) {
  const connection = await pool.getConnection();
  try {
    const [lock] = await rows<{ got: number }>(connection, "SELECT GET_LOCK('traffic-similarweb',0) AS got");
    if (lock.got !== 1) return;
    const jobs = await rows<{ send_id: number; domain: string; result: string }>(
      pool,
      "SELECT j.send_id,j.domain,j.result FROM contributor_jobs j JOIN sends s ON s.id=j.send_id WHERE j.completed_at IS NOT NULL AND j.consumed_at IS NULL AND s.outcome IN ('pending','error') ORDER BY j.send_id",
    );
    for (const job of jobs) {
      const result: JobResult = JSON.parse(job.result);
      const reply = result.reply;
      if (!reply) continue;
      let status = reply.status;
      if (status === 200) {
        try {
          if (JSON.parse(reply.body)?.exceeded === true) status = 429;
        } catch {
          /* malformed JSON is not a refusal */
        }
      }
      if (![401, 403, 429].includes(status)) continue;
      const error = new TrafficFetchError(
        status,
        `Similarweb HTTP ${status} (recovered contributor result)`,
        retryAfter(reply.headers['retry-after'] ?? null, now),
        reply.status,
      );
      const adaptive = config.adaptiveBackoff ? await refuseProvider(pool, config, error, now) : null;
      const until =
        adaptive?.until ??
        error.retryAt ??
        new Date(now.getTime() + (status === 429 ? config.quotaCooldownHours * 3_600_000 : config.cooldownMinutes * 60_000));
      await pool.query('UPDATE fetch_state SET refused_at=?,retry_after_at=?,next_attempt_at=NULL,last_error=? WHERE domain=?', [
        now,
        until,
        error.message,
        job.domain,
      ]);
      await pool.query("UPDATE sends SET outcome='refused',http_status=? WHERE id=?", [reply.status, job.send_id]);
      if (config.queueOptimization)
        await pool.query('UPDATE queue_canaries SET rolled_back_at=?,reason=? WHERE id=? AND rolled_back_at IS NULL', [
          now,
          'provider refusal: baseline restored',
          config.queueCanary,
        ]);
      await pool.query('UPDATE contributor_jobs SET consumed_at=? WHERE send_id=?', [now, job.send_id]);
    }
  } finally {
    await connection.query("SELECT RELEASE_LOCK('traffic-similarweb')").catch(() => undefined);
    connection.release();
  }
}
