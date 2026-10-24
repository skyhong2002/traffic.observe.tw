import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { type Pool, rows } from './db.ts';
import { publicDomain } from './similarweb.ts';
import {
  activeRules,
  detect,
  isChallenge,
  MAX_HTML,
  safeSourceUrl,
  type TechDetection,
  type TechErrorCode,
  type TechObservation,
  type TechStatus,
} from './tech.ts';
import type { WappalyzerRules } from './wappalyzer.ts';

// Fetches each known site's homepage itself (blog used to look only at pages its crawler already had) and keeps the
// latest observation per domain. A homepage is one GET a month with a desktop Chrome user agent (as tag's crawler
// sends), without reading robots.txt: by the user's decision on 2026-10-25, since one public homepage a month is
// what a reader's browser fetches anyway and an identifying agent was turned away by WAFs; redirects are followed to public addresses only (every hop, DNS answers included), and at most 512 KiB is read.
// Successful snapshots survive later failures: a site that blocks us once keeps what it showed before.

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const HOP_TIMEOUT = 15_000;
const DOMAIN_TIMEOUT = 40_000;
const MAX_REDIRECTS = 5;
/** A successful snapshot is refreshed after this many days; failures back off 1, 2, 4… days up to it. */
export const REFRESH_DAYS = 30;

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 127],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');
// BlockList matches IPv4 addresses against IPv4-mapped IPv6 rules too, so mapped and NAT64 forms (::ffff:a.b.c.d,
// 64:ff9b::a.b.c.d) are checked as the IPv4 address they carry instead of as subnets.
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 0) return false;
  const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (embedded) return isPublicAddress(embedded);
  if (family === 6 && /^(?:::ffff:|64:ff9b::)/i.test(address)) return false;
  return !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
};

export class ScanFailure extends Error {
  code: TechErrorCode;
  status: number | null;
  constructor(code: TechErrorCode, status: number | null = null) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** DNS for our requests: every answer must be a public address, or the connection is refused. */
function publicLookup(
  hostname: string,
  options: { family?: number; all?: boolean },
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (error, addresses) => {
    if (error) return callback(error, '');
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address)))
      return callback(Object.assign(Error('non-public address'), { code: 'EADDRBLOCKED' }), '');
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

export type Hop = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean };
export type HopGet = (url: URL, maxBytes: number) => Promise<Hop>;

const decoderFor = (encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null =>
  encoding === 'gzip' || encoding === 'x-gzip'
    ? zlib.createGunzip()
    : encoding === 'deflate'
      ? zlib.createInflate()
      : encoding === 'br'
        ? zlib.createBrotliDecompress()
        : null;

/** One GET without following redirects: the status, headers and at most maxBytes of the (decoded) body. */
export const httpGet: HopGet = (url, maxBytes) =>
  new Promise((resolve, reject) => {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return reject(new ScanFailure('address'));
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, '')))
      return reject(new ScanFailure('address'));
    const fail = (error: unknown) =>
      reject(
        error instanceof ScanFailure
          ? error
          : new ScanFailure(
              (error as NodeJS.ErrnoException)?.code === 'EADDRBLOCKED'
                ? 'address'
                : (error as Error)?.message === 'timeout'
                  ? 'timeout'
                  : 'network',
            ),
      );
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      lookup: publicLookup as never,
      agent: false,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'zh-TW,zh;q=0.9,en;q=0.5',
        'accept-encoding': 'gzip, deflate, br',
      },
    });
    const timer = setTimeout(() => request.destroy(Error('timeout')), HOP_TIMEOUT);
    request.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        clearTimeout(timer);
        request.destroy();
        return resolve({ status, headers: response.headers, body: Buffer.alloc(0), truncated: false });
      }
      const decoder = decoderFor(String(response.headers['content-encoding'] ?? '').toLowerCase());
      const stream: Readable = decoder ? response.pipe(decoder) : response;
      const parts: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (truncated: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        request.destroy();
        resolve({ status, headers: response.headers, body: Buffer.concat(parts).subarray(0, maxBytes), truncated });
      };
      stream.on('data', (chunk: Buffer) => {
        parts.push(chunk);
        size += chunk.length;
        if (size >= maxBytes) finish(true);
      });
      stream.on('end', () => finish(false));
      stream.on('error', (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        request.destroy();
        fail(error);
      });
    });
  });

function charsetOf(contentType: string, body: Buffer) {
  const declared =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1];
  try {
    return new TextDecoder(declared ?? 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

export type Page = { url: string; status: number; headers: http.IncomingHttpHeaders; html: string };
export type PageFetcher = (domain: string) => Promise<Page>;

/** The homepage of a domain: https first, plain http when https cannot connect. */
export function homepageFetcher(get: HopGet = httpGet): PageFetcher {
  return async (domain) => {
    const follow = async (start: URL): Promise<Page> => {
      let url = start;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await get(url, MAX_HTML);
        const location = response.headers.location;
        if (response.status >= 300 && response.status < 400 && location) {
          url = new URL(location, url);
          continue;
        }
        const type = String(response.headers['content-type'] ?? '');
        if (response.status >= 200 && response.status < 300 && type && !/html/i.test(type))
          throw new ScanFailure('not-html', response.status);
        return {
          url: url.href,
          status: response.status,
          headers: response.headers,
          html: charsetOf(type, response.body).decode(response.body),
        };
      }
      throw new ScanFailure('http-error');
    };
    try {
      return await follow(new URL(`https://${domain}/`));
    } catch (error) {
      if (!(error instanceof ScanFailure) || !['network', 'timeout'].includes(error.code)) throw error;
      return await follow(new URL(`http://${domain}/`));
    }
  };
}

const withTimeout = <T>(work: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ScanFailure('timeout')), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

/**
 * One domain's attempt: what its homepage shows, or why there was no page. When the page is a WAF challenge or a 429
 * and a `fallback` is given (tech-browser.ts, a real browser), the homepage is tried once more through it; its result
 * is kept when it got the page.
 */
export async function scanDomain(
  domain: string,
  rules: WappalyzerRules,
  fetchPage: PageFetcher,
  at = new Date(),
  fallback?: PageFetcher,
): Promise<TechObservation> {
  const first = await scanWith(domain, rules, fetchPage, at);
  if (!fallback || first.status !== 'blocked' || !['waf', 'rate-limit'].includes(first.errorCode ?? '')) return first;
  const second = await scanWith(domain, rules, fallback, at);
  return second.status === 'detected' || second.status === 'unknown' ? second : first;
}

async function scanWith(domain: string, rules: WappalyzerRules, fetchPage: PageFetcher, at: Date): Promise<TechObservation> {
  const stop = (status: TechStatus, errorCode: TechErrorCode, httpStatus: number | null = null, sourceUrl: string | null = null) => ({
    status,
    sourceUrl,
    httpStatus,
    errorCode,
    ruleVersion: rules.version,
    at: at.toISOString(),
    detections: [],
  });
  let page: Page;
  try {
    page = await withTimeout(fetchPage(domain), DOMAIN_TIMEOUT);
  } catch (error) {
    const failure = error instanceof ScanFailure ? error : new ScanFailure('network');
    return stop('failed', failure.code, failure.status);
  }
  const source = safeSourceUrl(page.url);
  const headers = page.headers as Record<string, string | string[] | undefined>;
  if ([401, 403, 429].includes(page.status) || isChallenge(page.html, headers))
    return stop('blocked', page.status === 429 ? 'rate-limit' : 'waf', page.status, source);
  if (page.status < 200 || page.status >= 300) return stop('failed', 'http-error', page.status, source);
  return detect(rules, { url: page.url, html: page.html, headers, status: page.status }, at);
}

export interface TechRecord {
  domain: string;
  /** The latest attempt's outcome. */
  status: TechStatus;
  errorCode: TechErrorCode | null;
  httpStatus: number | null;
  lastAttemptAt: string;
  /** When the kept snapshot was taken; null when no attempt has succeeded. */
  observedAt: string | null;
  sourceUrl: string | null;
  ruleVersion: string | null;
  /** 'traffic' for our own scans, 'blog' for observations imported from blog.observe.tw. */
  origin: string;
  detections: TechDetection[];
}

/** Stores one attempt. A success replaces the snapshot; a failure keeps it. An older attempt never overwrites a newer one. */
export async function saveObservation(pool: Pool, domain: string, o: TechObservation, origin = 'traffic') {
  const at = new Date(o.at);
  if (o.status === 'detected' || o.status === 'unknown')
    await pool.query(
      `INSERT INTO tech_scans (domain, status, error_code, http_status, last_attempt_at, failures, observed_at, source_url, rule_version, detections, origin)
       VALUES (?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = IF(VALUES(last_attempt_at) >= last_attempt_at, VALUES(status), status),
         error_code = IF(VALUES(last_attempt_at) >= last_attempt_at, NULL, error_code),
         http_status = IF(VALUES(last_attempt_at) >= last_attempt_at, VALUES(http_status), http_status),
         failures = IF(VALUES(last_attempt_at) >= last_attempt_at, 0, failures),
         observed_at = IF(VALUES(last_attempt_at) >= last_attempt_at, VALUES(observed_at), observed_at),
         source_url = IF(VALUES(last_attempt_at) >= last_attempt_at, VALUES(source_url), source_url),
         rule_version = IF(VALUES(last_attempt_at) >= last_attempt_at, VALUES(rule_version), rule_version),
         detections = IF(VALUES(last_attempt_at) >= last_attempt_at, VALUES(detections), detections),
         origin = IF(VALUES(last_attempt_at) >= last_attempt_at, VALUES(origin), origin),
         last_attempt_at = GREATEST(last_attempt_at, VALUES(last_attempt_at))`,
      [domain, o.status, o.httpStatus, at, at, o.sourceUrl, o.ruleVersion, JSON.stringify(o.detections), origin],
    );
  else
    await pool.query(
      `INSERT INTO tech_scans (domain, status, error_code, http_status, last_attempt_at, failures, origin) VALUES (?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         status = IF(VALUES(last_attempt_at) >= last_attempt_at, VALUES(status), status),
         error_code = IF(VALUES(last_attempt_at) >= last_attempt_at, VALUES(error_code), error_code),
         http_status = IF(VALUES(last_attempt_at) >= last_attempt_at, VALUES(http_status), http_status),
         failures = IF(VALUES(last_attempt_at) >= last_attempt_at, failures + 1, failures),
         origin = IF(VALUES(last_attempt_at) >= last_attempt_at AND observed_at IS NULL, VALUES(origin), origin),
         last_attempt_at = GREATEST(last_attempt_at, VALUES(last_attempt_at))`,
      [domain, o.status, o.errorCode, o.httpStatus, at, origin],
    );
}

type ScanRow = {
  domain: string;
  status: TechStatus;
  error_code: TechErrorCode | null;
  http_status: number | null;
  last_attempt_at: Date;
  observed_at: Date | null;
  source_url: string | null;
  rule_version: string | null;
  detections: TechDetection[] | string | null;
  origin: string;
};
const recordOf = (r: ScanRow): TechRecord => ({
  domain: r.domain,
  status: r.status,
  errorCode: r.error_code,
  httpStatus: r.http_status,
  lastAttemptAt: r.last_attempt_at.toISOString(),
  observedAt: r.observed_at?.toISOString() ?? null,
  sourceUrl: r.source_url,
  ruleVersion: r.rule_version,
  origin: r.origin,
  detections: (typeof r.detections === 'string' ? JSON.parse(r.detections) : r.detections) ?? [],
});

/** The stored record of every domain asked for (all when left out). */
export async function loadTech(pool: Pool, domains?: string[]) {
  if (domains && !domains.length) return new Map<string, TechRecord>();
  const list = await rows<ScanRow>(
    pool,
    `SELECT domain, status, error_code, http_status, last_attempt_at, observed_at, source_url, rule_version, detections, origin
     FROM tech_scans ${domains ? 'WHERE domain IN (?)' : ''}`,
    domains ? [domains] : [],
  );
  return new Map(list.map((r) => [r.domain, recordOf(r)]));
}

/** Domains every scan covers: each service's standing list and the sheet's. */
const KNOWN = "SELECT domain FROM watches WHERE kind = 'watch' UNION SELECT domain FROM sheet_rows WHERE domain IS NOT NULL";
export const knownTechDomains = async (pool: Pool) => (await rows<{ domain: string }>(pool, KNOWN)).map((r) => r.domain);

/**
 * Due domains: never scanned first, then imported snapshots we have not tried ourselves (a failure of ours counts in
 * `failures` and leaves the imported snapshot in place), then the oldest; failures back off up to REFRESH_DAYS.
 */
export const dueDomains = async (pool: Pool, now: Date, limit: number) =>
  (
    await rows<{ domain: string }>(
      pool,
      `SELECT k.domain FROM (${KNOWN}) k LEFT JOIN tech_scans s ON s.domain = k.domain
       WHERE s.domain IS NULL OR (s.origin <> 'traffic' AND s.failures = 0)
          OR s.last_attempt_at < DATE_SUB(?, INTERVAL IF(s.status IN ('detected', 'unknown'), ${REFRESH_DAYS}, LEAST(${REFRESH_DAYS}, POW(2, GREATEST(s.failures, 1) - 1))) DAY)
       ORDER BY s.domain IS NOT NULL, s.origin = 'traffic', s.last_attempt_at, k.domain LIMIT ?`,
      [now, limit],
    )
  ).map((r) => r.domain);

export const techConfig = (env: Record<string, string | undefined> = process.env) => ({
  /** Homepages a run may fetch; 0 turns the scans off. */
  budget: Math.max(0, Math.min(500, Number(env.TRAFFIC_TECH_BUDGET ?? 60) || 0)),
});

/**
 * One hourly batch, one domain at a time, a pause between. Stops at the budget, the time limit or when `stopping`
 * says the worker is shutting down. Without installed rules nothing is fetched: an observation made without them
 * would claim 未辨識 for every site. A named lock keeps runs apart.
 */
export async function runTech(
  pool: Pool,
  {
    rules = activeRules(),
    fetchPage = homepageFetcher(),
    fallback,
    now = () => new Date(),
    budget = techConfig().budget,
    pauseMs = 1000,
    deadlineMs = 8 * 60_000,
    stopping = () => false,
    delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    rules?: WappalyzerRules | null;
    fetchPage?: PageFetcher;
    /** The second try for WAF pages (scanDomain). */
    fallback?: PageFetcher;
    now?: () => Date;
    budget?: number;
    pauseMs?: number;
    deadlineMs?: number;
    stopping?: () => boolean;
    delay?: (ms: number) => Promise<void>;
  } = {},
) {
  if (!rules) return { skipped: 'wappalyzer rules not installed (tools/fetch-wappalyzer-rules.ts)' };
  if (!budget) return { skipped: 'TRAFFIC_TECH_BUDGET is 0' };
  const conn = await pool.getConnection();
  try {
    const [[lock]] = (await conn.query("SELECT GET_LOCK('traffic-tech', 0) AS got")) as unknown as [[{ got: number }]];
    if (lock.got !== 1) return { skipped: 'another run holds the lock' };
    const due = await dueDomains(pool, now(), budget);
    const [run] = (await pool.query('INSERT INTO tech_runs (started_at, due) VALUES (?, ?)', [now(), due.length])) as unknown as [
      { insertId: number },
    ];
    const tally = { due: due.length, sent: 0, ok: 0, failed: 0, note: null as string | null };
    const deadline = Date.now() + deadlineMs;
    for (const [index, domain] of due.entries()) {
      if (stopping()) {
        tally.note = 'worker stopping';
        break;
      }
      if (Date.now() >= deadline) {
        tally.note = 'time limit reached';
        break;
      }
      if (index) await delay(pauseMs);
      tally.sent++;
      const observation = await scanDomain(domain, rules, fetchPage, now(), fallback);
      await saveObservation(pool, domain, observation);
      if (observation.status === 'detected' || observation.status === 'unknown') tally.ok++;
      else tally.failed++;
    }
    await pool.query('UPDATE tech_runs SET finished_at = ?, sent = ?, ok = ?, failed = ?, note = ? WHERE id = ?', [
      now(),
      tally.sent,
      tally.ok,
      tally.failed,
      tally.note,
      run.insertId,
    ]);
    return tally;
  } finally {
    await conn.query("SELECT RELEASE_LOCK('traffic-tech')").catch(() => undefined);
    conn.release();
  }
}

export const lastTechRun = async (pool: Pool) =>
  (
    await rows<{ started_at: Date; finished_at: Date | null; due: number; sent: number; ok: number; failed: number; note: string | null }>(
      pool,
      'SELECT started_at, finished_at, due, sent, ok, failed, note FROM tech_runs ORDER BY id DESC LIMIT 1',
    )
  )[0] ?? null;

/** A domain anyone asked about on /tech/: checked now unless an attempt is under ten minutes old. */
export async function checkNow(
  pool: Pool,
  raw: unknown,
  {
    rules = activeRules(),
    fetchPage = homepageFetcher(),
    fallback,
    now = new Date(),
  }: { rules?: WappalyzerRules | null; fetchPage?: PageFetcher; fallback?: PageFetcher; now?: Date } = {},
) {
  const domain = publicDomain(raw);
  if (!domain) return { error: 'invalid_domain' as const };
  if (!rules) return { error: 'no_rules' as const };
  const before = (await loadTech(pool, [domain])).get(domain);
  if (before && now.getTime() - Date.parse(before.lastAttemptAt) < 10 * 60_000) return { domain, record: before, fresh: false };
  await saveObservation(pool, domain, await scanDomain(domain, rules, fetchPage, now, fallback));
  return { domain, record: (await loadTech(pool, [domain])).get(domain) as TechRecord, fresh: true };
}
