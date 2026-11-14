import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { registerManualOcr } from '../src/manual-ocr.ts';
import { manualPage } from '../src/metadata-pages.ts';
import { STYLE } from '../src/style.ts';

it.skipIf(!existsSync(chromium.executablePath()))(
  'recognizes platform and extension screenshots locally, reviews changes and preserves drafts',
  async () => {
    const server = Fastify();
    registerManualOcr(server);
    server.get('/style.css', async (_request, reply) => reply.type('text/css').send(STYLE));
    server.get<{ Params: { domain: string } }>('/site/:domain/manual/', async (request, reply) =>
      reply
        .type('text/html')
        .send(
          manualPage(
            { domain: request.params.domain, name: request.params.domain },
            { months: [], choices: ['202610', '202609'], free: [] },
          ),
        ),
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

      await page.goto(origin + '/site/matsu.idv.tw/manual/');
      await page
        .locator('#manual-screenshots')
        .setInputFiles(
          ['extension-engagement', 'extension-geography'].map((name) =>
            fileURLToPath(new URL(`./fixtures/manual-ocr/${name}.png`, import.meta.url)),
          ),
        );
      await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await page.getByRole('heading', { name: '核對辨識結果' }).waitFor({ timeout: 30_000 });
      const extensionReview = await page.locator('[data-review]').innerText();
      expect(extensionReview).toContain('416.5K');
      expect(extensionReview).toContain('97.02');
      expect(extensionReview).toContain('Desktop Only');
      expect(extensionReview).toContain('60.69');
      expect(await page.getByRole('checkbox', { name: '填入桌面限定・直接造訪', exact: true }).isChecked()).toBe(true);
      expect(await page.getByRole('checkbox', { name: '填入直接造訪', exact: true }).count()).toBe(0);
      expect(await page.locator('#manual-visits').inputValue()).toBe('');
      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.getByRole('button', { name: '填入勾選欄位' }).click();
      expect(await page.locator('#manual-visits').inputValue()).toBe('416.5K');
      expect(await page.locator('#manual-pages').inputValue()).toBe('3.34');
      expect(await page.locator('#manual-duration').inputValue()).toBe('00:05:40');
      expect(await page.locator('#manual-bounce').inputValue()).toBe('44.43');
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('97.02');
      expect(await page.locator('#manual-countries').inputValue()).toContain('TW 97.02\nUS 1.76\nHK 0.73\nJP 0.3');
      expect(await page.locator('#manual-desktop_Direct').inputValue()).toBe('60.69');
      expect(await page.locator('#manual-Direct').inputValue()).toBe('');
      expect(await page.locator('#manual-search').inputValue()).toBe('');
      expect(await page.locator('[data-progress]').innerText()).toContain('尚未儲存');

      // The reported failure: a Country card without its Top 5 title, followed
      // by Desktop Only sources. It must also work when selected by itself.
      await page.goto(origin + '/site/s3.com.tw/manual/');
      await page
        .locator('#manual-screenshots')
        .setInputFiles(fileURLToPath(new URL('./fixtures/manual-ocr/s3-geography.png', import.meta.url)));
      await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await page.getByRole('heading', { name: '核對辨識結果' }).waitFor({ timeout: 30_000 });
      expect(await page.getByRole('checkbox', { name: '填入台灣占比', exact: true }).count()).toBe(1);
      expect(await page.locator('[data-review]').innerText()).toContain('93.23');
      expect(await page.locator('[data-review]').innerText()).toContain('38.72');
      expect(await page.locator('[data-review]').innerText()).toContain('4.67');
      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.getByRole('button', { name: '填入勾選欄位' }).click();
      expect(await page.locator('#manual-countries').inputValue()).toBe('TW 93.23\nUS 2.13\nHK 1.59\nID 0.58\nMY 0.57');
      expect(await page.locator('#manual-desktop_SearchOrganic').inputValue()).toBe('38.72');
      expect(await page.locator('#manual-desktop_Affiliate').inputValue()).toBe('4.67');
      expect(await page.locator('#manual-search').inputValue()).toBe('');
      expect(await page.locator('#manual-ai').inputValue()).toBe('');
      expect(await page.locator('#manual-visits').inputValue()).toBe('');
      expect(await page.locator('[data-desktop-channels]').getAttribute('open')).toBe('');
      await page
        .locator('#manual-screenshots')
        .setInputFiles(fileURLToPath(new URL('./fixtures/manual-ocr/s3-engagement.png', import.meta.url)));
      await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await page.getByRole('heading', { name: '核對辨識結果' }).waitFor({ timeout: 30_000 });
      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.getByRole('button', { name: '填入勾選欄位' }).click();
      expect(await page.locator('#manual-visits').inputValue()).toBe('482.4K');
      expect(await page.locator('#manual-pages').inputValue()).toBe('5.66');
      expect(await page.locator('#manual-duration').inputValue()).toBe('00:00:57');
      expect(await page.locator('#manual-bounce').inputValue()).toBe('71.01');
      await page.reload();
      expect(await page.locator('#manual-desktop_SearchOrganic').inputValue()).toBe('38.72');
      expect(await page.locator('#manual-visits').inputValue()).toBe('482.4K');
      // Fresh tabs avoid drafts masking an omitted country. Test the normal
      // engagement-first order and the compressed image that loses the Taiwan label.
      for (const names of [['s3-engagement.png', 's3-geography.png'], ['s3-geography-compressed.jpg']]) {
        const fresh = await context.newPage();
        fresh.on('pageerror', (e) => errors.push(e.message));
        await fresh.goto(origin + '/site/s3.com.tw/manual/');
        expect(await fresh.locator('#manual-taiwan').inputValue()).toBe('');
        await fresh
          .locator('#manual-screenshots')
          .setInputFiles(names.map((name) => fileURLToPath(new URL(`./fixtures/manual-ocr/${name}`, import.meta.url))));
        await fresh.getByRole('button', { name: '辨識截圖', exact: true }).click();
        await fresh.getByRole('heading', { name: '核對辨識結果' }).waitFor({ timeout: 30_000 });
        expect(await fresh.getByRole('checkbox', { name: '填入台灣占比', exact: true }).isChecked()).toBe(true);
        await fresh.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
        await fresh.getByRole('button', { name: '填入勾選欄位' }).click();
        expect(await fresh.locator('#manual-taiwan').inputValue()).toBe('93.23');
        expect(await fresh.locator('#manual-countries').inputValue()).toContain('TW 93.23');
        if (names.length === 2) {
          expect(await fresh.locator('#manual-visits').inputValue()).toBe('482.4K');
          expect(await fresh.locator('#manual-countries').inputValue()).toBe('TW 93.23\nUS 2.13\nHK 1.59\nID 0.58\nMY 0.57');
        }
        await fresh.close();
      }
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
  60_000,
);
