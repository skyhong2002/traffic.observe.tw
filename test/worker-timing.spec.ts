import { describe, expect, it } from 'vitest';
import type { FetchPolicy } from '../src/fetch-policy.ts';
import { runConfig } from '../src/scheduler.ts';
import { nextPacedRun } from '../src/worker-timing.ts';

const now = new Date('2026-11-10T10:35:00Z');
const config = runConfig({ TRAFFIC_RUN_BUDGET: '15', TRAFFIC_MIN_INTERVAL_SECONDS: '240' });
const policy = (reason: FetchPolicy['reason'], resumeAt: string | null = null) => ({ reason, resumeAt }) as FetchPolicy;

describe('Similarweb worker wakeups', () => {
  it('leaves long waits to the hourly heartbeat instead of scheduling four-minute checks', () => {
    for (const reason of ['provider-cooldown', 'waiting-for-month', 'weekly-limit', 'disabled'] as const)
      expect(nextPacedRun(config, policy(reason, '2026-11-17T08:35:43Z'), now)).toBeNull();
    expect(nextPacedRun({ ...config, minIntervalSeconds: 0 }, policy(null), now)).toBeNull();
  });
  it('paces eligible requests and waits for spacing or hourly capacity before waking', () => {
    expect(nextPacedRun(config, policy(null), now)?.toISOString()).toBe('2026-11-10T10:36:00.000Z');
    expect(nextPacedRun(config, policy('request-spacing', '2026-11-10T10:39:01Z'), now)?.toISOString()).toBe('2026-11-10T10:40:00.000Z');
    expect(nextPacedRun(config, policy('hourly-limit', '2026-11-10T11:03:00Z'), now)?.toISOString()).toBe('2026-11-10T11:04:00.000Z');
  });
});
