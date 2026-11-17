import { existsSync } from 'node:fs';
import { load } from 'cheerio';
import Fastify from 'fastify';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { apiDocsPage } from '../src/api-docs.ts';
import { type Collection, coverageFields } from '../src/collection.ts';
import { collectionPage, sortCollectionEntries } from '../src/collection-pages.ts';
import { layout, section, table, tableDescription } from '../src/pages.ts';
import { STYLE, TABLES_SCRIPT } from '../src/style.ts';

const coverage = coverageFields(null, []);
const entries: Collection['entries'] = Array.from({ length: 121 }, (_, i) => ({
  domain: `site-${i}.example.tw`,
  month: '202610',
  name: i === 0 ? '測試網站名稱非常長也必須維持單行顯示以便瀏覽更多筆資料' : `測試網站 ${i}`,
  sources: [],
  priority: 2,
  priorityLabel: '核心',
  priorityOverride: 0,
  score: 121 - i,
  cruxRank: null,
  rareTags: [],
  queueScore: 0,
  ...coverage,
  complete: false,
  status: 'retry-wait',
  attempts: 10,
  budgetAttempts: 2,
  lastAttemptAt: null,
  lastResult: null,
  nextAttemptAt: '2026-11-11T01:30:00Z',
  automatic: false,
  hasAutomatic: false,
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
    total: 121,
    complete: 0,
    withVisits: 0,
    partial: 0,
    missingVisits: 121,
    manualNeeded: 0,
    waitingRetry: 121,
    eligible: 0,
    priorities: [2, 100, 10, 9].map((total, i) => ({ priority: i + 1, label: ['必抓', '核心', '台灣', '其他'][i], total, complete: 0 })),
  },
};

it('lists only sites without automatic or manual data in the selected month', () => {
  const fixture = {
    ...collection,
    entries: [entries[0], { ...entries[1], hasAutomatic: true }, { ...entries[2], hasManual: true }, { ...entries[3], hasCommunity: true }],
  };
  const page = load(collectionPage(fixture, ['202610'], false, 'all', 0, 1, '', 'none'));
  expect(page('h1').text()).toBe('2026/10 尚未有資料的網站');
  expect(page('#collection-entries tbody tr')).toHaveLength(1);
  expect(page('#collection-entries .collection-site a').attr('href')).toBe('/site/site-0.example.tw/');
});

it('sorts the whole collection by saved update time before pagination, keeps unknowns last, and preserves worker ordering', () => {
  const ordered: Collection['entries'] = entries.map((entry, i) => ({
    ...entry,
    automaticVisitsAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
  }));
  ordered[0] = { ...ordered[0], automaticVisitsAt: null, lastRequestAt: '2026-11-12T10:00:00Z', lastRequestOutcome: 'refused' };
  ordered[1] = { ...ordered[1], manualUpdatedAt: '2026-11-11T00:00:00Z' };
  ordered[120] = { ...ordered[120], complete: true, missing: [], status: 'complete' };
  const fixture = { ...collection, entries: ordered };
  const first = load(collectionPage(fixture, ['202610'], true));
  expect(first('#collection-entries tbody tr').first().find('.collection-site a').attr('href')).toBe('/site/site-1.example.tw/');
  expect(first('#collection-entries tbody tr').eq(1).find('.collection-site a').attr('href')).toBe('/site/site-120.example.tw/');
  expect(first('th[aria-sort=descending]').text()).toContain('最新更新');
  expect(first('#collection-entries .favicon img')).toHaveLength(100);
  const next = new URL(first('a[rel=next]').attr('href')!, 'https://example.tw');
  expect(next.searchParams.get('sort')).toBe('updated-desc');
  expect(next.searchParams.get('state')).toBe('all');
  expect(sortCollectionEntries(ordered).at(-1)?.domain).toBe(ordered[0].domain);
  expect(sortCollectionEntries(ordered, 'updated-asc').at(-1)?.domain).toBe(ordered[0].domain);
  expect(sortCollectionEntries(ordered, 'request-desc')[0].domain).toBe(ordered[0].domain);
  expect(sortCollectionEntries(ordered, 'priority')).toEqual(ordered);
  expect(ordered[0].domain).toBe('site-0.example.tw');
});

it.skipIf(!existsSync(chromium.executablePath()))(
  'keeps collection rows, editing and pagination usable at desktop and phone widths',
  async () => {
    const server = Fastify();
    server.get('/style.css', async (_, reply) => reply.type('text/css').send(STYLE));
    server.get('/tables.js', async (_, reply) => reply.type('text/javascript').send(TABLES_SCRIPT));
    server.get<{ Querystring: { page?: string; state?: string; priority?: string; source?: string; sort?: string } }>(
      '/status/collection/',
      async (request, reply) =>
        reply
          .type('text/html')
          .send(
            collectionPage(
              collection,
              ['202610'],
              true,
              request.query.state ?? 'all',
              Number(request.query.priority) || 0,
              Number(request.query.page) || 1,
              '',
              request.query.source ?? 'all',
              undefined,
              request.query.sort,
            ),
          ),
    );
    server.get('/api/', async (_, reply) => reply.type('text/html').send(apiDocsPage('https://site.observe.tw')));
    server.get('/descriptions/', async (_, reply) =>
      reply
        .type('text/html')
        .send(
          layout(
            '說明',
            { title: '說明' },
            section(
              '紀錄',
              table(
                '<th class="l">工作</th><th class="num">次數</th><th class="l">備註</th>',
                [2, 100, 10]
                  .map(
                    (n) =>
                      `<tr><td class="l">工作 ${n}</td><td class="num">${n}</td><td class="l prose-cell">${tableDescription('長篇說明及網址 https://example.tw/'.repeat(20))}</td></tr>`,
                  )
                  .join(''),
                '',
                3,
                '',
                { pin: false },
              ),
            ),
          ),
        ),
    );
    const origin = await server.listen({ host: '127.0.0.1', port: 0 });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin + '/status/collection/?state=all&priority=2');
      await page.locator('#collection-entries.data-table').waitFor();
      expect(await page.locator('#collection-entries tbody tr:visible').count()).toBe(100);
      expect(await page.locator('.table-more:visible').count()).toBe(0);
      expect(await page.locator('#collection-entries th button').count()).toBe(0);
      expect(await page.locator('#collection-entries .favicon').count()).toBe(100);
      expect(await page.locator('th[aria-sort=descending]').innerText()).toContain('最新更新');
      expect(await page.locator('#collection-entries').evaluate((t) => t.scrollWidth <= t.parentElement!.clientWidth)).toBe(true);
      expect(await page.locator('.collection-missing').evaluateAll((cells) => cells.every((c) => c.scrollWidth <= c.clientWidth))).toBe(
        true,
      );
      const toggle = page.getByRole('button', { name: '深色模式', exact: true });
      expect(await toggle.getAttribute('aria-pressed')).toBe('true');
      expect(await toggle.locator('.theme-sun').isVisible()).toBe(true);
      await toggle.click();
      expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
      expect(await toggle.locator('.theme-moon').isVisible()).toBe(true);
      expect(await page.evaluate('getComputedStyle(document.documentElement).backgroundColor')).toBe('rgb(255, 255, 255)');
      await page.reload();
      expect(await toggle.getAttribute('aria-pressed')).toBe('false');
      expect(await page.evaluate("localStorage.getItem('theme')")).toBe('light');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.emulateMedia({ colorScheme: 'dark' });
      expect(await toggle.getAttribute('aria-pressed')).toBe('false');
      await toggle.click();
      expect(await page.evaluate("localStorage.getItem('theme')")).toBe(null);
      expect(await page.evaluate('getComputedStyle(document.documentElement).backgroundColor')).toBe('rgb(10, 10, 10)');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction("document.documentElement.dataset.theme === 'light'");
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction("document.documentElement.dataset.theme === 'dark'");
      const form = page.locator('.priority-form').first();
      await page.locator('.collection-edit > summary').first().click();
      expect(await form.locator('[name=state]').inputValue()).toBe('all');
      expect(await form.locator('[name=filterPriority]').inputValue()).toBe('2');
      expect(
        await form.locator('button').evaluate((b) => b.getBoundingClientRect().right <= b.closest('td')!.getBoundingClientRect().right),
      ).toBe(true);
      await page.locator('.collection-overview > summary').click();
      await page.locator('#collection-summary').getByRole('button', { name: '追蹤' }).click();
      expect(await page.locator('#collection-summary tbody tr').first().innerText()).toContain('100');
      const missing = page.locator('.collection-missing').first();
      expect(await missing.innerText()).toContain('缺 11 項');
      expect(await missing.locator('li').first().isVisible()).toBe(false);
      expect(
        await page
          .locator('#collection-entries tbody tr')
          .nth(1)
          .evaluate((r) => r.getBoundingClientRect().height),
      ).toBeLessThanOrEqual(40);
      await missing.locator('summary').click();
      expect(await missing.locator('li').count()).toBe(11);
      expect(await missing.innerText()).toContain('渠道：自然搜尋');
      await missing.locator('summary').click();
      for (const width of [768, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
        expect(await page.locator('.collection-missing').evaluateAll((cells) => cells.every((c) => c.scrollWidth <= c.clientWidth))).toBe(
          true,
        );
        const scroller = page.locator('#collection-entries').locator('..');
        await scroller.evaluate((e) => {
          e.scrollLeft = e.scrollWidth;
        });
        await page.waitForFunction("document.querySelector('#collection-entries').parentElement.dataset.scrollX === 'end'");
        const action = page.locator('#collection-entries tbody tr').first().getByRole('link', { name: '補登', exact: true });
        expect(
          await action.evaluate((e) => {
            const box = e.getBoundingClientRect();
            const viewport = e.closest('.scroll')!.getBoundingClientRect();
            return box.right <= viewport.right && box.left >= viewport.left;
          }),
        ).toBe(true);
        expect(await page.locator('.table-scroll-hint').count()).toBe(0);
      }
      await page.getByRole('navigation', { name: '逐站缺漏上方分頁' }).getByRole('link', { name: '下一頁' }).click();
      expect(new URL(page.url()).searchParams.get('priority')).toBe('2');
      expect(new URL(page.url()).searchParams.get('sort')).toBe('updated-desc');
      expect(await page.locator('#collection-entries tbody tr:visible').count()).toBe(21);
      expect(await page.locator('.priority-form [name=page]').first().inputValue()).toBe('2');
      await page.getByRole('link', { name: '最近抓取', exact: true }).click();
      expect(new URL(page.url()).searchParams.get('sort')).toBe('request-desc');
      expect(await page.locator('th[aria-sort=descending]').innerText()).toContain('最近抓取');
      await page.getByRole('link', { name: '最近抓取', exact: true }).click();
      expect(new URL(page.url()).searchParams.get('sort')).toBe('request-asc');
      expect(await page.locator('th[aria-sort=ascending]').innerText()).toContain('最近抓取');
      await page.goto(origin + '/status/collection/?state=complete');
      expect(await page.locator('.empty').innerText()).toBe('沒有符合條件的網域。');
      expect(await page.locator('.pagination').innerText()).toContain('第 1 / 1 頁');
      expect(await page.locator('.pagination a').count()).toBe(0);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(origin + '/api/');
        expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
        await page.goto(origin + '/descriptions/');
        await page.locator('.data-table').waitFor();
        expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
        const description = page.locator('.prose-cell').first();
        expect(await description.innerText()).toBe('長篇說明及網址 https://example.tw/'.repeat(20));
        expect(await description.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
        expect(await page.locator('.table-lead').count()).toBe(0);
        await page.getByRole('button', { name: '次數' }).click();
        expect(await page.locator('tbody tr td:nth-child(2)').first().innerText()).toBe('100');
      }
      await page.setViewportSize({ width: 320, height: 844 });
      await page.goto(origin + '/status/collection/?source=none');
      expect(await page.locator('.subnav [aria-current=page]').innerText()).toBe('尚未有資料');
      expect(await page.locator('.subnav a:visible').count()).toBe(2);
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      const noScript = await browser.newContext({ javaScriptEnabled: false });
      const plainPage = await noScript.newPage();
      await plainPage.goto(origin + '/status/collection/');
      expect(await plainPage.locator('#collection-entries tbody tr:visible').count()).toBe(100);
      await plainPage.locator('.collection-missing > summary').first().click();
      expect(await plainPage.locator('.collection-missing').first().innerText()).toContain('渠道：自然搜尋');
      await plainPage.goto(origin + '/descriptions/');
      expect(await plainPage.locator('.prose-cell').first().isVisible()).toBe(true);
      await noScript.close();
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  },
  30_000,
);
