import { existsSync } from 'node:fs';
import { load } from 'cheerio';
import Fastify from 'fastify';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { type Collection, coverageFields } from '../src/collection.ts';
import { type CollectionReportQuery, collectionReportPage, prepareCollectionReport } from '../src/collection-report.ts';
import type { ManagedSite } from '../src/metadata.ts';
import type { SiteMonth } from '../src/metrics.ts';
import { STYLE, TABLES_SCRIPT } from '../src/style.ts';

const site = (domain: string, visits: number, aiShare: number | null = 0): SiteMonth => ({
  domain,
  name: domain,
  topics: ['電商'],
  group: null,
  visits,
  prevVisits: null,
  visitsSource: 'manual',
  searchShare: 0.2,
  aiShare,
  taiwanShare: 0.9,
  taiwanShareUsed: 0.9,
  taiwanBasis: 'measured',
  taiwanShareMax: null,
  taiwanCapped: false,
  prevSearchShare: null,
  prevAiShare: null,
  channels: null,
});
const entries: Collection['entries'] = ['empty.tw', 'partial.tw', 'ready.tw', 'other.tw'].map((domain, i) => ({
  domain,
  name: domain,
  month: '202610',
  sources: [i === 3 ? 'blog' : 'sheet'],
  priority: 2,
  priorityLabel: '核心',
  priorityOverride: 0,
  score: 0,
  cruxRank: null,
  rareTags: [],
  queueScore: 0,
  ...coverageFields(null, []),
  complete: false,
  status: 'pending',
  attempts: 0,
  budgetAttempts: 0,
  lastAttemptAt: null,
  lastResult: null,
  nextAttemptAt: null,
  automatic: true,
  hasAutomatic: i === 1 || i === 2,
  hasManual: false,
  hasCommunity: false,
  communityProvenance: null,
  decision: null,
  enrolledAt: '2026-11-01T00:00:00Z',
  automaticVisitsAt: null,
  automaticProfileAt: null,
  manualUpdatedAt: null,
  lastRequestAt: null,
  lastRequestOutcome: null,
  lastRequestHttpStatus: null,
}));
const collection: Collection = {
  month: '202610',
  entries,
  queue: [],
  settings: { coreDomains: 100, maxAttempts: 3, retryHours: 48 },
  summary: {
    total: 4,
    complete: 0,
    withVisits: 0,
    partial: 0,
    missingVisits: 4,
    manualNeeded: 0,
    waitingRetry: 0,
    eligible: 4,
    priorities: [],
  },
};
const metadata: ManagedSite[] = entries.map((entry, i) => ({
  domain: entry.domain,
  name: entry.name,
  topics: i === 3 ? ['部落格'] : ['電商', '購物'],
  baseTopics: [],
  revision: 0,
  custom: false,
}));
const current = [site('partial.tw', 10, null), site('ready.tw', 20)];
const previous = [site('empty.tw', 30), site('partial.tw', 15), site('ready.tw', 25)];
const data = { entries: prepareCollectionReport(collection, current, previous, metadata), current, previous };

it('keeps labels and previous volumes for sites with no current data and all tag chips visible', () => {
  const $ = load(collectionReportPage(collection, ['202610', '202609'], '202609', data, { source: 'none', topic: '電商', exclude: '' }));
  expect($('#report-collection tbody tr')).toHaveLength(1);
  expect($('#report-collection thead th')).toHaveLength(7);
  expect($('#report-collection thead th').eq(2).text()).toContain('2026/09 造訪');
  expect($('#report-collection tbody').text()).toContain('empty.tw');
  expect($('#report-collection tbody').text()).toContain('30.00m');
  expect($('[aria-label=網站標籤]').text()).toContain('部落格');
  expect($('a[href="/site/empty.tw/manual/?month=202610"]')).toHaveLength(1);
  const sort = new URL($('th a').last().attr('href')!, 'https://site.observe.tw');
  expect(sort.searchParams.get('topic')).toBe('電商');
  expect(sort.searchParams.get('source')).toBe('none');
});
it('includes partially filled report rows, treats zero AI as known and preserves source/search filters', () => {
  const $ = load(
    collectionReportPage(collection, ['202610', '202609'], '202609', data, {
      view: 'report',
      source: 'all',
      needs: 'report',
      watchSource: 'manual',
      q: 'partial',
      exclude: '',
    }),
  );
  expect($('#report-collection tbody tr')).toHaveLength(1);
  expect($('#report-collection tbody').text()).toContain('partial.tw');
  expect($('#report-collection summary').text()).toBe('缺 1 項');
  expect(data.entries.find((entry) => entry.domain === 'ready.tw')?.missing).toEqual([]);
  const csv = new URL(
    $('a')
      .filter((_, a) => $(a).text().includes('下載報表 CSV'))
      .attr('href')!,
    'https://site.observe.tw',
  );
  expect(csv.searchParams.get('from')).toBe('202609');
  expect(csv.searchParams.get('source')).toBe('manual');
  expect(csv.searchParams.get('q')).toBe('partial');
});

it.skipIf(!existsSync(chromium.executablePath()))(
  'keeps report filters and manual-entry links usable at phone and desktop widths',
  async () => {
    const server = Fastify();
    server.get('/style.css', async (_, reply) => reply.type('text/css').send(STYLE));
    server.get('/tables.js', async (_, reply) => reply.type('text/javascript').send(TABLES_SCRIPT));
    server.get<{ Querystring: CollectionReportQuery }>('/status/collection/', async (request, reply) =>
      reply.type('text/html').send(collectionReportPage(collection, ['202610', '202609'], '202609', data, request.query)),
    );
    const origin = await server.listen({ host: '127.0.0.1', port: 0 });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin + '/status/collection/?source=none&exclude=');
      await page.getByRole('navigation', { name: '網站標籤' }).getByRole('link', { name: /^電商/ }).click();
      expect(await page.locator('#report-collection tbody tr').count()).toBe(1);
      await page.getByRole('link', { name: '查看所有報表缺資料的網站（含部分資料）' }).click();
      expect(await page.locator('#report-collection tbody tr').count()).toBe(2);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
        if (width === 1280) {
          expect(await page.locator('#report-collection').evaluate((table) => table.scrollWidth <= table.parentElement!.clientWidth)).toBe(
            true,
          );
        }
      }
      await page.getByRole('searchbox', { name: '搜尋網站名稱或網域' }).fill('partial');
      await page.getByRole('button', { name: '查看', exact: true }).click();
      expect(await page.locator('#report-collection tbody tr').count()).toBe(1);
      expect(await page.locator('#report-collection thead th').count()).toBe(7);
      expect(await page.locator('#report-collection thead th').nth(2).innerText()).toContain('2026/09 造訪');
      expect(await page.locator('.report-missing summary').innerText()).toBe('缺 1 項');
      expect(await page.locator('.report-missing li').isVisible()).toBe(false);
      await page.locator('.report-missing summary').click();
      expect(await page.locator('.report-missing li').innerText()).toBe('AI');
      expect(await page.getByRole('link', { name: '補登', exact: true }).getAttribute('href')).toBe(
        '/site/partial.tw/manual/?month=202610',
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  },
  30000,
);
