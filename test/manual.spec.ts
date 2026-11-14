import { describe, expect, it } from 'vitest';
import { coverageFields } from '../src/collection.ts';
import { manualDetailValues, manualProfile, parseManualDetails, parseShare, parseVisits } from '../src/manual.ts';
import { ManualInputError } from '../src/manual-input.ts';
import { desktopChannelsSection } from '../src/pages.ts';
import { publicTraffic, trafficAccess } from '../src/traffic-access.ts';

describe('manual Similarweb details', () => {
  it('accepts copied full-width numbers, rank prefixes and both platform time formats', () => {
    expect(parseVisits('６０．１０Ｍ')).toBe(60_100_000);
    expect(parseShare('３６．４５％', '自然搜尋', 'search')).toBeCloseTo(0.3645);
    expect(parseManualDetails({ duration: '２：０５', globalRank: '#1,234' })).toMatchObject({
      timeOnSite: 125,
      globalRank: 1234,
    });
    expect(parseManualDetails({ duration: '01:02:05' }).timeOnSite).toBe(3725);
    expect(parseManualDetails({ duration: '00:00' }).timeOnSite).toBe(0);
  });
  it('treats missing platform values as unknown and keeps bounded shares out of exact metrics', () => {
    expect(parseShare('—', '搜尋')).toBeNull();
    expect(parseManualDetails({ duration: 'N/A', pages: '—', bounce: '-' })).toMatchObject({
      timeOnSite: null,
      pagesPerVisit: null,
      bounceRate: null,
    });
    expect(() => parseShare('<0.01%', '搜尋', 'search')).toThrow(ManualInputError);
    try {
      parseShare('<0.01%', '搜尋', 'search');
    } catch (error) {
      expect(error).toMatchObject({ fields: ['search'] });
    }
    expect(() => parseManualDetails({ duration: '2:60' })).toThrow(ManualInputError);
    expect(() => parseVisits('60.1')).toThrow(ManualInputError);
  });
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
  it('keeps desktop shares independent of all-device metrics, coverage and guest data', () => {
    const details = parseManualDetails({ desktop_SearchOrganic: '38.72', desktop_GenAi: '0.27', desktop_Direct: '0' });
    const entry = { month: '202610', channels: {}, details, searchShare: null, aiShare: null, taiwanShare: null };
    const profile = manualProfile(entry);
    expect(profile.desktopChannels).toEqual({ SearchOrganic: 0.3872, GenAi: 0.0027, Direct: 0 });
    expect(profile.channels).toEqual({});
    expect(coverageFields(482400, [profile]).missing).toContain('channels.SearchOrganic');
    expect(manualDetailValues(entry as Parameters<typeof manualDetailValues>[0])).toMatchObject({
      desktop_SearchOrganic: '38.72',
      desktop_GenAi: '0.27',
      desktop_Direct: '0',
      desktop_Referrals: '',
    });
    expect(desktopChannelsSection([profile])).toContain('Desktop Only');
    expect(desktopChannelsSection([profile])).toContain('38.72%');
    expect(trafficAccess.run(false, () => desktopChannelsSection([profile]))).toBe('');
    expect(trafficAccess.run(false, () => publicTraffic({ profile }))).not.toHaveProperty('profile.desktopChannels');
    expect(profile.desktopChannels?.Direct).toBe(0);
    expect(() => parseManualDetails({ desktop_Direct: '101' })).toThrow(ManualInputError);
    expect(() => parseManualDetails({ desktop_Direct: '60', desktop_SearchOrganic: '50' })).toThrow('合計');
  });
});
