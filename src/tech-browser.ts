import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { type Browser, chromium, type Response } from 'playwright-core';
import { MAX_HTML } from './tech.ts';
import { isPublicAddress, type Page, type PageFetcher, ScanFailure, USER_AGENT } from './tech-scan.ts';

// The second try for a homepage that answered a plain request with a WAF page or 429: Playwright's Chromium headless
// shell (the build ~/.cache/ms-playwright has for playwright-core 1.64.1), which runs the challenge's JavaScript as a
// reader's browser would. Every request the page makes goes through the same public-address check as the plain fetch
// (a page cannot reach this machine or the LAN), and images, media, fonts and stylesheets are not loaded: the rules
// read the markup, scripts and headers, not what they draw.

const NAVIGATION_TIMEOUT = 30_000;
/** How long a challenge page may take to hand over to the site. */
const SETTLE_MS = 12_000;
const SKIPPED = new Set(['image', 'media', 'font', 'stylesheet']);
const CHALLENGE_TITLE = /^(?:Just a moment|Attention Required|Access Denied|Security verification|Request blocked)/i;

export interface BrowserFetcher {
  fetchPage: PageFetcher;
  close: () => Promise<void>;
}

/** One browser, started on first use and shared by every page until close(). */
export function browserFetcher({ launch = () => chromium.launch({ headless: true }) } = {}): BrowserFetcher {
  let browser: Promise<Browser> | null = null;
  const hosts = new Map<string, Promise<boolean>>();
  const publicHost = (host: string) => {
    const bare = host.replace(/^\[|\]$/g, '');
    if (isIP(bare)) return Promise.resolve(isPublicAddress(bare));
    const known = hosts.get(bare);
    if (known) return known;
    const check = lookup(bare, { all: true }).then(
      (list) => list.length > 0 && list.every((a) => isPublicAddress(a.address)),
      () => false,
    );
    hosts.set(bare, check);
    return check;
  };
  const fetchPage: PageFetcher = async (domain) => {
    if (!(await publicHost(domain))) throw new ScanFailure('address');
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
      try {
        await page.goto(`https://${domain}/`, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
      } catch {
        await page.goto(`http://${domain}/`, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT }).catch(() => {
          throw new ScanFailure('network');
        });
      }
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
