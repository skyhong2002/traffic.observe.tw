import { describe, expect, it } from 'vitest';
import { manualProfile, parseManualChannels, parseManualDetails } from '../src/manual.ts';
import { breakdownValues, parseBreakdowns, parseReportedPercent } from '../src/manual-breakdowns.ts';
import { platformBreakdownsSection } from '../src/pages.ts';
import { publicTraffic, trafficAccess } from '../src/traffic-access.ts';

describe('platform-only breakdowns', () => {
  it('round-trips unknown identities, inequalities and provider changes without treating them as exact values', () => {
    const parsed = parseBreakdowns({
      socialTotal: '3.8%',
      social: 'Facebook | 76.23%\nYouTube | 14.05%',
      referringSites: 'yahoo.com | 92.41% | ↓ 13.99%\n? | 0.64% | -8.07%',
      outgoingLinks: 'ftnn.com.tw | 6.72% | ↑ >5,000%',
      displayTotal: '<1%',
      displayPublishers: 'zh.wikipedia.org | <0.01% | New',
    });
    expect(parsed.referringSites[1].name).toBeNull();
    expect(parsed.referringSites[0].change).toBe('-13.99%');
    expect(parsed.outgoingLinks[0].change).toBe('+>5000%');
    expect(parsed.displayPublishers[0].share).toEqual({ value: 0.0001, bound: 'lt' });
    expect(parseBreakdowns(breakdownValues(parsed))).toEqual(parsed);
  });
  it.each([
    { social: 'Facebook | 110%' },
    { social: 'Facebook | 70%\nYouTube | 40%' },
    { social: 'Facebook | 70%\nfacebook | 10%' },
    { referringSites: 'localhost | 50%' },
    { referringSites: 'Upgrade your account | 5%' },
    { social: 'Facebook | 10% | <script>' },
    { social: 'Facebook | ' },
    { socialTotal: '-1%' },
    { displayTotal: 'NaN' },
  ])('rejects malformed breakdowns %j', (body) => expect(() => parseBreakdowns(body)).toThrow());
  it('only derives an exact matching channel, never inventing organic social or rounding a bound', () => {
    expect(parseManualChannels({ socialTotal: '3.8%', referralTotal: '43.4%', displayTotal: '<1%' })).toEqual({ Referrals: 43.4 / 100 });
    expect(() => parseManualChannels({ Referrals: '12.5', referralTotal: '43.4' })).toThrow();
    expect(parseReportedPercent('0')).toEqual({ value: 0, bound: null });
    expect(parseReportedPercent('')).toBeNull();
  });
  it('renders bounds and untrusted labels safely, with separate denominators', () => {
    const profile = manualProfile({
      month: '202609',
      channels: {},
      searchShare: null,
      aiShare: null,
      taiwanShare: null,
      details: parseManualDetails({ social: '<img src=x> | 10%', displayPublishers: '? | <0.01% | New', displayTotal: '<1%' }),
    });
    const html = trafficAccess.run(true, () => platformBreakdownsSection([profile]));
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;0.01%');
    expect(html).toContain('New');
    expect(html).toContain('未提供名稱');
    expect(html).toContain('占社群流量');
    expect(trafficAccess.run(false, () => platformBreakdownsSection([profile]))).toBe('');
  });
  it('hides nested platform details from guests without mutating stored values', () => {
    const breakdowns = parseBreakdowns({ social: 'Facebook | 76.23%' });
    const source = { profile: { breakdowns }, manualProfiles: [{ breakdowns }] };
    expect(trafficAccess.run(false, () => publicTraffic(source))).toEqual({ profile: {} });
    expect(trafficAccess.run(true, () => publicTraffic(source))).toBe(source);
    expect(source.profile.breakdowns.social[0].share.value).toBeCloseTo(0.7623, 10);
  });
});
