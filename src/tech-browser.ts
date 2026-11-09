import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { type Browser, chromium, type Response } from 'playwright-core';
import { MAX_HTML } from './tech.ts';
import { homepageUrls, isPublicAddress, type Page, type PageFetcher, ScanFailure, USER_AGENT } from './tech-scan.ts';

// The second try for a homepage that answered a plain request with a WAF page or 429, or would not connect or
// finish its TLS handshake (scanDomain): Playwright's Chromium headless
// shell (the build ~/.cache/ms-playwright has for playwright-core 1.64.1), which runs the challenge's JavaScript as a
// reader's browser would. Every request the page makes goes through the same public-address check as the plain fetch
// (a page cannot reach this machine or the LAN), and images, media, fonts and stylesheets are not loaded: the rules
// read the markup, scripts and headers, not what they draw.

const NAVIGATION_TIMEOUT = 15_000;
/** How long a challenge page may take to hand over to the site. */
const SETTLE_MS = 12_000;
const SKIPPED = new Set(['image', 'media', 'font', 'stylesheet']);
// Cloudflare localizes its challenge title to the browser's language (zh-TW: 請稍候…).
const CHALLENGE_TITLE = /^(?:Just a moment|請稍候|Attention Required|Access Denied|Security verification|Request blocked)/i;

export interface BrowserFetcher {
  fetchPage: PageFetcher;
  close: () => Promise<void>;
}

/** One browser, started on first use and shared by every page until close(). */
export function browserFetcher({ launch = () => chromium.launch({ headless: true }) } = {}): BrowserFetcher {
  let browser: Promise<Browser> | null = null;
  type HostState = 'public' | 'private' | 'missing' | 'error';
  const hosts = new Map<string, Promise<HostState>>();
  const hostState = (host: string): Promise<HostState> => {
    const bare = host.replace(/^\[|\]$/g, '');
    if (isIP(bare)) return Promise.resolve(isPublicAddress(bare) ? 'public' : 'private');
    const known = hosts.get(bare);
    if (known) return known;
    const check = lookup(bare, { all: true }).then(
      (list): HostState => (!list.length ? 'missing' : list.every((a) => isPublicAddress(a.address)) ? 'public' : 'private'),
      (error: NodeJS.ErrnoException): HostState => (error.code === 'ENOTFOUND' || error.code === 'ENODATA' ? 'missing' : 'error'),
    );
    hosts.set(bare, check);
    return check;
  };
  const publicHost = async (host: string) => (await hostState(host)) === 'public';
  const fetchPage: PageFetcher = async (domain) => {
    // homepageUrls tries www too (hilife.com.tw has DNS only for www), so the bare name alone does not decide.
    // Each navigation still goes through the route check below.
    const states = await Promise.all([hostState(domain), hostState(`www.${domain}`)]);
    if (!states.includes('public'))
      throw new ScanFailure(states.includes('private') ? 'address' : states.every((s) => s === 'missing') ? 'dns' : 'network');
    browser ??= launch();
    const context = await (await browser).newContext({
      userAgent: USER_AGENT,
      locale: 'zh-TW',
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    try {
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const allowed =
          ['http:', 'https:'].includes(url.protocol) &&
          !url.port &&
          !SKIPPED.has(request.resourceType()) &&
          (await publicHost(url.hostname));
        await (allowed ? route.continue() : route.abort());
      });
      const page = await context.newPage();
      // The latest main-document answer: a challenge reloads the page once it is solved.
      let document: Response | null = null;
      page.on('response', (r) => {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) document = r;
      });
      let reached = false;
      for (const url of homepageUrls(domain)) {
        reached = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT }).then(
          () => true,
          () => false,
        );
        if (reached) break;
      }
      if (!reached) throw new ScanFailure('network');
      const until = Date.now() + SETTLE_MS;
      while (Date.now() < until && CHALLENGE_TITLE.test((await page.title().catch(() => '')).trim())) await page.waitForTimeout(1000);
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined);
      const answer = document as Response | null;
      if (!answer) throw new ScanFailure('network');
      return {
        url: page.url(),
        status: answer.status(),
        headers: await answer.allHeaders(),
        html: (await page.content()).slice(0, MAX_HTML),
      } satisfies Page;
    } finally {
      await context.close().catch(() => undefined);
    }
  };
  return {
    fetchPage,
    close: async () => {
      const b = browser;
      browser = null;
      if (b) await (await b).close().catch(() => undefined);
    },
  };
}
