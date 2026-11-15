import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { techOverview, techPage } from '../src/tech-pages.ts';
import type { TechRecord } from '../src/tech-scan.ts';

const records = new Map<string, TechRecord>([
  [
    'example.tw',
    {
      domain: 'example.tw',
      status: 'detected',
      errorCode: null,
      observedAt: '2026-10-26T00:00:00Z',
      lastAttemptAt: '2026-10-26T00:00:00Z',
      origin: 'traffic',
      ruleVersion: null,
      sourceUrl: 'https://example.tw/',
      httpStatus: 200,
      detections: [
        {
          id: 'gtm',
          name: 'Google Tag Manager',
          category: 'analytics',
          version: 'unknown',
          confidence: 1,
          ruleId: 'gtm',
          ruleVersion: 'test',
          observedAt: '2026-10-26T00:00:00Z',
          evidence: [],
        },
      ],
    },
  ],
]);
const overview = (query = {}) => techOverview(['example.tw'], new Map(), records, new Map([['empty', new Set<string>()]]), query);

describe('technology navigation', () => {
  it('separates the catalog from its site results and provides a direct drill-down', () => {
    const $ = load(techPage(overview()));
    expect($('#tech-sites').length).toBe(0);
    expect(
      $('.subnav a')
        .map((_, el) => $(el).text())
        .get(),
    ).toEqual(['技術總覽', '所有網站']);
    expect($('.subnav [aria-current=page]').text()).toBe('技術總覽');
    expect($('#tech-catalog a.tech-name').attr('href')).toBe('/tech/?technology=gtm');
    const detail = load(techPage(overview({ technology: 'gtm' })));
    expect(detail('h1').text()).toBe('用 Google Tag Manager 的網站');
    expect(detail('.subnav [aria-current=page]').text()).toBe('所有網站');
    expect(detail('.subnav a').eq(1).attr('href')).toBe('/tech/?view=sites');
    expect(detail('#tech-catalog').length).toBe(0);
    expect(detail('#tech-sites tbody a').first().attr('href')).toBe('/tech/example.tw/');
    expect(detail('.subnav a').first().attr('href')).toBe('/tech/');
    expect(detail('.tech-selected').text()).toBe('Google Tag Manager');
  });
  it('keeps the selected technology when a source has no matching sites', () => {
    const o = overview({ technology: 'gtm', source: 'empty' });
    expect(o.filters.technology).toBe('gtm');
    const $ = load(techPage(o));
    expect($('h1').text()).toContain('Google Tag Manager');
    expect($('#tech-sites').text()).toContain('沒有符合條件');
    expect($('.subnav a').first().attr('href')).toBe('/tech/?source=empty');
  });
  it('offers all sites and keeps that view when clearing result filters', () => {
    expect(load(techPage(overview(), 'sites'))('#tech-sites').length).toBe(1);
    const $ = load(techPage(overview({ status: 'blocked' })));
    const clear = $('a').filter((_, a) => $(a).text() === '全部結果');
    expect(clear.attr('href')).toBe('/tech/?view=sites');
  });
});
