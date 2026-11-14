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
      expect(await page.getByRole('textbox', { name: '核對月造訪量', exact: true }).inputValue()).toBe('29.54M');
      expect(await page.getByRole('textbox', { name: '核對台灣占比', exact: true }).inputValue()).toBe('94.16');
      expect(await page.locator('#manual-visits').inputValue()).toBe('30M');
      expect(await page.getByRole('checkbox', { name: '填入月造訪量', exact: true }).isChecked()).toBe(false);
      expect(await page.locator('#ocr-apply').isDisabled()).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      await page.getByRole('textbox', { name: '核對月造訪量', exact: true }).fill('29.54M');
      expect(await page.getByRole('checkbox', { name: '填入月造訪量', exact: true }).isChecked()).toBe(false);
      await page.getByRole('checkbox', { name: '填入月造訪量', exact: true }).check();
      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.locator('#ocr-apply').click();
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
      expect(await page.getByRole('button', { name: '顯示全部欄位' }).isVisible()).toBe(true);
      expect(await page.locator('.ocr-source-disclosure').getAttribute('open')).toBeNull();
      await page.locator('.ocr-field-row.is-active input:not([type=checkbox]), .ocr-field-row.is-active textarea').focus();
      await page.keyboard.press('Tab');
      expect(await page.evaluate('document.activeElement?.textContent')).toBe('核對下一欄 →');
      await page.keyboard.press('Enter');
      expect(await page.locator('.ocr-field-position').innerText()).toContain('第 2');
      await page.getByRole('button', { name: '顯示全部欄位' }).click();
      const extensionReview = await page.locator('[data-review]').innerText();
      expect(await page.getByRole('textbox', { name: '核對月造訪量', exact: true }).inputValue()).toBe('416.5K');
      expect(await page.getByRole('textbox', { name: '核對台灣占比', exact: true }).inputValue()).toBe('97.02');
      expect(extensionReview).toContain('Desktop Only');
      expect(await page.getByRole('textbox', { name: '核對桌面限定・直接造訪', exact: true }).inputValue()).toBe('60.69');
      expect(await page.getByRole('checkbox', { name: '填入桌面限定・直接造訪', exact: true }).isChecked()).toBe(true);
      expect(await page.getByRole('checkbox', { name: '填入直接造訪', exact: true }).count()).toBe(0);
      expect(await page.locator('#manual-visits').inputValue()).toBe('');
      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.locator('#ocr-apply').click();
      expect(await page.locator('#manual-visits').inputValue()).toBe('416.5K');
      expect(await page.locator('#manual-pages').inputValue()).toBe('3.34');
      expect(await page.locator('#manual-duration').inputValue()).toBe('00:05:40');
      expect(await page.locator('#manual-bounce').inputValue()).toBe('44.43');
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('97.02');
      expect(await page.locator('#manual-countries').inputValue()).toContain('TW 97.02\nUS 1.76\nHK 0.73\nJP 0.3');
      expect(await page.locator('#manual-desktop_Direct').inputValue()).toBe('60.69');
      await page.locator('.ocr-review-actions').getByRole('button', { name: '前往表單儲存 ↓', exact: true }).click();
      expect(await page.evaluate('document.activeElement?.id')).toBe('manual-visits');
      expect(await page.locator('#manual-Direct').inputValue()).toBe('');
      expect(await page.locator('#manual-search').inputValue()).toBe('');
      expect(await page.locator('[data-progress]').innerText()).toContain('尚未儲存');

      // The reported failure: a Country card without its Top 5 title, followed
      // by Desktop Only sources. It must also work when selected by itself.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(origin + '/site/s3.com.tw/manual/');
      await page.locator('#manual-screenshots').setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
      expect(await page.locator('[data-progress]').innerText()).toContain('bad.txt');
      expect(await page.getByRole('button', { name: '辨識截圖', exact: true }).isDisabled()).toBe(true);
      await page
        .locator('#manual-screenshots')
        .setInputFiles(fileURLToPath(new URL('./fixtures/manual-ocr/s3-geography.png', import.meta.url)));
      await page.locator('[data-desktop-channels] > summary').click();
      await page.locator('#manual-desktop_SearchOrganic').fill('40');
      await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await page.getByRole('heading', { name: '核對辨識結果' }).waitFor({ timeout: 30_000 });
      expect(await page.getByRole('checkbox', { name: '填入台灣占比', exact: true }).count()).toBe(1);
      expect(await page.getByRole('textbox', { name: '核對台灣占比', exact: true }).inputValue()).toBe('93.23');
      expect(await page.getByRole('textbox', { name: '核對桌面限定・自然搜尋', exact: true }).inputValue()).toBe('38.72');
      expect(await page.getByRole('textbox', { name: '核對桌面限定・聯盟行銷', exact: true }).inputValue()).toBe('4.67');
      await page.getByRole('button', { name: '定位國家占比', exact: true }).click();
      await page.getByRole('textbox', { name: '美國占比', exact: true }).fill('2.14');
      expect(await page.locator('#ocr-edit-countries').inputValue()).toContain('US 2.14');
      await page.getByRole('textbox', { name: '美國占比', exact: true }).fill('2.13');
      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.locator('#ocr-apply').click();
      expect(await page.locator('#ocr-status-desktop_SearchOrganic').innerText()).toContain('101.28%');
      expect(await page.locator('#ocr-status-desktop_SearchOrganic').innerText()).toContain('40%');
      expect(await page.getByRole('textbox', { name: '核對桌面限定・社群廣告', exact: true }).getAttribute('aria-invalid')).toBeNull();
      expect(await page.evaluate('document.activeElement?.getAttribute("aria-label")')).toBe('填入桌面限定・自然搜尋');
      await page.getByRole('checkbox', { name: '填入桌面限定・自然搜尋', exact: true }).check();
      await page.locator('#ocr-apply').click();
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
      await page.getByRole('button', { name: '更改截圖並重新核對' }).click();
      await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await page.getByRole('heading', { name: '核對辨識結果' }).waitFor({ timeout: 30_000 });
      expect(await page.locator('.ocr-field-row.is-identical').count()).toBe(12);
      await page.locator('#ocr-edit-taiwan').fill('93.22');
      await page.getByRole('button', { name: '勾選與目前不同的欄位', exact: true }).click();
      expect(await page.locator('.ocr-selection-count').innerText()).toBe('已選 1 / 16');
      expect(await page.locator('[data-field=taiwan]').getAttribute('class')).toContain('is-overwrite');
      await page.locator('#ocr-edit-taiwan').fill('93.23');
      await page.getByRole('button', { name: '勾選空白欄位', exact: true }).click();

      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.locator('#ocr-apply').click();
      expect(await page.locator('#manual-visits').inputValue()).toBe('482.4K');
      expect(await page.locator('#manual-pages').inputValue()).toBe('5.66');
      expect(await page.locator('#manual-duration').inputValue()).toBe('00:00:57');
      expect(await page.locator('#manual-bounce').inputValue()).toBe('71.01');
      await page.reload();
      expect(await page.locator('#manual-desktop_SearchOrganic').inputValue()).toBe('38.72');
      expect(await page.locator('#manual-visits').inputValue()).toBe('482.4K');
      // Fresh tabs avoid drafts masking an omitted country. Test the normal
      // engagement-first order and the compressed image that loses the Taiwan label.
      for (const names of [['s3-engagement.png', 's3-geography.png'], ['s3-geography-compressed.jpg'], ['s3-geography-telegram.jpg']]) {
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
        await fresh.getByRole('button', { name: '定位台灣占比', exact: true }).click();
        expect(await fresh.locator('.ocr-marker.is-active').count()).toBeGreaterThan(0);
        expect(await fresh.locator('.ocr-image-stage > img').getAttribute('alt')).toContain(names[names.length - 1]);
        await fresh.locator('.ocr-image-stage > img').evaluate((el) => el.decode());
        const box = await fresh.locator('.ocr-marker.is-active').first().boundingBox();
        const imageBox = await fresh.locator('.ocr-image-stage > img').boundingBox();
        expect(box && imageBox && Math.abs(box.y - imageBox.y) / imageBox.height).toBeLessThan(0.2);
        expect(await fresh.locator('#manual-taiwan').inputValue()).toBe('');
        await fresh.getByRole('button', { name: '放大', exact: true }).click();
        expect(await fresh.getByRole('button', { name: '符合寬度' }).getAttribute('aria-pressed')).toBe('true');
        await fresh.getByRole('button', { name: '符合寬度' }).click();
        await fresh.getByRole('checkbox', { name: '顯示標記', exact: true }).uncheck();
        expect(await fresh.locator('.ocr-overlay').isVisible()).toBe(false);
        await fresh.getByRole('checkbox', { name: '顯示標記', exact: true }).check();
        if (names.length === 2) {
          await fresh.getByRole('textbox', { name: '核對跳出率', exact: true }).focus();
          await fresh.getByRole('textbox', { name: '核對每次造訪頁數', exact: true }).dblclick();
          expect(await fresh.evaluate('document.activeElement?.id')).toBe('ocr-edit-pages');
          expect(await fresh.locator('#ocr-edit-pages').evaluate((el) => el.selectionEnd > el.selectionStart)).toBe(true);
          await fresh.getByRole('button', { name: '定位月造訪量', exact: true }).click();
          expect(await fresh.locator('.ocr-image-stage > img').getAttribute('alt')).toContain('s3-engagement.png');
        }
        const countryCheck = fresh.getByRole('checkbox', { name: '填入國家占比', exact: true });
        if (!(await countryCheck.isChecked())) {
          expect(await fresh.locator('#ocr-status-countries').innerText()).toContain('不完整');
          await countryCheck.check();
          const partial = fresh.locator('[data-field=countries] .ocr-partial-confirmation:visible input');
          if (await partial.count()) await partial.check();
        }
        await fresh.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
        await fresh.locator('#ocr-apply').click();
        expect(await fresh.locator('#manual-taiwan').inputValue()).toBe('93.23');
        expect(await fresh.locator('.ocr-workspace').isVisible()).toBe(true);
        expect(await fresh.locator('.ocr-review-actions').getByRole('button', { name: '前往表單儲存 ↓' }).isVisible()).toBe(true);
        await fresh.setViewportSize({ width: 390, height: 844 });
        expect(await fresh.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
        expect(await fresh.locator('#manual-countries').inputValue()).toContain('TW 93.23');
        if (names.length === 2) {
          expect(await fresh.locator('#manual-visits').inputValue()).toBe('482.4K');
          expect(await fresh.locator('#manual-countries').inputValue()).toBe('TW 93.23\nUS 2.13\nHK 1.59\nID 0.58\nMY 0.57');
          await fresh.getByLabel('跳到核對分類').selectOption({ label: '概況與互動（4欄）' });
          const visitsCrop = await fresh.locator('[data-field=visits] canvas').boundingBox();
          expect(visitsCrop && visitsCrop.height >= 30).toBe(true);
          await fresh.getByLabel('跳到核對分類').selectOption({ label: '國家分布（2欄）' });
          if ((await fresh.locator('.ocr-field-row.is-active').getAttribute('data-field')) !== 'countries')
            await fresh.getByRole('button', { name: '核對下一欄 →', exact: true }).click();
          await fresh.setViewportSize({ width: 390, height: 420 });
          await fresh.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          const countryCrop = await fresh.locator('.ocr-field-row.is-active canvas').boundingBox();
          await fresh.locator('[data-field=countries] .ocr-country-rows input').first().focus();
          await fresh.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          const countryEditor = await fresh.locator('[data-field=countries] .ocr-country-rows input').first().boundingBox();
          expect(countryCrop && countryCrop.width > 250 && countryCrop.y >= 0 && countryCrop.y + countryCrop.height <= 420).toBe(true);
          expect(countryEditor && countryEditor.y >= 0 && countryEditor.y + countryEditor.height <= 420).toBe(true);
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

it.skipIf(!existsSync(chromium.executablePath()))(
  'exposes a missing Taiwan row, validates corrections, and preserves source review after applying',
  async () => {
    const { readFileSync } = await import('node:fs');
    // Deterministic unreadable-label fixture exercises the correction path;
    // the real Telegram JPEG is independently recognized in the test above.
    const missing = readFileSync(new URL('./fixtures/manual-ocr/s3-geography-telegram.tsv', import.meta.url), 'utf8').replace(
      /\tTaiwan/g,
      '\tUnreadable',
    );
    const server = Fastify();
    registerManualOcr(server);
    server.get('/style.css', async (_request, reply) => reply.type('text/css').send(STYLE));
    server.get('/site/s3.com.tw/manual/', async (_request, reply) =>
      reply
        .type('text/html')
        .send(manualPage({ domain: 's3.com.tw', name: '小三美日' }, { months: [], choices: ['202610', '202609'], free: [] })),
    );
    const origin = await server.listen({ host: '127.0.0.1', port: 0 });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript((tsv) => {
        Object.assign(globalThis, {
          Tesseract: {
            createWorker: async () => {
              await new Promise((resolve) => setTimeout(resolve, 350));
              return {
                setParameters: async () => {},
                recognize: async () => ({ data: { tsv } }),
                terminate: async () => {},
              };
            },
          },
        });
      }, missing);
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(origin + '/site/s3.com.tw/manual/');
      await page.locator('#manual-screenshots').setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
      expect(await page.locator('[data-progress]').innerText()).toContain('bad.txt');
      expect(await page.getByRole('button', { name: '辨識截圖', exact: true }).isDisabled()).toBe(true);
      await page
        .locator('#manual-screenshots')
        .setInputFiles(fileURLToPath(new URL('./fixtures/manual-ocr/s3-geography-telegram.jpg', import.meta.url)));
      await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await page.getByRole('button', { name: '取消辨識', exact: true }).click();
      expect(await page.locator('[data-progress]').innerText()).toContain('已取消');
      expect(await page.locator('.ocr-file').count()).toBe(1);
      await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await page.getByRole('heading', { name: '核對辨識結果' }).waitFor();
      expect(await page.locator('.ocr-notices').innerText()).toContain('台灣未讀到');
      const taiwan = page.getByRole('textbox', { name: '核對台灣占比', exact: true });
      expect(await taiwan.inputValue()).toBe('');
      expect(await page.getByRole('checkbox', { name: '填入台灣占比', exact: true }).isChecked()).toBe(false);
      expect(await page.getByRole('checkbox', { name: '填入國家占比', exact: true }).isChecked()).toBe(false);
      expect(await page.locator('#ocr-status-countries').innerText()).toContain('不完整');
      await taiwan.focus();
      await page.locator('[data-field=taiwan] .ocr-full-image').click();
      expect(await page.locator('.ocr-original-dialog').isVisible()).toBe(true);
      await page.getByRole('button', { name: '返回台灣占比補正' }).click();
      await page.waitForFunction('document.activeElement.classList.contains("ocr-full-image")');
      // A submit attempt is intercepted before the form's submitting flag changes.
      const blocked = await page.evaluate(`(() => {
        const form = document.querySelector('.manual-form');
        const attempt = new Event('submit', { bubbles: true, cancelable: true });
        let reached = false;
        form.addEventListener('submit', () => { reached = true; }, { once: true });
        form.dispatchEvent(attempt);
        return { blocked: attempt.defaultPrevented, reached };
      })()`);
      expect(blocked).toEqual({ blocked: true, reached: false });
      await page.locator('.manual-save-bar [type=submit]').click();
      expect(await page.locator('.ocr-save-warning').isVisible()).toBe(true);
      expect(await page.locator('#manual-draft-status').innerText()).toContain('截圖核對尚未填入');
      expect(await page.locator('.ocr-save-warning').innerText()).toContain('尚未填入核對結果');
      await page.getByRole('button', { name: '返回核對並填入' }).click();
      expect(await page.locator('.ocr-save-warning').isVisible()).toBe(false);
      // A normal selection checkbox cannot dismiss a known incomplete-country warning.
      await page.getByRole('checkbox', { name: '填入國家占比', exact: true }).check();
      expect(await page.locator('[data-field=countries] .ocr-partial-confirmation').innerText()).toContain('TW、US');
      expect(await page.locator('.ocr-count').innerText()).toContain('數值疑點');
      await taiwan.fill('101');
      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.locator('#ocr-apply').click();
      expect(await taiwan.getAttribute('aria-invalid')).toBe('true');
      expect(await page.locator('.ocr-preflight').innerText()).toContain('台灣占比');
      await page.getByRole('textbox', { name: '核對桌面限定・自然搜尋', exact: true }).fill('38.71');
      expect(await taiwan.getAttribute('aria-invalid')).toBe('true');
      expect(await page.locator('#ocr-status-taiwan').innerText()).toContain('0–100');
      await page.getByRole('textbox', { name: '核對桌面限定・自然搜尋', exact: true }).fill('38.72');
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('');
      const leaving = page.waitForEvent('dialog');
      await page.evaluate('setTimeout(() => location.reload(), 0)');
      const leavePrompt = await leaving;
      expect(leavePrompt.type()).toBe('beforeunload');
      await leavePrompt.dismiss();
      expect(await taiwan.inputValue()).toBe('101');
      await taiwan.fill('93.23');
      await page.locator('#ocr-apply').click();
      expect(await page.locator('#ocr-status-countries').innerText()).toContain('漏辨識');
      expect(await page.locator('#manual-countries').inputValue()).toBe('');

      await page.getByRole('button', { name: /移除截圖 1/ }).click();
      expect(await page.getByRole('button', { name: '保留截圖與核對' }).isVisible()).toBe(true);
      await page.getByRole('button', { name: '保留截圖與核對' }).click();
      expect(await taiwan.inputValue()).toBe('93.23');
      expect(await page.evaluate('document.activeElement?.getAttribute("aria-label")')).toContain('移除截圖');
      expect(await page.getByRole('checkbox', { name: '填入聯盟行銷', exact: true }).count()).toBe(0);
      expect(await page.getByRole('checkbox', { name: '填入桌面限定・聯盟行銷', exact: true }).isChecked()).toBe(false);
      await page.locator('[data-field=countries] .ocr-country-raw > summary').click();
      await page.getByRole('textbox', { name: '核對國家占比', exact: true }).fill('TW 92.23\nUS 2.13');
      await page.locator('#ocr-apply').click();
      expect(await page.locator('#ocr-status-taiwan').innerText()).toContain('不一致');
      expect(await taiwan.getAttribute('aria-describedby')).toBe('ocr-status-taiwan');
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('');
      await page.getByRole('textbox', { name: '核對國家占比', exact: true }).fill('US 2.13\nHK 1.59\nID 0.58\nMY 0.57');
      await page.locator('[data-desktop-channels] > summary').click();
      await page.locator('#manual-desktop_Direct').fill('12.99');
      await page.locator('#ocr-apply').click();
      expect(await page.locator('.ocr-apply-error').innerText()).toContain('已變更');
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('');
      await page.getByRole('button', { name: '更新目前內容，保留核對修正' }).click();
      expect(await taiwan.inputValue()).toBe('93.23');
      expect(await page.getByRole('checkbox', { name: '填入桌面限定・直接造訪', exact: true }).isChecked()).toBe(false);
      const skip = page.getByRole('checkbox', { name: /我選擇略過未完成欄位/ });
      if (await skip.isVisible()) await skip.check();
      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.locator('#ocr-apply').click();
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('93.23');
      expect(await page.locator('#manual-countries').inputValue()).toBe('TW 93.23\nUS 2.13\nHK 1.59\nID 0.58\nMY 0.57');
      expect(await page.locator('.ocr-workspace').isVisible()).toBe(true);
      expect(await page.locator('.ocr-confirmation').isVisible()).toBe(false);
      expect(await page.getByRole('textbox', { name: '核對台灣占比', exact: true }).getAttribute('readonly')).not.toBeNull();
      expect(await page.locator('[data-progress]').innerText()).toContain('尚未儲存');
      expect(await page.evaluate('document.activeElement?.textContent')).toBe('前往表單儲存 ↓');
      expect(await page.locator('#manual-taiwan').getAttribute('data-ocr-filled')).toBe('true');
      await page.getByRole('button', { name: '到表單補登 1 項 →', exact: true }).click();
      expect(await page.evaluate('document.activeElement?.id')).toBe('manual-desktop_Affiliate');
      expect(await page.locator('#manual-desktop_Affiliate').getAttribute('readonly')).toBeNull();
      expect(await page.locator('.manual-form .ocr-country-helper').count()).toBe(1);
      await page.locator('.manual-form .ocr-form-source').filter({ hasText: '台灣占比' }).click();
      expect(await page.locator('.ocr-field-row.is-active').getAttribute('data-field')).toBe('taiwan');
      await page.getByRole('button', { name: '桌面限定流量來源 10', exact: true }).click();
      expect(await page.evaluate('getComputedStyle(document.querySelector(".ocr-results")).overflowY')).toBe('visible');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.locator('.ocr-workspace').evaluate((el) => el.firstElementChild?.classList.contains('ocr-results'))).toBe(true);
      expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      await page.getByRole('button', { name: '定位桌面限定・自然搜尋', exact: true }).click();
      expect(await page.locator('.ocr-field-row.is-active .ocr-inline-evidence canvas').isVisible()).toBe(true);
      expect(await page.locator('.ocr-results').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(false);
      await page.setViewportSize({ width: 390, height: 420 });
      await page.getByRole('textbox', { name: '核對桌面限定・自然搜尋', exact: true }).focus();
      expect(await page.locator('.ocr-field-row.is-active .ocr-inline-evidence canvas').isVisible()).toBe(true);
      await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const cropBox = await page.locator('.ocr-field-row.is-active .ocr-inline-evidence canvas').boundingBox();
      const editorBox = await page.locator('.ocr-field-row.is-active .ocr-edit-value input').boundingBox();
      expect(cropBox && cropBox.y >= 0 && cropBox.y + cropBox.height <= 420).toBe(true);
      expect(editorBox && editorBox.y >= 0 && editorBox.y + editorBox.height <= 420).toBe(true);
      page.on('dialog', (dialog) => dialog.accept());
      await page.reload();
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('93.23');
      const conflictContext = await browser.newContext();
      const engagementTsv = readFileSync(new URL('./fixtures/manual-ocr/s3-engagement.tsv', import.meta.url), 'utf8');
      await conflictContext.addInitScript((tsv) => {
        let mode = '11',
          pass = 0;
        Object.assign(globalThis, {
          Tesseract: {
            createWorker: async () => ({
              setParameters: async (params: { tessedit_pageseg_mode?: string }) => {
                mode = params.tessedit_pageseg_mode || mode;
              },
              recognize: async () => {
                if (mode === '11') pass++;
                return { data: { tsv: pass > 1 ? tsv.replace('482.4K', '482.5K') : tsv } };
              },
              terminate: async () => {},
            }),
          },
        });
      }, engagementTsv);
      const overlap = await conflictContext.newPage();
      await overlap.goto(origin + '/site/s3.com.tw/manual/');
      const engagementImage = readFileSync(new URL('./fixtures/manual-ocr/s3-engagement.png', import.meta.url));
      await overlap.locator('#manual-screenshots').setInputFiles([
        { name: 'first.png', mimeType: 'image/png', buffer: engagementImage },
        { name: 'second.png', mimeType: 'image/png', buffer: engagementImage },
      ]);
      await overlap.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await overlap.getByRole('heading', { name: '核對辨識結果' }).waitFor();
      expect(await overlap.locator('#ocr-edit-visits').inputValue()).toBe('');
      expect(await overlap.getByRole('checkbox', { name: '填入月造訪量', exact: true }).isChecked()).toBe(false);
      await overlap.locator('#ocr-edit-visits').focus();
      expect(await overlap.locator('[data-field=visits] canvas').count()).toBe(2);
      expect((await overlap.locator('[data-field=visits] .ocr-crop-head').allTextContents()).join(' ')).toContain('482.4K');
      expect(await overlap.locator('[data-field=visits] .ocr-crop-head').allTextContents()).toHaveLength(2);
      expect(await overlap.locator('[data-field=visits]').innerText()).toContain('482.5K');
      expect(await overlap.locator('#ocr-status-visits').innerText()).toContain('不一致');
      await overlap.getByRole('button', { name: '採用截圖 1 的 482.4K', exact: true }).click();
      expect(await overlap.locator('#ocr-edit-visits').inputValue()).toBe('482.4K');
      expect(await overlap.getByRole('checkbox', { name: '填入月造訪量', exact: true }).isChecked()).toBe(true);
      expect(await overlap.locator('#ocr-status-visits').innerText()).toBe('已採用截圖 1 的 482.4K');
      expect(await overlap.getByRole('button', { name: '已採用截圖 1', exact: true }).getAttribute('aria-pressed')).toBe('true');
      expect(await overlap.locator('[data-field=visits] .ocr-crop-head').first().innerText()).toContain('已採用此來源');
      await overlap.locator('#ocr-edit-visits').fill('482.6K');
      await overlap.locator('#ocr-edit-visits').blur();
      await overlap.locator('#ocr-edit-visits').focus();
      expect(await overlap.getByRole('button', { name: '已採用截圖 1', exact: true }).count()).toBe(0);
      await conflictContext.close();
    } finally {
      await browser.close();
      await server.close();
    }
  },
  30_000,
);

it.skipIf(!existsSync(chromium.executablePath()))(
  'requires an explicit generic-country decision and completes identical reviews',
  async () => {
    const { readFileSync } = await import('node:fs');
    const server = Fastify();
    registerManualOcr(server);
    server.get('/style.css', async (_, reply) => reply.type('text/css').send(STYLE));
    server.get('/site/s3.com.tw/manual/', async (_, reply) =>
      reply
        .type('text/html')
        .send(manualPage({ domain: 's3.com.tw', name: '小三美日' }, { months: [], choices: ['202610', '202609'], free: [] })),
    );
    const origin = await server.listen({ host: '127.0.0.1', port: 0 });
    const browser = await chromium.launch({ headless: true });
    try {
      const missing = readFileSync(new URL('./fixtures/manual-ocr/s3-geography-telegram.tsv', import.meta.url), 'utf8')
        .replace(/\tUnited\n/g, '\tMexico\n')
        .replace(/\tStates\n/g, '\tUnknown\n')
        .replace(/\t213%/g, '\t2.13%');
      const context = await browser.newContext();
      await context.addInitScript((tsv) => {
        Object.assign(globalThis, {
          Tesseract: {
            createWorker: async () => ({
              setParameters: async () => {},
              recognize: async () => ({ data: { tsv } }),
              terminate: async () => {},
            }),
          },
        });
      }, missing);
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const posts: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') posts.push(request.url());
      });
      await page.goto(origin + '/site/s3.com.tw/manual/');
      await page
        .locator('#manual-screenshots')
        .setInputFiles(fileURLToPath(new URL('./fixtures/manual-ocr/s3-geography-telegram.jpg', import.meta.url)));
      await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await page.getByRole('heading', { name: '核對辨識結果' }).waitFor();
      expect(await page.locator('#ocr-edit-taiwan').inputValue()).toBe('93.23');
      expect(await page.locator('#ocr-edit-countries').inputValue()).not.toContain('US');
      const countryCheck = page.getByRole('checkbox', { name: '填入國家占比', exact: true });
      await countryCheck.check();
      const partial = page.locator('[data-field=countries] .ocr-partial-confirmation input');
      expect(await partial.isVisible()).toBe(true);
      await page.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await page.locator('#ocr-apply').click();
      expect(await page.locator('#manual-countries').inputValue()).toBe('');
      expect(await page.locator('#ocr-status-countries').innerText()).toContain('漏辨識');
      await partial.check();
      expect(await page.locator('.ocr-notices').innerText()).toContain('只填部分國家');
      await page.locator('#ocr-edit-desktop_SearchOrganic').fill('38.71');
      expect(await partial.isChecked()).toBe(true);
      await page.locator('[data-field=countries] .ocr-country-helper summary').click();
      expect(await page.locator('.ocr-country-helper option[value=ZZ]').count()).toBe(0);
      expect(await page.locator('.ocr-country-helper option[value=EU]').count()).toBe(0);
      await page.getByLabel('搜尋國家名稱或代碼', { exact: true }).fill('Mexico');
      expect(await page.locator('.ocr-country-helper option').count()).toBe(2);
      await page.getByLabel('選擇國家名稱', { exact: true }).selectOption('MX');
      await page.getByLabel('新增國家占比', { exact: true }).fill('2.13');
      await page.getByRole('button', { name: '加入或更新國家', exact: true }).click();
      expect(await page.locator('#ocr-edit-countries').inputValue()).toContain('MX 2.13');
      expect(await partial.isVisible()).toBe(false);
      // Rebuilding evidence on resize must preserve a focused source action.
      await page.locator('[data-field=countries] .ocr-full-image').focus();
      await page.setViewportSize({ width: 1024, height: 700 });
      expect(await page.evaluate('document.activeElement?.classList.contains("ocr-full-image")')).toBe(true);
      await context.close();

      const identical = await browser.newContext();
      const engagement = readFileSync(new URL('./fixtures/manual-ocr/s3-engagement.tsv', import.meta.url), 'utf8');
      await identical.addInitScript((tsv) => {
        Object.assign(globalThis, {
          Tesseract: {
            createWorker: async () => ({
              setParameters: async () => {},
              recognize: async () => ({ data: { tsv } }),
              terminate: async () => {},
            }),
          },
        });
      }, engagement);
      const same = await identical.newPage();
      same.on('request', (request) => {
        if (request.method() === 'POST') posts.push(request.url());
      });
      await same.goto(origin + '/site/s3.com.tw/manual/');
      await same
        .locator('#manual-screenshots')
        .setInputFiles(fileURLToPath(new URL('./fixtures/manual-ocr/s3-engagement.png', import.meta.url)));
      await same.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await same.getByRole('heading', { name: '核對辨識結果' }).waitFor();
      await same.locator('#manual-month').selectOption('202609');
      await same.locator('#manual-visits').fill('100K');
      expect(await same.locator('.ocr-month-notice').innerText()).toContain('2026/09');
      await same.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await same.locator('#ocr-apply').click();
      expect(await same.locator('#ocr-apply-status').innerText()).toContain('已切換至 2026/10');
      const before = await same.locator('#manual-visits').inputValue();
      await same.getByRole('button', { name: '重新辨識', exact: true }).click();
      await same.getByRole('button', { name: '重新辨識並重新核對', exact: true }).click();
      await same.getByRole('heading', { name: '核對辨識結果' }).waitFor();
      expect(await same.locator('.ocr-selection-count').innerText()).toBe('已選 0 / 4');
      await same.getByRole('checkbox', { name: /我已確認截圖屬於/ }).check();
      await same.getByRole('button', { name: '完成核對，保留表單', exact: true }).click();
      expect(await same.locator('#manual-visits').inputValue()).toBe(before);
      expect(await same.locator('#manual-draft-status').innerText()).not.toContain('截圖核對尚未填入');
      expect(await same.locator('#ocr-apply-status').innerText()).toContain('表單內容未更動');
      await same.locator('#manual-month').selectOption('202609');
      expect(await same.locator('#manual-visits').inputValue()).toBe('100K');
      expect(posts).toEqual([]);
      await identical.close();
    } finally {
      await browser.close();
      await server.close();
    }
  },
  30000,
);
