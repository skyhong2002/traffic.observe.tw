import { load } from 'cheerio';
import { expect, it } from 'vitest';
import { sectionTabs, siteHeader } from '../src/pages.ts';

it('keeps the traffic views separate from status and missing data', () => {
  for (const [view, label] of [
    ['report', '流量總覽'],
    ['table', '完整數據'],
  ] as const) {
    const $ = load(sectionTabs(view));
    expect(
      $('.subnav a')
        .map((_, el) => $(el).text())
        .get(),
    ).toEqual(['流量總覽', '完整數據']);
    expect($('[aria-current=page]').text()).toBe(label);
  }
  for (const [view, label] of [
    ['status', '更新狀態'],
    ['missing', '尚未有資料'],
  ] as const) {
    const $ = load(sectionTabs(view));
    expect(
      $('.subnav a')
        .map((_, el) => $(el).text())
        .get(),
    ).toEqual(['更新狀態', '尚未有資料']);
    expect($('[aria-current=page]').text()).toBe(label);
    const url = new URL($('.subnav a').last().attr('href')!, 'https://site.observe.tw');
    expect(url.searchParams.get('source')).toBe('none');
    expect(url.searchParams.get('state')).toBe('all');
    const header = load(siteHeader(view));
    expect(header('.site-nav [aria-current=true]').text()).toBe('資料更新狀態');
  }
});
