import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect, PRODUCTS, safeSourceUrl, WAPPALYZER_NAMES } from '../src/tech.ts';
import { cookieJar, type Hop, homepageFetcher, isPublicAddress, ScanFailure, scanDomain } from '../src/tech-scan.ts';
import { compileVocabulary, loadRules, MATCH_BUDGET_MS, matchInputOf, matchTech, readPin, rulesDirectory } from '../src/wappalyzer.ts';

// Rules in the Wappalyzer format, written for these tests.
const rules = compileVocabulary(
  {
    WordPress: {
      meta: { generator: '^WordPress(?: ([\\d.]+))?\\;version:\\1' },
      dom: ["link[rel=stylesheet][href*='/wp-content/']"],
      scriptSrc: ['/wp-(?:content|includes)/'],
    },
    Hugo: { meta: { generator: 'Hugo ([\\d.]+)?\\;version:\\1' } },
    Cloudflare: { headers: { 'cf-ray': '' } },
    'Google Tag Manager': { scriptSrc: ['googletagmanager\\.com/gtm\\.js'] },
  },
  'b'.repeat(40),
  WAPPALYZER_NAMES,
);
const at = new Date('2026-10-25T03:04:05.006Z');
const page = (html: string, headers = {}) => detect(rules, { url: 'https://site.example/', html, headers, status: 200 }, at);

describe('detection', () => {
  it('reads a generator version, stamps the rule version, and keeps CDN confidence low', () => {
    const o = page('<meta name="generator" content="Hugo 0.161.1">', { 'cf-ray': 'x' });
    expect(o).toMatchObject({ status: 'detected', ruleVersion: 'wappalyzer-bbbbbbbbbbbb', sourceUrl: 'https://site.example/' });
    expect(o.detections.map((d) => [d.id, d.version, d.confidence])).toEqual([
      ['cloudflare', 'unknown', 0.4],
      ['hugo', '0.161.1', 1],
    ]);
    expect(o.detections[1].evidence).toEqual([{ kind: 'generator', value: 'Hugo 0.161.1' }]);
  });
  it('keeps the version unknown when declarations conflict, and evidence to fixed phrases', () => {
    const o = page(
      '<meta name="generator" content="WordPress 6.8"><meta name="generator" content="WordPress 6.7"><script src="/wp-includes/x.js"></script>',
    );
    expect(o.detections[0]).toMatchObject({ id: 'wordpress', version: 'unknown' });
    expect(o.detections[0].evidence).toEqual([
      { kind: 'generator', value: 'WordPress' },
      { kind: 'asset', value: 'script URL rule' },
    ]);
  });
  it('says unknown, not absent, when nothing matches', () => {
    expect(page('<p>hello</p>')).toMatchObject({ status: 'unknown', detections: [] });
  });
  it('keeps blog’s product ids, so its observations import as they are', () => {
    for (const id of [
      'wordpress',
      'blogger',
      'hugo',
      'ga',
      'gtm',
      'cloudflare',
      'githubpages',
      'wp-theme:astra',
      'wp-plugin:wordpress-seo',
    ])
      expect(PRODUCTS.has(id)).toBe(true);
  });
  it('drops queries, credentials and tracking ids from source addresses', () => {
    expect(safeSourceUrl('https://site.example/a/b?utm=1#x')).toBe('https://site.example/a/b');
    expect(safeSourceUrl('https://u:p@site.example/')).toBeNull();
    expect(safeSourceUrl('https://site.example/token/abc/GTM-ABC123')).toBe('https://site.example/redacted/redacted/redacted');
  });
});

describe('addresses', () => {
  it('refuses private, loopback, link-local and mapped private addresses', () => {
    for (const a of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:10.0.0.1',
    ])
      expect(isPublicAddress(a), a).toBe(false);
    for (const a of ['8.8.8.8', '184.84.196.184', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(a), a).toBe(true);
  });
});

/** A fake network: url → response; anything else fails to connect. */
type Answer = Partial<Omit<Hop, 'body'>> & { body?: Buffer | string };
const net = (routes: Record<string, Answer>) => {
  const seen: string[] = [];
  const get = async (url: URL) => {
    seen.push(url.href);
    const r = routes[url.href];
    if (!r) throw new ScanFailure('network');
    return {
      status: r.status ?? 200,
      headers: r.headers ?? { 'content-type': 'text/html' },
      body: Buffer.from(r.body ?? ''),
      truncated: false,
    } as Hop;
  };
  return { get, seen };
};

describe('fetching a homepage', () => {
  it('follows redirects without reading robots.txt, and records where the page came from', async () => {
    const { get, seen } = net({
      'https://a.example/robots.txt': { body: 'User-agent: *\nDisallow: /' },
      'https://a.example/': { status: 301, headers: { location: 'https://www.a.example/home?x=1' } },
      'https://www.a.example/home?x=1': { body: '<meta name="generator" content="WordPress 6.8">' },
    });
    const o = await scanDomain('a.example', rules, homepageFetcher(get), at);
    expect(o).toMatchObject({ status: 'detected', sourceUrl: 'https://www.a.example/home', httpStatus: 200 });
    expect(seen).toEqual(['https://a.example/', 'https://www.a.example/home?x=1']);
  });
  it('sends cookies set during the redirect chain back on later hops', async () => {
    const cookies: (string | undefined)[] = [];
    const get = async (url: URL, _max: number, cookie?: string): Promise<Hop> => {
      cookies.push(cookie);
      const html = { 'content-type': 'text/html' };
      if (url.href === 'https://h.example/')
        return { status: 302, headers: { location: 'https://www.h.example/' }, body: Buffer.alloc(0), truncated: false };
      if (url.href === 'https://www.h.example/' && !cookie?.includes('gate=1'))
        return {
          status: 302,
          headers: {
            location: 'https://www.h.example/',
            'set-cookie': ['gate=1; Domain=.h.example; Secure; HttpOnly', 'other=x; Domain=elsewhere.example'],
          },
          body: Buffer.alloc(0),
          truncated: false,
        };
      if (url.href === 'https://www.h.example/')
        return { status: 200, headers: html, body: Buffer.from('<meta name="generator" content="Hugo 0.1">'), truncated: false };
      throw new ScanFailure('network');
    };
    expect(await scanDomain('h.example', rules, homepageFetcher(get), at)).toMatchObject({ status: 'detected' });
    expect(cookies).toEqual([undefined, undefined, 'gate=1']);
  });
  it('keeps host-only and Secure cookies to where they belong', () => {
    const jar = cookieJar();
    jar.store(new URL('https://a.example/'), ['host=1', 'secure=1; Secure', 'wide=1; Domain=a.example']);
    expect(jar.header(new URL('https://a.example/'))).toBe('host=1; secure=1; wide=1');
    expect(jar.header(new URL('http://a.example/'))).toBe('host=1; wide=1');
    expect(jar.header(new URL('https://www.a.example/'))).toBe('wide=1');
    expect(jar.header(new URL('https://b.example/'))).toBeUndefined();
  });
  it('tries www when the bare domain does not resolve', async () => {
    const { get, seen } = net({ 'https://www.g.example/': { body: '<meta name="generator" content="Hugo 0.1">' } });
    expect(await scanDomain('g.example', rules, homepageFetcher(get), at)).toMatchObject({
      status: 'detected',
      sourceUrl: 'https://www.g.example/',
    });
    expect(seen).toEqual(['https://g.example/', 'https://www.g.example/']);
  });
  it('falls back to http when https cannot connect', async () => {
    const { get } = net({ 'http://c.example/': { body: '<meta name="generator" content="Hugo 0.1">' } });
    expect(await scanDomain('c.example', rules, homepageFetcher(get), at)).toMatchObject({
      status: 'detected',
      sourceUrl: 'http://c.example/',
    });
  });
  it('calls a WAF page or 403 blocked, a 5xx failed, and a non-HTML answer not-html', async () => {
    const scan = (r: Answer) => scanDomain('d.example', rules, homepageFetcher(net({ 'https://d.example/': r }).get), at);
    expect(await scan({ status: 403 })).toMatchObject({ status: 'blocked', errorCode: 'waf', httpStatus: 403 });
    expect(await scan({ status: 429 })).toMatchObject({ status: 'blocked', errorCode: 'rate-limit' });
    expect(await scan({ body: '<title>Just a moment...</title>' })).toMatchObject({ status: 'blocked', errorCode: 'waf' });
    expect(await scan({ body: '<script>window._cf_chl_opt={cvId:"3"}</script>' })).toMatchObject({ status: 'blocked', errorCode: 'waf' });
    expect(await scan({ body: '<title>請稍候...</title>' })).toMatchObject({ status: 'blocked', errorCode: 'waf' });
    // Cloudflare puts its challenge-platform script on ordinary pages too.
    expect(
      await scan({ body: '<title>104人力銀行</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>' }),
    ).toMatchObject({
      status: 'unknown',
    });
    expect(await scan({ status: 503 })).toMatchObject({ status: 'failed', errorCode: 'http-error' });
    expect(await scan({ headers: { 'content-type': 'application/pdf' } })).toMatchObject({ status: 'failed', errorCode: 'not-html' });
  });
  it('calls a domain with no DNS for any homepage URL dns, and a name that resolved but would not connect network', async () => {
    const failing = (codes: Record<string, 'dns' | 'network' | 'timeout'>) =>
      homepageFetcher(async (url) => {
        throw new ScanFailure(codes[url.href] ?? 'dns');
      });
    expect(await scanDomain('n.example', rules, failing({}), at)).toMatchObject({ status: 'failed', errorCode: 'dns' });
    expect(await scanDomain('n.example', rules, failing({ 'https://www.n.example/': 'network' }), at)).toMatchObject({
      status: 'failed',
      errorCode: 'network',
    });
    expect(await scanDomain('n.example', rules, failing({ 'https://n.example/': 'timeout' }), at)).toMatchObject({ errorCode: 'timeout' });
  });
  it('retries through the browser after a failed connection but not after a name that does not resolve', async () => {
    let used = 0;
    const browser = async () => {
      used++;
      return { url: 'https://www.k.example/', status: 200, headers: {}, html: '<meta name="generator" content="Hugo 0.1">' };
    };
    const plain = (code: 'network' | 'timeout' | 'dns') =>
      homepageFetcher(async () => {
        throw new ScanFailure(code);
      });
    expect(await scanDomain('k.example', rules, plain('network'), at, browser)).toMatchObject({
      status: 'detected',
      sourceUrl: 'https://www.k.example/',
    });
    expect(await scanDomain('k.example', rules, plain('timeout'), at, browser)).toMatchObject({ status: 'detected' });
    expect(used).toBe(2);
    expect(await scanDomain('k.example', rules, plain('dns'), at, browser)).toMatchObject({ status: 'failed', errorCode: 'dns' });
    expect(used).toBe(2);
    const refused = async (): Promise<never> => {
      throw new ScanFailure('network');
    };
    expect(await scanDomain('k.example', rules, plain('timeout'), at, refused)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });
  it('does not retry WAF, rate limits or HTTP errors in a browser', async () => {
    const plain = (status: number) => homepageFetcher(net({ 'https://f.example/': { status } }).get);
    const browser = async () => ({
      url: 'https://f.example/',
      status: 200,
      headers: {},
      html: '<meta name="generator" content="Hugo 0.1">',
    });
    let used = 0;
    const counted = async () => {
      used++;
      return browser();
    };
    expect(await scanDomain('f.example', rules, plain(403), at, counted)).toMatchObject({
      status: 'blocked',
      errorCode: 'waf',
    });
    expect(await scanDomain('f.example', rules, plain(429), at, counted)).toMatchObject({ status: 'blocked', errorCode: 'rate-limit' });
    expect(await scanDomain('f.example', rules, plain(503), at, counted)).toMatchObject({ status: 'failed', errorCode: 'http-error' });
    expect(used).toBe(0);
  });
  it('decodes a Big5 page by its declared charset', async () => {
    const big5 = Buffer.concat([
      Buffer.from('<meta charset="big5"><title>'),
      Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]),
      Buffer.from('</title>'),
    ]);
    const fetchPage = homepageFetcher(net({ 'https://e.example/': { body: big5 } }).get);
    expect((await fetchPage('e.example')).html).toContain('中文');
  });
});

// The pinned third-party data is GPL-3.0 and not in the repository: these run where tools/fetch-wappalyzer-rules.ts
// has installed it and are skipped elsewhere.
const installed = existsSync(join(rulesDirectory(), readPin().commit, 'categories.json'));
describe.skipIf(!installed)('the pinned Wappalyzer rules', () => {
  const pinned = loadRules(WAPPALYZER_NAMES);
  it('have every listed product', () => {
    expect(pinned.missing).toEqual([]);
    expect(pinned.products.size).toBe(PRODUCTS.size);
  });
  it.each([
    ['repeated <link', '<link rel="stylesheet" '.repeat(22_000)],
    ['repeated <script', '<script '.repeat(64_000)],
    ['repeated <div', '<div class="'.repeat(43_000)],
    ['one huge inline script', `<script>${'x'.repeat(60_000)}</script>`.repeat(8)],
  ])('are bounded on hostile input: %s', (_label, html) => {
    const { input } = matchInputOf('https://site.example/', html);
    const started = performance.now();
    for (const entries of pinned.products.values()) for (const entry of entries) matchTech(entry, input);
    expect(performance.now() - started).toBeLessThan(MATCH_BUDGET_MS * 4);
  });
});
