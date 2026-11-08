import { describe, expect, it } from 'vitest';
import { utcWeek } from '../src/fetch-policy.ts';
import { runConfig } from '../src/scheduler.ts';
import { requestSimilarweb, retryAfter, TrafficFetchError } from '../src/similarweb.ts';

describe('Similarweb request policy', () => {
  it('resets on UTC Monday, including year boundaries and Taipei Monday morning', () => {
    for (const [at, start, end] of [
      ['2026-11-09T07:59:59+08:00', '2026-11-02', '2026-11-09'],
      ['2026-11-09T08:00:00+08:00', '2026-11-09', '2026-11-16'],
      ['2027-01-01T12:00:00Z', '2026-12-28', '2027-01-04'],
    ]) {
      const week = utcWeek(new Date(at));
      expect(week.start.toISOString()).toBe(`${start}T00:00:00.000Z`);
      expect(week.end.toISOString()).toBe(`${end}T00:00:00.000Z`);
    }
  });

  it('defaults to a bounded weekly allowance and never treats zero as unlimited', () => {
    expect(runConfig({})).toMatchObject({ weeklyBudget: 15, probeIntervalHours: 24, quotaCooldownHours: 168 });
    expect(runConfig({ TRAFFIC_WEEKLY_BUDGET: '0' }).weeklyBudget).toBe(0);
    expect(runConfig({ TRAFFIC_WEEKLY_BUDGET: 'auto' }).weeklyBudget).toBeNull();
    for (const value of ['-1', 'Infinity', 'NaN', '1.5', '9007199254740992', ''])
      expect(runConfig({ TRAFFIC_WEEKLY_BUDGET: value }).weeklyBudget).toBe(15);
  });

  it('reads Retry-After seconds and HTTP dates, rejecting invalid and expired values', () => {
    const now = new Date('2026-11-06T08:00:00Z');
    expect(retryAfter('3600', now)?.toISOString()).toBe('2026-11-06T09:00:00.000Z');
    expect(retryAfter('Mon, 09 Nov 2026 00:00:00 GMT', now)?.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    for (const value of [null, '', 'garbage', '0', '99999999999999999999', 'Thu, 05 Nov 2026 00:00:00 GMT'])
      expect(retryAfter(value, now)).toBeNull();
  });

  it('recognizes quota responses even with HTTP 200, preserving the actual HTTP status', async () => {
    const now = new Date('2026-11-06T08:00:00Z');
    const request = (async () =>
      new Response(JSON.stringify({ exceeded: true, userState: 'anonymous' }), {
        status: 200,
        headers: { 'retry-after': '3600' },
      })) as typeof fetch;
    await expect(requestSimilarweb('example.com', request, now)).rejects.toMatchObject({
      status: 429,
      httpStatus: 200,
      retryAt: new Date('2026-11-06T09:00:00Z'),
    });
    const refused = (async () => new Response('', { status: 429 })) as typeof fetch;
    await expect(requestSimilarweb('example.com', refused, now)).rejects.toBeInstanceOf(TrafficFetchError);
  });
});
