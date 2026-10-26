import { load } from 'cheerio';
import { expect, it } from 'vitest';
import { parseBreakdowns } from '../src/manual-breakdowns.ts';
import { platformBreakdownsSection, tagPanel } from '../src/pages.ts';
import type { TrafficProfile } from '../src/similarweb.ts';
import { trafficAccess } from '../src/traffic-access.ts';

it('keeps a selected vote withdrawable and counts beside its action', () => {
  const $ = load(
    tagPanel('example.tw', [{ tag: '遊戲', source: 'community', visible: true, adminOverride: null, agrees: 12, disagrees: 2 }], {
      loginEnabled: true,
      signedIn: true,
      admin: false,
      votes: { 遊戲: 1 },
    }),
  );
  expect($('[data-choice=agree]').attr('value')).toBe('0');
  expect($('[data-choice=agree]').attr('aria-pressed')).toBe('true');
  expect($('[data-choice=agree] b').text()).toBe('12');
  expect($('[data-choice=disagree]').attr('value')).toBe('-1');
  expect($('form input[name=kind]').first().val()).toBe('vote');
  expect($('details').text()).toContain('管理員');
});

it('shows administrator overrides rather than submitting ordinary votes', () => {
  const $ = load(
    tagPanel('example.tw', [{ tag: '遊戲', source: 'admin', visible: false, adminOverride: 'hide', agrees: 12, disagrees: 2 }], {
      loginEnabled: true,
      signedIn: true,
      admin: true,
      votes: {},
    }),
  );
  expect($('[data-choice=hide]').attr('value')).toBe('release');
  expect($('[data-choice=hide]').attr('aria-pressed')).toBe('true');
  expect($('form input[name=kind]').first().val()).toBe('admin');
  expect($('[data-choice=agree]')).toHaveLength(0);
});

it('preserves platform bounds, denominators, unknown names and manual provenance', () => {
  const profile: TrafficProfile = {
    source: 'manual',
    month: '202609',
    countries: [],
    channels: {},
    bounceRate: null,
    pagesPerVisit: null,
    timeOnSite: null,
    globalRank: null,
    countryRank: null,
    categoryRank: null,
    breakdowns: parseBreakdowns({
      socialTotal: '3.8%',
      social: 'Facebook | 76.23%',
      outgoingLinks: '? | <0.01% | >5000%\nexample.com | 3% | New',
    }),
  };
  const $ = load(trafficAccess.run(true, () => platformBreakdownsSection([profile])));
  expect($.text()).toContain('占社群流量，不是全站流量');
  expect($.text()).toContain('占連出流量');
  expect($.text()).toContain('<0.01%');
  expect($.text()).toContain('>5000%');
  expect($.text()).toContain('New');
  expect($.text()).toContain('未提供名稱');
  expect($.text()).toContain('平台手動補登');
  expect(trafficAccess.run(false, () => platformBreakdownsSection([profile]))).toBe('');
});
