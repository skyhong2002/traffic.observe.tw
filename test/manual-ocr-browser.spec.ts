import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { registerManualOcr } from '../src/manual-ocr.ts';
import { manualPage } from '../src/metadata-pages.ts';
import { STYLE } from '../src/style.ts';

it.skipIf(!existsSync(chromium.executablePath()))(
  'recognizes actual stock screenshots locally, reviews changes and preserves drafts',
  async () => {
    const server = Fastify();
    registerManualOcr(server);
    server.get('/style.css', async (_request, reply) => reply.type('text/css').send(STYLE));
    server.get('/site/tw.stock.yahoo.com/manual/', async (_request, reply) =>
      reply
        .type('text/html')
        .send(manualPage({ domain: 'tw.stock.yahoo.com', name: 'Yahoo 股市' }, { months: [], choices: ['202610', '202609'], free: [] })),
    );
    // No traffic data or production database is used by this browser test.
    const origin = await server.listen({ host: '127.0.0.1', port: 0 });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const external: string[] = [];
      await context.route('**/*', async (route) => {
        if (route.request().url().startsWith(origin) || route.request().url().startsWith('data:')) await route.continue();
        else {
          external.push(route.request().url());
          await route.abort();
        }
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(origin + '/site/tw.stock.yahoo.com/manual/');
      await page.locator('#manual-visits').fill('30M');
      await page
        .locator('#manual-screenshots')
        .setInputFiles(
          ['channels', 'engagement'].map((name) => fileURLToPath(new URL(`./fixtures/manual-ocr/${name}.png`, import.meta.url))),
        );
      await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await page.getByRole('heading', { name: '核對辨識結果' }).waitFor({ timeout: 30_000 });
      expect(await page.locator('[data-review]').innerText()).toContain('29.54M');
      expect(await page.locator('[data-review]').innerText()).toContain('94.16');
      expect(await page.locator('#manual-visits').inputValue()).toBe('30M');
      expect(await page.getByRole('checkbox', { name: '填入月造訪量', exact: true }).isChecked()).toBe(false);
      expect(await page.getByRole('button', { name: '填入勾選欄位' }).isDisabled()).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      await page.getByRole('checkbox', { name: '填入月造訪量', exact: true }).check();
      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.getByRole('button', { name: '填入勾選欄位' }).click();
      expect(await page.locator('#manual-visits').inputValue()).toBe('29.54M');
      expect(await page.locator('#manual-duration').inputValue()).toBe('00:05:40');
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('94.16');
      expect(await page.locator('#manual-SearchPaid').inputValue()).toBe('0.00');
      expect(await page.locator('#manual-countries').inputValue()).toContain('TW 94.16');
      expect(await page.locator('[data-progress]').innerText()).toContain('尚未儲存');
      page.on('dialog', (dialog) => dialog.accept());
      await page.reload();
      expect(await page.locator('#manual-visits').inputValue()).toBe('29.54M');
      expect(await page.locator('#manual-search').inputValue()).toBe('35.20');
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
      // An interrupted model download must leave the form editable and allow retry.
      const failedContext = await browser.newContext();
      await failedContext.route('**/lang/eng.traineddata.gz', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
      const failedPage = await failedContext.newPage();
      await failedPage.goto(origin + '/site/tw.stock.yahoo.com/manual/');
      await failedPage.locator('#manual-visits').fill('30M');
      await failedPage
        .locator('#manual-screenshots')
        .setInputFiles(fileURLToPath(new URL('./fixtures/manual-ocr/engagement.png', import.meta.url)));
      await failedPage.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await failedPage
        .getByText('辨識失敗，請重新嘗試；若瀏覽器不支援辨識，也可使用下方表單手動輸入。', { exact: true })
        .waitFor({ timeout: 15_000 });
      expect(await failedPage.locator('#manual-visits').inputValue()).toBe('30M');
      expect(await failedPage.getByRole('button', { name: '辨識截圖', exact: true }).isEnabled()).toBe(true);
      await failedContext.close();
    } finally {
      await browser.close();
      await server.close();
    }
  },
  45_000,
);
