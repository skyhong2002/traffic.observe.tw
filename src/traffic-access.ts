import { AsyncLocalStorage } from 'node:async_hooks';

/** Request-local access, never attached to the shared data caches. */
export const trafficAccess = new AsyncLocalStorage<boolean>();
export const limitedTraffic = () => trafficAccess.getStore() === false;
export const limitRows = <T>(rows: T[]): T[] => (limitedTraffic() ? rows.slice(0, 30) : rows);
export const PUBLIC_CHANNELS = new Set(['SearchOrganic', 'Direct', 'Referrals', 'SocialOrganic', 'GenAi']);
export const visibleChannel = (key: string) => !limitedTraffic() || PUBLIC_CHANNELS.has(key);
export const twoDigits = (value: number) => Number(value.toPrecision(2));
export const trafficNumber = (value: number, digits: number) => (limitedTraffic() ? String(twoDigits(value)) : value.toFixed(digits));

const METRICS =
  /^(latestVisits|visits|prevVisits|taiwanVisits|searchVisits|aiVisits|taiwanSearchVisits|taiwanAiVisits|growth|searchShare|prevSearchShare|aiShare|prevAiShare|taiwanShare|prevTaiwanShare|taiwanShareUsed|prevTaiwanShareUsed|taiwanShareMax|similarweb|manual|sheet|share|bounceRate|pagesPerVisit|timeOnSite)$/;

/** A fresh public projection: preserve IDs, dates, ranks and counts, strip hidden breakdowns. */
export function publicTraffic<T>(data: T): T {
  if (!limitedTraffic()) return data;
  const walk = (value: unknown, key = ''): unknown => {
    if (value instanceof Date) return value;
    if (typeof value === 'number') return METRICS.test(key) ? twoDigits(value) : value;
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      if (name === 'breakdowns' || name === 'manualProfiles' || name === 'desktopChannels') continue;
      if (name === 'channels' || name === 'prevChannels' || name === 'shares') {
        out[name] =
          item == null
            ? item
            : Object.fromEntries(
                Object.entries(item)
                  .filter(([channel]) => PUBLIC_CHANNELS.has(channel))
                  .map(([channel, share]) => [channel, twoDigits(share as number)]),
              );
      } else if (name === 'countries') {
        out[name] = (item as Array<{ code: string; share: number }>)
          .filter((country) => country.code === 'TW')
          .map((country) => walk(country));
      } else if (name === 'm') {
        out[name] = Object.fromEntries(
          Object.entries(item as Record<string, unknown[]>).map(([month, row]) => [
            month,
            row.map((n, i) => (typeof n === 'number' && [0, 1, 2, 3, 5, 7].includes(i) ? twoDigits(n) : n)),
          ]),
        );
      } else out[name] = walk(item, name);
    }
    return out;
  };
  return walk(data) as T;
}
