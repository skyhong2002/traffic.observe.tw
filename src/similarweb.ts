import { createHmac, randomUUID } from 'node:crypto';
import type { PlatformBreakdowns } from './manual-breakdowns.ts';

// The Similarweb extension endpoint and its response, ported from tag
// (app/src/media-traffic/live.ts, external.ts). Every data.similarweb.com
// request on this machine goes through requestSimilarweb, from the worker's
// run only (scheduler.ts).

export interface VisitMonth {
  month: string;
  visits: number;
}
/** Similarweb's channel shares, keyed as in its TrafficSources object. */
export const trafficChannels = [
  'Direct',
  'SearchOrganic',
  'SearchPaid',
  'SocialOrganic',
  'SocialPaid',
  'Referrals',
  'Mail',
  'DisplayAds',
  'GenAi',
  'Affiliate',
] as const;
export type TrafficChannel = (typeof trafficChannels)[number];
/** What Similarweb reports for one month besides visits. Only the latest month
 *  is returned per request, so older months only exist if they were fetched then. */
export interface TrafficProfile {
  /** Present for months copied from the platform by an editor. */
  source?: 'manual';
  /** Platform-only breakdowns; each table has its own denominator. */
  breakdowns?: PlatformBreakdowns;
  month: string;
  /** Top five countries (ISO 3166 alpha-2) and their share of visits, largest first. */
  countries: Array<{ code: string; share: number }>;
  channels: Partial<Record<TrafficChannel, number>>;
  bounceRate: number | null;
  pagesPerVisit: number | null;
  /** Average visit duration in seconds. */
  timeOnSite: number | null;
  globalRank: number | null;
  countryRank: { code: string; rank: number } | null;
  categoryRank: { category: string; rank: number } | null;
}
export interface DomainTraffic {
  domain: string;
  fetchedAt: string;
  monthly: VisitMonth[];
  profiles: Record<string, TrafficProfile>;
}
/** What the request API reports besides months: category and similar sites. */
export interface FetchSummary {
  category: string | null;
  similarSites: string[];
}

export function trafficDomain(raw: string): string | null {
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(host)
      ? host
      : null;
  } catch {
    return null;
  }
}

// Names that are not public internet domains, or are the observe services themselves.
const PRIVATE_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'test',
  'example',
  'invalid',
  'arpa',
  'onion',
  'ts.net',
  'observe.tw',
];

/**
 * A submitted domain, normalised (lower case, no www., no scheme, path or
 * port), or null when it is not a public domain: IP addresses, localhost,
 * single labels, private suffixes, user:pass@ forms and anything over 253
 * characters are refused.
 */
export function publicDomain(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 253 || /[\s@\\]/.test(raw)) return null;
  const domain = trafficDomain(raw.trim());
  if (!domain || domain.length > 253) return null;
  if (/^[\d.]+$/.test(domain) || domain.includes(':')) return null;
  if (domain.split('.').some((label) => label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return null;
  if (PRIVATE_SUFFIXES.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))) return null;
  return domain;
}

export class TrafficFetchError extends Error {
  status: number;
  retryAt: Date | null;
  httpStatus: number;
  constructor(status: number, message: string, retryAt: Date | null = null, httpStatus = status) {
    super(message);
    this.status = status;
    this.retryAt = retryAt;
    this.httpStatus = httpStatus;
  }
}
export const isRefusal = (error: unknown): error is TrafficFetchError =>
  error instanceof TrafficFetchError && [401, 403, 429].includes(error.status);

/** Retry-After can be seconds or an HTTP date. Ignore invalid/past values. */
export function retryAfter(value: string | null, now: Date): Date | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  const at = /^\d+$/.test(text) ? now.getTime() + Number(text) * 1000 : Date.parse(text);
  return Number.isFinite(at) && at > now.getTime() && at <= 8.64e15 ? new Date(at) : null;
}

/**
 * CloudFront answers 403 unless the request looks like the extension's own call:
 * a browser user agent plus the extension origin and version headers (verified 2026-10-10).
 */
export const extensionHeaders = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  origin: 'chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp',
  'x-extension-version': '6.12.26',
};

/**
 * Since extension 6.12.26 (2026-10-28) a request without X-Sw-Ctx gets 429
 * {"exceeded":true,"userState":"anonymous"} after a few a day per IP. The
 * extension sends its install's device id and an HMAC-SHA256 of
 * "<id>:<UTC date>" under a key shipped in background.js.
 */
const CTX_KEY = Buffer.from('ghQWipIhydwDGpiZQ2PczBjdwDLtjIOWvjYxU7xFEyI=', 'base64');
export const swContext = (deviceId: string, now = new Date()) =>
  `${deviceId}.${createHmac('sha256', CTX_KEY)
    .update(`${deviceId}:${now.toISOString().slice(0, 10)}`)
    .digest('hex')}`;
/** One install's id, like the extension keeps in its local storage. */
const deviceId = process.env.TRAFFIC_SIMILARWEB_DEVICE_ID || randomUUID();

/** The public endpoint used by the Similarweb extension, raw. No account cookies. */
export async function requestSimilarweb(domain: string, request = fetch, now = new Date()): Promise<Record<string, unknown>> {
  if (trafficDomain(domain) !== domain) throw Error('Invalid domain');
  const response = await request(`https://data.similarweb.com/api/v1/data?domain=${encodeURIComponent(domain)}`, {
    headers: { ...extensionHeaders, 'x-sw-ctx': swContext(deviceId, now) },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  const retryAt = retryAfter(response.headers.get('retry-after'), now);
  if (!response.ok) throw new TrafficFetchError(response.status, `Similarweb HTTP ${response.status}`, retryAt);
  const data = (await response.json()) as Record<string, unknown>;
  if (data?.exceeded === true) throw new TrafficFetchError(429, 'Similarweb usage quota exceeded (HTTP 200)', retryAt, 200);
  return data;
}

// biome-ignore lint/suspicious/noExplicitAny: the provider's JSON, checked field by field below.
export function parseDomainTraffic(data: any, domain: string, now = new Date()): DomainTraffic {
  if (typeof data.SiteName !== 'string' || trafficDomain(data.SiteName) !== domain) throw Error('Similarweb returned a different domain');
  if (!data.EstimatedMonthlyVisits || typeof data.EstimatedMonthlyVisits !== 'object' || Array.isArray(data.EstimatedMonthlyVisits))
    throw Error('Similarweb monthly visits missing');
  const months = new Map<string, number>();
  const current = now.toISOString().slice(0, 7).replace('-', '');
  for (const [date, visits] of Object.entries(data.EstimatedMonthlyVisits)) {
    const match = /^(20\d{2})-(0[1-9]|1[0-2])-01(?:T00:00:00(?:\.000)?Z)?$/.exec(date);
    if (!match || typeof visits !== 'number' || !Number.isFinite(visits) || visits < 0) throw Error('Invalid Similarweb monthly visits');
    const month = match[1] + match[2];
    if (month >= current || months.has(month)) throw Error('Invalid or duplicate Similarweb reporting month');
    months.set(month, visits);
  }
  if (!months.size) throw Error('Similarweb has no monthly visits for this domain');
  const profile = trafficProfile(data, current);
  return {
    domain,
    fetchedAt: now.toISOString(),
    monthly: [...months]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-3)
      .map(([month, visits]) => ({ month, visits })),
    profiles: profile ? { [profile.month]: profile } : {},
  };
}

const share = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);
const positive = (value: unknown) => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null;
};
const rank = (value: unknown) => {
  const number = positive(value);
  return number !== null && Number.isInteger(number) ? number : null;
};
/** The month-specific extras; null when Similarweb gives no usable reporting month.
 *  Malformed parts are dropped one by one rather than rejecting the visits. */
export function trafficProfile(data: Record<string, unknown>, currentMonth: string): TrafficProfile | null {
  const engagement = (data.Engagments ?? {}) as Record<string, unknown>;
  const year = Number(engagement.Year);
  const monthNumber = Number(engagement.Month);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) return null;
  const month = `${year}${String(monthNumber).padStart(2, '0')}`;
  if (!/^20\d{4}$/.test(month) || month >= currentMonth) return null;
  const countries = (Array.isArray(data.TopCountryShares) ? data.TopCountryShares : [])
    .map((row: Record<string, unknown>) => ({ code: row?.CountryCode, share: share(row?.Value) }))
    .filter(
      (row): row is { code: string; share: number } => typeof row.code === 'string' && /^[A-Z]{2}$/.test(row.code) && row.share !== null,
    )
    .sort((a, b) => b.share - a.share)
    .slice(0, 5);
  const sources = (data.TrafficSources ?? {}) as Record<string, unknown>;
  const channels: TrafficProfile['channels'] = {};
  for (const channel of trafficChannels) {
    const value = share(sources[channel]);
    if (value !== null) channels[channel] = value;
  }
  const countryRank = data.CountryRank as Record<string, unknown> | null;
  const categoryRank = data.CategoryRank as Record<string, unknown> | null;
  const bounce = Number(engagement.BounceRate);
  return {
    month,
    countries,
    channels,
    bounceRate: share(Number.isFinite(bounce) ? bounce : null),
    pagesPerVisit: positive(engagement.PagePerVisit),
    timeOnSite: positive(engagement.TimeOnSite),
    globalRank: rank((data.GlobalRank as Record<string, unknown> | null)?.Rank),
    countryRank:
      typeof countryRank?.CountryCode === 'string' && rank(countryRank.Rank) !== null
        ? { code: countryRank.CountryCode, rank: rank(countryRank.Rank) as number }
        : null,
    categoryRank:
      typeof categoryRank?.Category === 'string' && rank(categoryRank.Rank) !== null
        ? { category: categoryRank.Category, rank: rank(categoryRank.Rank) as number }
        : null,
  };
}

/** Category and similar sites (Competitors.TopSimilarityCompetitors; /api/v1/similar-sites is 404). */
// biome-ignore lint/suspicious/noExplicitAny: the provider's JSON, checked field by field.
export function fetchSummary(data: any, domain: string): FetchSummary {
  const competitors = data?.Competitors?.TopSimilarityCompetitors;
  const similarSites = [
    ...new Set(
      (Array.isArray(competitors) ? competitors : [])
        .map((c: unknown) =>
          typeof c === 'string' ? c : ((c as { Domain?: unknown; domain?: unknown })?.Domain ?? (c as { domain?: unknown })?.domain),
        )
        .map((d: unknown) => publicDomain(d))
        .filter((d: string | null): d is string => !!d && d !== domain),
    ),
  ].slice(0, 20) as string[];
  return { category: typeof data?.Category === 'string' ? data.Category.slice(0, 64) : null, similarSites };
}

/**
 * Similarweb answers 0 for a month it has no estimate for: small sites in some
 * months, or a subdomain it does not measure on its own (tw.news.yahoo.com).
 * Such a month is stored as received but shown as missing, never as 0 visits,
 * and its profile shares are not used either.
 */
export const estimated = (visits: number) => visits > 0;

/** The shares the GeneHong sheet multiplies visits by for 搜尋S and AI. Its 搜尋 is
 *  organic search only (tools/backtest-sheet.ts: 33 of 35 rows in 202609 match
 *  organic, 12 organic + paid). */
export const searchShare = (profile: Pick<TrafficProfile, 'channels'> | null | undefined) => profile?.channels.SearchOrganic ?? null;
export const aiShare = (profile: Pick<TrafficProfile, 'channels'> | null | undefined) => profile?.channels.GenAi ?? null;
export const taiwanShare = (profile: Pick<TrafficProfile, 'countries'> | null | undefined) =>
  profile ? (profile.countries.find((c) => c.code === 'TW')?.share ?? null) : null;
