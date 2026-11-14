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
const screenDir = fileURLToPath(new URL('../data/manual-simple-preview-20261115/screenshots/', import.meta.url));

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
  await page.locator('[data-progress]').filter({ hasText: '請對照後儲存' }).waitFor({ timeout: 45000 });
}

it.skipIf(!available)(
  'automatically fills the actual form from real local OCR and follows focused fields to their source',
  async () => {
    await run(async (page) => {
      await recognize(page, ['s3-engagement.png', 's3-geography-telegram.jpg']);
      expect(await page.locator('#manual-visits').inputValue()).toBe('482.4K');
      expect(await page.locator('#manual-duration').inputValue()).toBe('00:00:57');
      expect(await page.locator('#manual-taiwan').inputValue()).toBe('93.23');
      expect(await page.locator('#manual-countries').inputValue()).toContain('US 2.13');
      expect(await page.locator('#manual-desktop_SearchOrganic').inputValue()).toBe('38.72');
      expect(await page.locator('#manual-desktop_Affiliate').inputValue()).toBe('4.67');
      expect(await page.locator('#manual-search').inputValue()).toBe('');
      expect(await page.locator('[data-review], #ocr-apply').count()).toBe(0);
      expect(await page.locator('input[type=checkbox]').count()).toBe(0);
      await page.locator('#manual-taiwan').focus();
      await page.locator('.ocr-source-marker:visible').waitFor();
      expect(await page.locator('[data-source-image]').getAttribute('alt')).toContain('截圖 2');
      expect(await page.locator('[data-source-view]').evaluate((view) => view.scrollHeight <= view.clientHeight + 2)).toBe(true);
      const formHeight = await page.locator('.manual-form').evaluate((el) => el.getBoundingClientRect().height);
      expect(formHeight).toBeLessThan(1000);
      const positions = await page
        .locator('.manual-columns > *')
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x));
      expect(positions[1]).toBeGreaterThan(positions[0]);
      mkdirSync(screenDir, { recursive: true });
      await page.locator('.manual-workspace').screenshot({ path: screenDir + 'desktop.png' });
      await page.locator('#manual-visits').fill('500K');
      expect(await page.locator('#manual-visits').getAttribute('data-ocr-filled')).toBeNull();
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      await page.screenshot({ path: screenDir + 'mobile.png', fullPage: true });
      page.on('dialog', (dialog) => dialog.accept());
      await page.reload();
      expect(await page.locator('#manual-visits').inputValue()).toBe('500K');
      expect(await page.locator('[data-desktop-channels]').evaluate((el) => el.hasAttribute('open'))).toBe(true);
    });
  },
  60000,
);

it.skipIf(!available)('keeps pre-existing values and later manual corrections on re-recognition', async () => {
  await run(async (page) => {
    await page.locator('#manual-visits').fill('500K');
    await recognize(page);
    expect(await page.locator('#manual-visits').inputValue()).toBe('500K');
    expect(await page.locator('#manual-pages').inputValue()).toBe('5.25');
    await page.locator('#manual-pages').fill('6');
    await page.locator('[data-recognize]').click();
    await page.locator('[data-progress]').filter({ hasText: '請對照後儲存' }).waitFor();
    expect(await page.locator('#manual-pages').inputValue()).toBe('6');
    expect(await page.locator('#manual-visits').inputValue()).toBe('500K');
    await page.locator('[data-reading-key="visits"]').getByRole('button', { name: '採用 29.54M', exact: true }).click();
    expect(await page.locator('#manual-visits').inputValue()).toBe('29.54M');
  }, stock);
});

it.skipIf(!available)('leaves conflicting values blank and lets the user choose with the original alongside', async () => {
  await run(
    async (page) => {
      await recognize(page, ['engagement.png', 's3-engagement.png']);
      expect(await page.locator('#manual-visits').inputValue()).toBe('');
      const note = page.locator('[data-reading-key="visits"]');
      expect(await note.innerText()).toContain('不同數值');
      await note.getByRole('button', { name: '採用 482.4K', exact: true }).click();
      expect(await page.locator('#manual-visits').inputValue()).toBe('482.4K');
      expect(await page.locator('[data-source-image]').getAttribute('alt')).toContain('截圖 2');
    },
    { ...stock, ...s3 },
  );
});

it.skipIf(!available)('preserves edits made while OCR is running and prevents Save until it completes', async () => {
  await run(async (page) => {
    await page.evaluate(`{
      const create = Tesseract.createWorker;
      Tesseract.createWorker = async (...args) => { await new Promise(r => setTimeout(r, 650)); return create(...args); };
    }`);
    await page.locator('#manual-screenshots').setInputFiles([fixture('engagement.png')]);
    expect(await page.getByRole('button', { name: '儲存此月份' }).isDisabled()).toBe(true);
    await page.locator('#manual-visits').fill('600K');
    await page.locator('[data-progress]').filter({ hasText: '請對照後儲存' }).waitFor();
    expect(await page.locator('#manual-visits').inputValue()).toBe('600K');
    expect(await page.getByRole('button', { name: '儲存此月份' }).isEnabled()).toBe(true);
  }, stock);
});

it.skipIf(!available)('switches to the screenshot month while preserving the outgoing monthly draft', async () => {
  await run(async (page) => {
    await page.locator('#manual-month').selectOption('202609');
    await page.locator('#manual-visits').fill('777K');
    await recognize(page);
    expect(await page.locator('#manual-month').inputValue()).toBe('202610');
    expect(await page.locator('#manual-visits').inputValue()).toBe('29.54M');
    expect(await page.locator('[data-progress]').innerText()).toContain('已切換至 2026/10');
    await page.locator('#manual-month').selectOption('202609');
    expect(await page.locator('#manual-visits').inputValue()).toBe('777K');
  }, stock);
});

it.skipIf(!available)('validates corrected values immediately and never implicitly submits from country editing', async () => {
  await run(async (page) => {
    await recognize(page);
    await page.locator('#manual-taiwan').fill('101');
    expect(await page.locator('#manual-taiwan').getAttribute('aria-invalid')).toBe('true');
    await page.locator('#manual-taiwan').fill('94.16');
    expect(await page.getByRole('textbox', { name: '表單國家列表・台灣占比', exact: true }).count()).toBe(0);
    await page.locator('#manual-taiwan').fill('94.15');
    expect(await page.locator('#manual-countries').inputValue()).toContain('TW 94.15');
    await page.locator('#manual-taiwan').fill('94.16');
    await page.locator('#manual-bounce').fill('250');
    expect(await page.locator('#manual-bounce').getAttribute('aria-invalid')).toBe('true');
    await page.locator('#manual-bounce').fill('42.87');
    const formHeight = await page.locator('.manual-form').evaluate((el) => el.getBoundingClientRect().height);
    await page.locator('[data-country-add]').click();
    expect(await page.getByRole('dialog', { name: '編輯國家分布' }).isVisible()).toBe(true);
    expect(await page.locator('.manual-form').evaluate((el) => el.getBoundingClientRect().height)).toBe(formHeight);
    await page.getByRole('searchbox', { name: '表單搜尋國家名稱或代碼' }).fill('Japan');
    await page.getByRole('searchbox', { name: '表單搜尋國家名稱或代碼' }).press('Enter');
    await page.getByRole('textbox', { name: '表單新增國家占比' }).fill('0.4');
    await page.getByRole('textbox', { name: '表單新增國家占比' }).press('Enter');
    expect(await page.locator('#manual-countries').inputValue()).toContain('JP 0.4');
    await page.keyboard.press('Escape');
    expect(await page.locator('[data-country-add]').evaluate((el) => el === el.ownerDocument.activeElement)).toBe(true);
    await page.locator('[data-country-code]').click();
    await page.locator('#manual-countries').fill('TW 94.14\nJP 0.4');
    expect(await page.locator('#manual-taiwan').inputValue()).toBe('94.14');
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.locator('#manual-visits').press('Enter');
    await page.locator('#manual-taiwan').fill('94.15');
    page.on('dialog', (dialog) => dialog.accept());
    await page.reload();
    expect(await page.locator('#manual-taiwan').inputValue()).toBe('94.15');
    expect(await page.locator('#manual-countries').inputValue()).toContain('TW 94.15');
    expect(await page.locator('#manual-countries').inputValue()).toContain('JP 0.4');
    await page.locator('[data-country-code]').click();
    await page.locator('#manual-countries').fill('not a country');
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '儲存此月份', exact: true }).click();
    expect(await page.getByRole('dialog', { name: '編輯國家分布' }).isVisible()).toBe(true);
    expect(await page.locator('#manual-countries').evaluate((el) => el === el.ownerDocument.activeElement)).toBe(true);
    await page.locator('#manual-countries').fill('TW 94.15\nJP 0.4');
    await page.getByRole('button', { name: '完成', exact: true }).click();
  }, stock);
});

it.skipIf(!available)(
  'reads all supplied PNG reference values and recovers Taiwan in an additional compressed image',
  async () => {
    for (const [files, visits, taiwan, countries] of [
      [['s3-geography-compressed.jpg'], '', '93.23', ['TW 93.23', 'HK 1.59', 'ID 0.58', 'MY 0.57']],
      [['s3-geography.png'], '', '93.23', ['TW 93.23', 'US 2.13', 'HK 1.59', 'ID 0.58', 'MY 0.57']],
      [['s3-engagement.png', 's3-geography.png'], '482.4K', '93.23', ['TW 93.23', 'US 2.13', 'HK 1.59', 'ID 0.58', 'MY 0.57']],
      [['extension-engagement.png', 'extension-geography.png'], '416.5K', '97.02', ['TW 97.02', 'US 1.76', 'HK 0.73', 'JP 0.3', 'DE 0.12']],
    ] as const) {
      await run(async (page) => {
        await recognize(page, [...files]);

        expect(await page.locator('#manual-taiwan').inputValue()).toBe(taiwan);
        expect(await page.locator('#manual-visits').inputValue()).toBe(visits);
        for (const row of countries) expect(await page.locator('#manual-countries').inputValue()).toContain(row);
        if ([...files].some((file) => file === 's3-geography-compressed.jpg')) {
          expect(await page.locator('[data-reading-key="countries"]').innerText()).toContain('未辨識');
          expect(await page.locator('#manual-countries').inputValue()).not.toContain('US 213');
        }
        const matsu = taiwan === '97.02';
        if (visits) {
          expect(await page.locator('#manual-bounce').inputValue()).toBe(matsu ? '44.43' : '71.01');
          expect(await page.locator('#manual-pages').inputValue()).toBe(matsu ? '3.34' : '5.66');
          expect(await page.locator('#manual-duration').inputValue()).toBe(matsu ? '00:05:40' : '00:00:57');
        }
        if (![...files].some((file) => file === 's3-geography-compressed.jpg')) {
          const desktop = matsu
            ? {
                Direct: '60.69',
                SearchOrganic: '32.53',
                SocialOrganic: '3.63',
                Referrals: '2.13',
                GenAi: '0.69',
                Mail: '0.32',
                SocialPaid: '0',
                SearchPaid: '0',
                Affiliate: '0',
                DisplayAds: '0',
              }
            : {
                Direct: '13.09',
                SearchOrganic: '38.72',
                SocialOrganic: '6.08',
                Referrals: '3.47',
                GenAi: '0.27',
                Mail: '2.07',
                SocialPaid: '20.48',
                SearchPaid: '8.79',
                Affiliate: '4.67',
                DisplayAds: '2.36',
              };
          for (const [key, value] of Object.entries(desktop)) expect(await page.locator('#manual-desktop_' + key).inputValue()).toBe(value);
        }
      });
    }
  },
  120000,
);
