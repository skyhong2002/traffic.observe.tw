import { describe, expect, it } from 'vitest';
import { manualProfile, parseManualDetails } from '../src/manual.ts';

describe('manual Similarweb details', () => {
  it('keeps unentered values unknown, explicit zeros, and all supplied countries', () => {
    expect(parseManualDetails({})).toMatchObject({ bounceRate: null, timeOnSite: null, countries: [], globalRank: null });
    expect(parseManualDetails({ bounce: '0', duration: '0', countries: 'TW 60\nUS 0', taiwan: '60' })).toMatchObject({
      bounceRate: 0,
      timeOnSite: 0,
      countries: [
        { code: 'TW', share: 0.6 },
        { code: 'US', share: 0 },
      ],
    });
  });
  it.each([
    { pages: '-1' },
    { pages: 'Infinity' },
    { globalRank: '1.5' },
    { duration: '00:60:00' },
    { bounce: '101' },
    { countryCode: 'TW' },
    { countryRank: '3' },
    { category: 'News' },
    { countries: 'Taiwan 50' },
    { countries: 'TW 50\nTW 20' },
    { countries: 'TW 80\nUS 30' },
    { countries: 'TW 50', taiwan: '60' },
  ])('rejects invalid details %j', (body) => {
    expect(() => parseManualDetails(body)).toThrow();
  });
  it('keeps legacy entries readable without inventing channels or engagement', () => {
    expect(
      manualProfile({ month: '202609', channels: {}, details: null, searchShare: 0.2, aiShare: null, taiwanShare: 0.6 }),
    ).toMatchObject({
      source: 'manual',
      month: '202609',
      channels: { SearchOrganic: 0.2 },
      bounceRate: null,
      countries: [{ code: 'TW', share: 0.6 }],
    });
  });
});
