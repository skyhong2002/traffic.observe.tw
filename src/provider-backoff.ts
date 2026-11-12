import { type Pool, rows } from './db.ts';
import type { RunConfig } from './scheduler.ts';
import type { TrafficFetchError } from './similarweb.ts';

const HOUR = 3_600_000;
export interface BackoffState {
  phase: 'open' | 'half-open' | 'recovering' | 'closed';
  refusals: number;
  successes: number;
  http_status: number | null;
  retry_source: string | null;
  next_attempt_at: Date | null;
  provider_retry_at: Date | null;
  last_refused_at: Date | null;
}

export async function backoffState(pool: Pool, config: RunConfig) {
  if (!config.adaptiveBackoff) return null;
  return (await rows<BackoffState>(pool, 'SELECT * FROM similarweb_backoff WHERE id = 1'))[0] ?? null;
}

/** Positive jitter never shortens the minimum wait; its sampled result is persisted once. */
export function backoffDelay(config: RunConfig, refusals: number, random = Math.random) {
  const hours = Math.min(config.backoffMaxHours, config.backoffBaseHours * 2 ** Math.min(30, Math.max(0, refusals - 1)));
  return Math.round(hours * HOUR * (1 + Math.max(0, Math.min(1, random())) * 0.1));
}

/** Called under the runner's shared database lock, before recording the domain's cooldown. */
export async function refuseProvider(pool: Pool, config: RunConfig, error: TrafficFetchError, at: Date) {
  const previous = await backoffState(pool, config);
  const refusals = Number(previous?.refusals ?? 0) + (error.status === 429 ? 1 : 0);
  const minimum = at.getTime() + config.cooldownMinutes * 60_000;
  const until = error.retryAt
    ? new Date(Math.max(minimum, error.retryAt.getTime()))
    : new Date(Math.max(minimum, at.getTime() + (error.status === 429 ? backoffDelay(config, refusals) : 0)));
  const source = error.retryAt ? 'provider' : error.status === 429 ? 'local-backoff' : 'local-refusal';
  await pool.query(
    `INSERT INTO similarweb_backoff (id,phase,refusals,successes,http_status,retry_source,next_attempt_at,provider_retry_at,last_refused_at,updated_at)
     VALUES (1,'open',?,0,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE phase='open',refusals=VALUES(refusals),successes=0,
     http_status=VALUES(http_status),retry_source=VALUES(retry_source),next_attempt_at=VALUES(next_attempt_at),
     provider_retry_at=VALUES(provider_retry_at),last_refused_at=VALUES(last_refused_at),updated_at=VALUES(updated_at)`,
    [refusals, error.status, source, until, error.retryAt, at, at],
  );
  return { until, source, refusals };
}

export async function recoveryAllowance(pool: Pool, config: RunConfig, now: Date) {
  const state = await backoffState(pool, config);
  if (!state || state.phase === 'closed') return null;
  const [usage] = await rows<{ n: number; oldest: Date | null; latest: Date | null }>(
    pool,
    'SELECT COUNT(*) AS n,MIN(at) AS oldest,MAX(at) AS latest FROM sends WHERE recovery_probe=1 AND at > ? AND at <= ?',
    [new Date(now.getTime() - 24 * HOUR), now],
  );
  const used = Number(usage?.n ?? 0);
  return {
    phase: state.phase,
    refusals: Number(state.refusals),
    successes: Number(state.successes),
    requiredSuccesses: config.recoverySuccesses,
    source: state.retry_source,
    providerRetryAt: state.provider_retry_at?.toISOString() ?? null,
    nextAttemptAt: state.next_attempt_at?.toISOString() ?? null,
    intervalMinutes: config.recoveryIntervalMinutes,
    limit: config.recoveryDailyBudget,
    used,
    remaining: Math.max(0, config.recoveryDailyBudget - used),
    budgetResumesAt:
      used >= config.recoveryDailyBudget && usage?.oldest ? new Date(usage.oldest.getTime() + 24 * HOUR).toISOString() : null,
    spacingUntil: usage?.latest ? new Date(usage.latest.getTime() + config.recoveryIntervalMinutes * 60_000).toISOString() : null,
  };
}

export async function reserveRecovery(pool: Pool, config: RunConfig, at: Date) {
  await pool.query("UPDATE similarweb_backoff SET phase='half-open',next_attempt_at=?,updated_at=? WHERE id=1 AND phase<>'closed'", [
    new Date(at.getTime() + config.backoffBaseHours * HOUR),
    at,
  ]);
}

/** Only a parsed, saved response counts as recovery. One response never resets a refusal streak. */
export async function finishRecovery(pool: Pool, config: RunConfig, at: Date, success: boolean) {
  const state = await backoffState(pool, config);
  if (!state || state.phase === 'closed') return;
  const successes = success ? Number(state.successes) + 1 : 0;
  const closed = successes >= config.recoverySuccesses;
  await pool.query(
    'UPDATE similarweb_backoff SET phase=?,refusals=?,successes=?,retry_source=?,next_attempt_at=?,updated_at=? WHERE id=1',
    [
      closed ? 'closed' : success ? 'recovering' : 'open',
      closed ? 0 : state.refusals,
      successes,
      closed ? null : success ? 'local-recovery' : 'local-error',
      closed ? null : new Date(at.getTime() + (success ? config.recoveryIntervalMinutes * 60_000 : config.backoffBaseHours * HOUR)),
      at,
    ],
  );
}
