import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { type BrowserContext, chromium, type Page } from 'playwright-core';
import { expect, it } from 'vitest';
import { registerManualOcr } from '../src/manual-ocr.ts';
import { manualPage } from '../src/metadata-pages.ts';
import { STYLE } from '../src/style.ts';

const available = existsSync(chromium.executablePath());
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/manual-ocr/${name}`, import.meta.url));
const tsv = (name: string) => readFileSync(fixture(name + '.tsv'), 'utf8');
const s3Geo = tsv('s3-geography-telegram').replace(/\t213%/g, '\t2.13%');
const stock = { '2560x1394': tsv('channels'), '2560x574': tsv('engagement') };
const s3 = { '1832x2216': tsv('s3-engagement'), '1318x2560': s3Geo };
const screenDir = fileURLToPath(new URL('../data/manual-c2-implementation-20261115/', import.meta.url));

async function run(check: (page: Page, context: BrowserContext, nonGet: string[]) => Promise<void>, mock?: Record<string, string>) {
  const app = Fastify();
  registerManualOcr(app);
  app.get('/style.css', async (_, reply) => reply.type('text/css').send(STYLE));
  app.get('/site/s3.com.tw/manual/', async (_, reply) =>
    reply
      .type('text/html')
      .send(manualPage({ domain: 's3.com.tw', name: '小三美日' }, { months: [], choices: ['202610', '202609'], free: [] })),
  );
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const nonGet: string[] = [],
      errors: string[] = [];
    await context.route('**/*', async (route) => {
      if (route.request().method() !== 'GET') {
        nonGet.push(route.request().url());
        await route.abort();
      } else if (route.request().url().startsWith(origin) || route.request().url().startsWith('data:')) await route.continue();
      else await route.abort();
    });
    if (mock)
      await context.addInitScript((fixtures) => {
        Object.assign(globalThis, {
          Tesseract: {
            createWorker: async () => {
              let mode = '11';
              return {
                setParameters: async (parameters: { tessedit_pageseg_mode?: string }) => {
                  if (parameters.tessedit_pageseg_mode) mode = parameters.tessedit_pageseg_mode;
                },
                recognize: async (canvas: { width: number; height: number }) => ({
                  data: { tsv: mode === '7' ? '' : fixtures[canvas.width + 'x' + canvas.height] || '' },
                }),
                terminate: async () => {},
              };
            },
          },
        });
      }, mock);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '/site/s3.com.tw/manual/');
    await check(page, context, nonGet);
    expect(nonGet).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
    await app.close();
  }
}
async function recognize(page: Page, files = ['channels.png', 'engagement.png']) {
  await page.locator('#manual-screenshots').setInputFiles(files.map(fixture));
  await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
  await page.getByRole('heading', { name: '核對辨識結果' }).waitFor({ timeout: 30000 });
}
async function choose(page: Page, name: RegExp) {
  await page.locator('.ocr-map-tabs').getByRole('button', { name }).click();
}

it.skipIf(!available)(
  'reviews real local OCR as a whole batch without per-field confirmation and preserves drafts',
  async () => {
    await run(async (page) => {
      await recognize(page);
      expect(await page.locator('#manual-visits').inputValue()).toBe('');
      expect(await page.locator('#ocr-apply').isEnabled()).toBe(true);
      expect(await page.locator('[data-review] input[type=checkbox]:visible').count()).toBe(0);
      await choose(page, /概況與互動/);
      expect(await page.getByRole('textbox', { name: '核對月造訪量', exact: true }).inputValue()).toBe('29.54M');
      expect(await page.locator('.ocr-map-field:visible').count()).toBe(4);
      await page.locator('#ocr-apply').click();
      expect(await page.locator('#manual-visits').inputValue()).toBe('29.54M');
      expect(await page.locator('#manual-duration').inputValue()).toBe('00:05:40');
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('94.16');
      expect(await page.locator('#manual-search').inputValue()).toBe('35.20');
      expect(await page.locator('#manual-countries').inputValue()).toContain('TW 94.16');
      expect(await page.locator('[data-progress]').innerText()).toContain('尚未儲存');
      await page.locator('#manual-visits').fill('500K');
      expect(await page.locator('#manual-visits').getAttribute('data-ocr-filled')).toBeNull();
      expect(await page.locator('.ocr-form-source').first().innerText()).toContain('已修改表單');
      await page.locator('.ocr-form-source').filter({ hasText: '月造訪量' }).click();
      expect(await page.getByRole('textbox', { name: '核對月造訪量', exact: true }).getAttribute('readonly')).not.toBeNull();
      expect(await page.getByRole('textbox', { name: '核對月造訪量', exact: true }).inputValue()).toBe('29.54M');
      page.on('dialog', (dialog) => dialog.accept());
      await page.reload();
      expect(await page.locator('#manual-visits').inputValue()).toBe('500K');
    });
  },
  60000,
);

it.skipIf(!available)(
  'keeps original pixels and all values available, validates immediately, and requires no individual approvals',
  async () => {
    await run(async (page) => {
      await recognize(page, ['s3-engagement.png', 's3-geography-telegram.jpg']);
      await choose(page, /桌面限定流量來源/);
      await page.getByRole('textbox', { name: '核對桌面限定・聯盟行銷', exact: true }).fill('4.67');
      await choose(page, /國家分布/);
      expect(await page.locator('.ocr-map-field:visible').count()).toBe(5);
      expect(await page.getByRole('textbox', { name: '核對台灣占比', exact: true }).count()).toBe(1);
      expect(await page.locator('#ocr-apply').isEnabled()).toBe(true);
      const tw = page.getByRole('textbox', { name: '核對台灣占比', exact: true });
      await page.getByRole('button', { name: '標記待查・台灣占比', exact: true }).click();
      expect(await page.locator('#ocr-apply').isDisabled()).toBe(true);
      await tw.fill('101');
      expect(await tw.getAttribute('aria-invalid')).toBe('true');
      await tw.fill('93.22');
      expect(await page.getByRole('button', { name: '取消待查・台灣占比', exact: true }).count()).toBe(1);
      await page.getByRole('button', { name: '取消待查・台灣占比', exact: true }).click();
      expect(await page.locator('#ocr-apply').isEnabled()).toBe(true);
      const source = page.getByRole('button', { name: '台灣占比', exact: true });
      await source.click();
      await page.keyboard.press('Escape');
      expect(await source.evaluate((element) => element.matches(':focus'))).toBe(true);
      await tw.fill('93.23');
      await page.waitForFunction("document.querySelector('.ocr-map-picture')?.getContext('2d')?.getImageData(0, 0, 1, 1).data[3] === 255");
      mkdirSync(screenDir, { recursive: true });
      await page.locator('[data-review]').screenshot({ path: screenDir + 'desktop-country.png' });
      const rectangles = await page
        .locator('.ocr-map-field')
        .evaluateAll((fields) =>
          fields.map((field) => ({ top: field.getBoundingClientRect().top, bottom: field.getBoundingClientRect().bottom })),
        );
      expect(rectangles.every((rect, i) => i === 0 || rect.top >= rectangles[i - 1].bottom)).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      expect(await page.locator('.ocr-map-crop:visible').count()).toBe(5);
      await page.locator('[data-review]').screenshot({ path: screenDir + 'mobile-country.png' });
      await page.locator('#ocr-apply').click();
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('93.23');
      expect(await page.locator('#manual-countries').inputValue()).toContain('TW 93.23');
      expect(await page.locator('#manual-countries').inputValue()).toContain('US 2.13');
      expect(await page.locator('#manual-desktop_SearchOrganic').inputValue()).toBe('38.72');
      expect(await page.locator('#manual-search').inputValue()).toBe('');
      // Enter edits a value, never implicitly saves from the country helper.
      await page.locator('.ocr-form-country-helper > summary').click();
      await page.getByRole('searchbox', { name: '表單搜尋國家名稱或代碼' }).fill('Japan');
      await page.getByRole('searchbox', { name: '表單搜尋國家名稱或代碼' }).press('Enter');
      await page.getByRole('textbox', { name: '表單新增國家占比' }).fill('0.4');
      await page.getByRole('textbox', { name: '表單新增國家占比' }).press('Enter');
      expect(await page.locator('#manual-countries').inputValue()).toContain('JP 0.4');
    }, s3);
  },
  30000,
);

it.skipIf(!available)(
  'preserves existing content, refreshes stale comparisons, validates effective values and completes identical batches',
  async () => {
    await run(async (page) => {
      await page.locator('#manual-visits').fill('30M');
      await page.locator('[data-all-channels] > summary').click();
      await page.locator('#manual-search').fill('40');
      await recognize(page);
      expect(await page.getByRole('checkbox', { name: /使用截圖更新已有數值/ }).isChecked()).toBe(false);
      expect(await page.locator('#ocr-apply').isDisabled()).toBe(true); // retained organic + screenshot channels > 100%
      await page.getByRole('checkbox', { name: /使用截圖更新已有數值/ }).check();
      expect(await page.locator('#ocr-apply').isEnabled()).toBe(true);
      await page.locator('#manual-search').fill('41');
      expect(await page.locator('#ocr-apply').isDisabled()).toBe(true);
      await page.getByRole('button', { name: '更新表單比較，保留核對修正' }).click();
      expect(await page.locator('#ocr-apply').isDisabled()).toBe(true);
      expect(await page.locator('.ocr-map-issues').innerText()).toContain('超過 100');
      await page.getByRole('checkbox', { name: /使用截圖更新已有數值/ }).check();
      await page.locator('#ocr-apply').click();
      expect(await page.locator('#manual-visits').inputValue()).toBe('29.54M');
      expect(await page.locator('#manual-search').inputValue()).toBe('35.20');
      await page.getByRole('button', { name: '重新辨識', exact: true }).click();
      await page
        .locator('.ocr-file-decision')
        .getByRole('button', { name: /重新辨識|清除核對/ })
        .click();
      await page.getByRole('button', { name: '辨識截圖', exact: true }).click();
      await page.getByRole('heading', { name: '核對辨識結果' }).waitFor();
      expect(await page.locator('#ocr-apply').isEnabled()).toBe(true);
      expect(await page.locator('#ocr-apply').innerText()).toContain('保留表單內容');
      await page.locator('#ocr-apply').click();
      expect(await page.locator('[data-progress]').innerText()).toContain('與表單相同');
      expect(await page.locator('.ocr-map-action-line').getByRole('button', { name: '前往表單儲存 ↓' }).isVisible()).toBe(true);
    }, stock);
  },
  30000,
);

it.skipIf(!available)(
  'repairs unknown and missing countries by name, synchronizes Taiwan once, and protects pending review from Save',
  async () => {
    const broken = s3Geo
      .split('\n')
      .map((line) => {
        const cells = line.split('\t');
        if (cells[11] === '93.23%') cells[10] = '45';
        return cells.join('\t');
      })
      .join('\n')
      .replace(/\tUnited/g, '\tMystery');
    await run(
      async (page) => {
        await recognize(page, ['s3-engagement.png', 's3-geography-telegram.jpg']);
        await choose(page, /桌面限定流量來源/);
        await page.getByRole('textbox', { name: '核對桌面限定・聯盟行銷', exact: true }).fill('4.67');
        expect(await page.locator('#ocr-apply').isDisabled()).toBe(true);
        await page.locator('.manual-save-bar [type=submit]').click();
        expect(await page.locator('.ocr-save-warning').isVisible()).toBe(true);
        await page.getByRole('button', { name: '返回核對並填入' }).click();
        expect(await page.locator('.ocr-save-warning').isVisible()).toBe(false);
        await choose(page, /國家分布/);
        const missingTw = page.getByRole('textbox', { name: '核對台灣占比', exact: true });
        await missingTw.fill('93.23');
        await page.getByRole('combobox', { name: /第 2 列國家的國家名稱/ }).selectOption('US');
        expect(await page.locator('#ocr-apply').isEnabled()).toBe(true);
        await page.locator('#ocr-apply').click();
        expect(await page.locator('#manual-taiwan').inputValue()).toBe('93.23');
        expect(await page.locator('#manual-countries').inputValue()).toContain('US 2.13');
        expect(await page.locator('#manual-countries').inputValue()).toContain('TW 93.23');
      },
      { ...s3, '1318x2560': broken },
    );
  },
  30000,
);

it.skipIf(!available)(
  'keeps unfilled conflicts visible, supports source adoption, and switches months without losing the earlier draft',
  async () => {
    const conflicting = tsv('s3-engagement')
      .replaceAll('482.4K', '29.55M')
      .replaceAll('5.66', '5.25')
      .replaceAll('71.01%', '42.87%')
      .replaceAll('00:00:57', '00:05:40');
    await run(
      async (page) => {
        await page.locator('#manual-month').selectOption('202609');
        await page.locator('#manual-visits').fill('1M');
        await recognize(page, ['channels.png', 'engagement.png', 's3-engagement.png']);
        expect(await page.locator('#ocr-apply').isDisabled()).toBe(true);
        await choose(page, /概況與互動/);
        await page.getByRole('button', { name: /採用截圖 .* 的 29.55M/ }).click();
        expect(await page.locator('#ocr-apply').isEnabled()).toBe(true);
        await page.locator('#ocr-apply').click();
        expect(await page.locator('#manual-month').inputValue()).toBe('202610');
        expect(await page.locator('#manual-visits').inputValue()).toBe('29.55M');
        await page.locator('#manual-month').selectOption('202609');
        expect(await page.locator('#manual-visits').inputValue()).toBe('1M');
        await page.locator('.ocr-map-action-line').getByRole('button', { name: '前往表單儲存 ↓' }).click();
        expect(await page.locator('#manual-month').inputValue()).toBe('202610');
      },
      { ...stock, '1832x2216': conflicting },
    );
  },
  30000,
);
it.skipIf(!available)(
  'makes partial-country import explicit and keeps the decision while other values are corrected',
  async () => {
    const partialGeo = s3Geo.replace(/\tUnited/g, '\tMystery');
    await run(
      async (page) => {
        await recognize(page, ['s3-engagement.png', 's3-geography-telegram.jpg']);
        await choose(page, /桌面限定流量來源/);
        await page.getByRole('textbox', { name: '核對桌面限定・聯盟行銷', exact: true }).fill('4.67');
        expect(await page.locator('#ocr-apply').isDisabled()).toBe(true);
        const partial = page.getByRole('checkbox', { name: /只填已讀到的國家/ });
        await partial.check();
        await choose(page, /概況與互動/);
        await page.getByRole('textbox', { name: '核對月造訪量', exact: true }).fill('482.5K');
        expect(await partial.isChecked()).toBe(true);
        expect(await page.locator('#ocr-apply').isEnabled()).toBe(true);
        await page.locator('#ocr-apply').click();
        expect(await page.locator('#manual-countries').inputValue()).toContain('HK 1.59');
        expect(await page.locator('#manual-countries').inputValue()).not.toContain('US');
        expect(await page.locator('[data-progress]').innerText()).toContain('僅填入已讀部分');
        expect(await page.locator('#manual-visits').inputValue()).toBe('482.5K');
      },
      { ...s3, '1318x2560': partialGeo },
    );
  },
  30000,
);

it.skipIf(!available)(
  'protects corrections when changing files and names explicitly skipped readings',
  async () => {
    const missingVisit = tsv('engagement')
      .split('\n')
      .map((line) => {
        const cells = line.split('\t');
        if (cells[11] === '29.54M') cells[10] = '45';
        return cells.join('\t');
      })
      .join('\n');
    await run(
      async (page) => {
        await page.locator('#manual-screenshots').setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('bad') });
        expect(await page.locator('[data-progress]').innerText()).toContain('bad.txt');
        await recognize(page);
        await choose(page, /概況與互動/);
        const visits = page.getByRole('textbox', { name: '核對月造訪量', exact: true });
        await visits.fill('30M');
        await page.locator('.ocr-file button').first().click();
        await page.getByRole('button', { name: '保留截圖與核對', exact: true }).click();
        expect(await visits.inputValue()).toBe('30M');
        await visits.fill('');
        expect(await page.locator('#ocr-apply').isDisabled()).toBe(true);
        const menu = page.locator('[data-field=visits] summary');
        if (!(await menu.evaluate((element) => element.parentElement?.hasAttribute('open')))) await menu.click();
        await page.locator('[data-field=visits]').getByRole('button', { name: '略過此欄', exact: true }).click();
        expect(await page.locator('#ocr-apply').isEnabled()).toBe(true);
        await page.locator('#ocr-apply').click();
        expect(await page.locator('#manual-visits').inputValue()).toBe('');
        expect(await page.locator('[data-progress]').innerText()).toContain('已略過：月造訪量');
      },
      { ...stock, '2560x574': missingVisit },
    );
  },
  30000,
);

it.skipIf(!existsSync(chromium.executablePath()))('retains server Taiwan error semantics until correction', async () => {
  const server = Fastify();
  registerManualOcr(server);
  server.get('/style.css', async (_, reply) => reply.type('text/css').send(STYLE));
  server.get('/', async (_, reply) =>
    reply
      .type('text/html')
      .send(
        manualPage(
          { domain: 's3.com.tw', name: '小三美日' },
          { months: [], choices: ['202610'], free: [], draft: { taiwan: '93.23' }, error: '請重新確認台灣占比', errorFields: ['taiwan'] },
        ),
      ),
  );
  const origin = await server.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    const taiwan = page.locator('#manual-taiwan');
    expect(await taiwan.getAttribute('aria-invalid')).toBe('true');
    expect((await taiwan.getAttribute('aria-describedby'))?.split(' ')).toContain('manual-error');
    await page.locator('#manual-visits').fill('500K');
    expect(await taiwan.getAttribute('aria-invalid')).toBe('true');
    await taiwan.fill('101');
    expect(await taiwan.getAttribute('aria-invalid')).toBe('true');
    expect(await page.locator('#manual-taiwan-consistency').innerText()).toContain('0–100');
    await taiwan.fill('93.22');
    expect(await taiwan.getAttribute('aria-invalid')).toBe('false');
  } finally {
    await browser.close();
    await server.close();
  }
});
