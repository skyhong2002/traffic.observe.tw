import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { Pool } from '../src/db.ts';

it.skipIf(!existsSync(chromium.executablePath()))(
  'fits the first three ranking rows at 390px, preserves explicit months, and reopens desktop filters',
  async () => {
    const app = buildApp({} as Pool, { login: null, logger: false });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(3000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cov = (month: string, complete: number) => ({
      month,
      scope: 'tracked',
      tracked: 5,
      withVisits: 5,
      complete,
      lastUpdatedAt: '2026-11-01T00:00:00.000Z',
    });
    const data = {
      generatedAt: '2026-11-17T00:00:00Z',
      months: ['202609', '202610'],
      coverage: { 202609: cov('202609', 5), 202610: cov('202610', 1) },
      coverageThreshold: 0.8,
      fields: [],
      topics: ['新聞', '非台灣'],
      filterTopics: [
        { topic: '新聞', sites: 4 },
        { topic: '非台灣', sites: 1 },
      ],
      sources: [{ source: 'manual', domains: 5 }],
      radar: {},
      crux: {},
      sites: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          `site${i}.tw`,
          {
            name: `測試網站 ${i}`,
            group: null,
            topics: i === 4 ? ['非台灣'] : ['新聞'],
            src: ['sheet'],
            m: { 202609: [10 - i, 1, 0, 1, 0, 1, 0, null, 0], 202610: [10 - i, 1, 0, 1, 3, 1, 0, null, 0] },
          },
        ]),
      ),
    };
    await page.route('**/api/v1/history**', (route) => route.fulfill({ json: data }));
    await page.route('**/icon/**', (route) => route.fulfill({ status: 404, body: '' }));
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await page.goto(address);
      await page.waitForSelector('.ranking-table tbody tr:nth-child(3)');
      expect(errors).toEqual([]);
      expect(await page.locator('#to').inputValue()).toBe('202609');
      expect(await page.locator('.mobile-filter-drawer').evaluate((el: unknown) => (el as { open: boolean }).open)).toBe(false);
      const third = await page.locator('.ranking-table tbody tr:nth-child(3)').boundingBox();
      expect(third!.y + third!.height).toBeLessThanOrEqual(844);
      const bounds = await page.locator('.ranking-table').boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      await page.getByRole('button', { name: '清除所有條件，顯示全部觀測網站' }).click();
      await page.waitForFunction("document.querySelectorAll('.ranking-table tbody tr').length === 5", undefined, { timeout: 3000 });
      expect(await page.locator('.ranking-table tbody tr').count()).toBe(5);
      await page.locator('.mobile-filter-drawer summary').click();
      expect(await page.locator('#tag-action').count()).toBe(0);
      const tag = page.locator('[data-pick-topic="新聞"]');
      // Native buttons support keyboard activation; exclusion state is announced.
      await tag.first().focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        "document.querySelector('[data-pick-topic=\"新聞\"]')?.getAttribute('aria-pressed') === 'true'",
        undefined,
        { timeout: 3000 },
      );
      expect(await tag.first().getAttribute('aria-label')).toContain('已排除');
      expect(await page.locator('.ranking-table tbody tr').count()).toBe(1);
      await tag.first().click();
      await page.waitForFunction("document.querySelector('[data-pick-topic=\"新聞\"]')?.getAttribute('aria-pressed') === 'false'");
      expect(await page.locator('.ranking-table tbody tr').count()).toBe(5);
      await page.goto(`${address}/?month=202610`);
      await page.waitForSelector('.ranking-table tbody tr');
      expect(await page.locator('#to').inputValue()).toBe('202610');
      expect(await page.locator('#coverage-note').innerText()).toContain('資料仍在收集');
      expect(await page.locator('#generated').innerText()).not.toContain('2026/11/17');
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForFunction("document.querySelector('.mobile-filter-drawer').open");
      expect(await page.locator('.mobile-filter-drawer').evaluate((el: unknown) => (el as { open: boolean }).open)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await app.close();
    }
  },
  20000,
);
