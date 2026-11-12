import type { FetchPolicy } from './fetch-policy.ts';
import type { RunConfig } from './scheduler.ts';

/** Long waits need only the hourly heartbeat, never four-minute zero-request runs. */
export function nextPacedRun(config: RunConfig, policy: FetchPolicy, now = new Date()) {
  if (!config.minIntervalSeconds) return null;
  const recoveryWake = policy.recovery && policy.resumeAt && ['provider-cooldown', 'recovery-probe-limit'].includes(policy.reason ?? '');
  if (policy.reason && !recoveryWake && !['request-spacing', 'hourly-limit'].includes(policy.reason)) return null;
  const interval = config.minIntervalSeconds * 1000;
  const from = Math.max(now.getTime() + 1, policy.resumeAt ? Date.parse(policy.resumeAt) : 0);
  return new Date(Math.ceil(from / interval) * interval);
}
