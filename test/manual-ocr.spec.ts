import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseManualChannels, parseManualDetails, parseShare, parseVisits } from '../src/manual.ts';
import { mergeScreenshots, parseScreenshot, refineScreenshotNumbers, reviewScreenshotCountries } from '../src/manual-ocr-parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/manual-ocr/${name}.tsv`, import.meta.url), 'utf8');
describe('Similarweb screenshot extraction', () => {
  it('reads stock screenshots without mixing country changes or chart axes into shares', () => {
    const result = mergeScreenshots(['channels', 'engagement'].map((name) => parseScreenshot(fixture(name))));
    expect(result).toEqual({
      months: ['202610'],
      warnings: [],
      fields: {
        visits: '29.54M',
        pages: '5.25',
        duration: '00:05:40',
        bounce: '42.87',
        taiwan: '94.16',
        countries: 'TW 94.16\nUS 1.87\nCA 1.53\nTH 0.58\nJP 0.35',
        Direct: '33.08',
        search: '35.20',
        SearchPaid: '0.00',
        Referrals: '27.49',
        DisplayAds: '0.09',
        SocialOrganic: '3.15',
        SocialPaid: '0.16',
        ai: '0.23',
        Mail: '0.58',
        Affiliate: '0.00',
      },
    });
    expect(parseVisits(result.fields.visits)).toBe(29_540_000);
    expect(parseManualDetails(result.fields)).toMatchObject({
      timeOnSite: 340,
      bounceRate: expect.closeTo(0.4287, 10),
      countries: [
        { code: 'TW', share: 0.9416 },
        { code: 'US', share: 0.0187 },
        { code: 'CA', share: expect.closeTo(0.0153, 10) },
        { code: 'TH', share: 0.0058 },
        { code: 'JP', share: expect.closeTo(0.0035, 10) },
      ],
    });
    expect(parseManualChannels(result.fields)).toMatchObject({ SearchPaid: 0, Affiliate: 0 });
    expect(parseShare(result.fields.search, '搜尋')).toBeCloseTo(0.352);
  });
  it('omits uncertain numeric recognition instead of inventing a value', () => {
    const input = fixture('engagement')
      .split('\n')
      .map((line) => {
        const cells = line.split('\t');
        if (cells[11] === '29.54M') cells[10] = '45';
        return cells.join('\t');
      })
      .join('\n');
    const result = parseScreenshot(input);
    expect(result.fields.visits).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('月造訪量');
  });
  it('reads extension engagement, countries and independent desktop-only sources', () => {
    const result = mergeScreenshots(['extension-engagement', 'extension-geography'].map((name) => parseScreenshot(fixture(name))));
    expect(result.months).toEqual(['202610']);
    expect(result.fields).toEqual({
      visits: '416.5K',
      pages: '3.34',
      duration: '00:05:40',
      bounce: '44.43',
      taiwan: '97.02',
      countries: 'TW 97.02\nUS 1.76\nHK 0.73\nJP 0.3',
      desktop_Direct: '60.69',
      desktop_SearchOrganic: '32.53',
      desktop_SocialOrganic: '3.63',
      desktop_GenAi: '0.69',
      desktop_Mail: '0.32',
      desktop_SocialPaid: '0',
      desktop_SearchPaid: '0',
      desktop_Affiliate: '0',
      desktop_DisplayAds: '0',
    });
    expect(parseVisits(result.fields.visits)).toBe(416_500);
    expect(result.warnings.join(' ')).toContain('獨立的「桌面限定」欄位');
    expect(result.warnings.join(' ')).toContain('Germany');
    expect(result.warnings.join(' ')).toContain('請確認');
  });
  it('keeps device restrictions on the country card and on a cropped source card', () => {
    const input = fixture('extension-geography');
    // Put the device filter above the country card instead of the source card.
    const restrictedCountry = input.replace(/\t1143\t/g, '\t10\t');
    expect(parseScreenshot(restrictedCountry).fields).toEqual({});
    const cropped = input
      .split('\n')
      .filter((line) => +line.split('\t')[7] >= 1000 || line.startsWith('1\t'))
      .join('\n');
    expect(parseScreenshot(cropped).fields).toMatchObject({ desktop_Direct: '60.69' });
    expect(parseScreenshot(cropped).fields.taiwan).toBeUndefined();
    const mobile = parseScreenshot(input.replace('Desktop', 'Mobile'));
    expect(mobile.fields.taiwan).toBe('97.02');
    expect(mobile.fields.desktop_Direct).toBeUndefined();
    expect(mobile.warnings.join(' ')).toContain('已略過該區塊');
  });
  it('reads a title-cropped Country table above desktop sources in the actual s3 screenshot', () => {
    const result = parseScreenshot(fixture('s3-geography'));
    expect(result.fields).toMatchObject({
      taiwan: '93.23',
      countries: 'TW 93.23\nHK 1.59\nID 0.58\nMY 0.57',
      desktop_SearchOrganic: '38.72',
      desktop_SocialPaid: '20.48',
      desktop_Direct: '13.09',
      desktop_SearchPaid: '8.79',
      desktop_SocialOrganic: '6.08',
      desktop_Referrals: '3.47',
      desktop_DisplayAds: '2.36',
      desktop_Mail: '2.07',
      desktop_GenAi: '0.27',
    });
    expect(result.fields.search).toBeUndefined();
    expect(result.fields.Direct).toBeUndefined();
    // Raw OCR lost these decimal points. They stay empty without a successful crop re-read.
    expect(result.fields.desktop_Affiliate).toBeUndefined();
  });
  it('only accepts a missing decimal after an independent high-confidence crop recognition', async () => {
    const word = (value: string, confidence: number) =>
      `1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t${confidence}\t${value}`;
    const original = word('213%', 90);
    const repaired = await refineScreenshotNumbers(original, async () => word('2.13%', 90));
    expect(repaired).toContain('\t2.13%');
    expect(await refineScreenshotNumbers(original, async () => word('2.13%', 50))).toBe(original);
    expect(await refineScreenshotNumbers(original, async () => word('2.18%', 99))).toBe(original);
    expect(await refineScreenshotNumbers(original, async () => word('<2.13%', 99))).toBe(original);
    let retries = 0;
    await refineScreenshotNumbers(word('2.13%', 90), async () => {
      retries++;
      return '';
    });
    expect(retries).toBe(0);
  });
  it('recovers a missing country label from a second reading without replacing recognized rows', async () => {
    const tsv = fixture('s3-geography-compressed');
    const primary = parseScreenshot(tsv);
    expect(primary.fields.taiwan).toBeUndefined();
    const secondary = parseScreenshot(fixture('s3-geography'));
    const result = await reviewScreenshotCountries(tsv, primary, async () => secondary);
    expect(result.fields.taiwan).toBe('93.23');
    expect(result.fields.countries).toContain('TW 93.23');
    expect(result.fields.countries).toContain('HK 1.59');
    expect(result.fields.desktop_SearchOrganic).toBe(primary.fields.desktop_SearchOrganic);
    expect(result.months).toEqual(primary.months);
  });
  it('does not invent missing countries and drops conflicting or impossible supplementary shares', async () => {
    const tsv = fixture('s3-geography-compressed');
    const primary = { fields: { countries: 'US 2.13\nHK 1.59', desktop_Direct: '13.09' }, months: [], warnings: [] };
    const empty = { fields: {}, months: [], warnings: [] };
    const missing = await reviewScreenshotCountries(tsv, primary, async () => empty);
    expect(missing.fields.taiwan).toBeUndefined();
    expect(missing.fields.countries).toBe(primary.fields.countries);
    expect(missing.warnings.join(' ')).toContain('漏辨識');
    const conflict = await reviewScreenshotCountries(tsv, primary, async () => ({
      ...empty,
      fields: { countries: 'TW 93.23\nUS 2.18\nHK 1.590' },
    }));
    expect(conflict.fields.countries).toBe('TW 93.23\nHK 1.590');
    expect(conflict.fields.desktop_Direct).toBe('13.09');
    expect(conflict.warnings.join(' ')).toContain('不一致');
    const impossible = await reviewScreenshotCountries(tsv, primary, async () => ({
      ...empty,
      fields: { countries: 'TW 99.23' },
    }));
    expect(impossible.fields.countries).toBeUndefined();
    expect(impossible.fields.taiwan).toBeUndefined();
    expect(impossible.warnings.join(' ')).toContain('超過 100%');
  });
  it('preserves independently read Taiwan when another bad country invalidates the retry list', async () => {
    const tsv = fixture('s3-geography-telegram');
    const primary = parseScreenshot(tsv.replace(/\tTaiwan/g, '\tUnreadable'), true);
    expect(primary.fields.taiwan).toBeUndefined();
    // PSM 6 can read Malaysia 0.57% as 57%; that rejects its list even though
    // the same pass has a high-confidence Taiwan scalar and source location.
    const secondary = parseScreenshot(tsv.replace('0.57%', '57%'), true);
    expect(secondary.fields.taiwan).toBe('93.23');
    expect(secondary.fields.countries).toBeUndefined();
    const result = await reviewScreenshotCountries(tsv, primary, async () => secondary);
    expect(result.fields.taiwan).toBe('93.23');
    expect(result.fields.countries).toContain('TW 93.23');
    expect(result.sources?.taiwan[0]).toMatchObject({ value: '93.23', y: 98 });
    expect(result.sources?.countries.some((s) => s.value === 'TW 93.23')).toBe(true);
  });
  it('retains uncertain regions and country context without treating them as recognized values', () => {
    const tsv = fixture('s3-geography-telegram')
      .split('\n')
      .map((line) => {
        const cells = line.split('\t');
        if (cells[11] === '93.23%') cells[10] = '25';
        return cells.join('\t');
      })
      .join('\n');
    const plain = parseScreenshot(tsv);
    expect(plain.fields.taiwan).toBeUndefined();
    expect(plain).not.toHaveProperty('countryContexts');
    const located = parseScreenshot(tsv, true);
    expect(located.fields.taiwan).toBeUndefined();
    expect(located.sources?.taiwan).toBeUndefined();
    expect(located.uncertainSources?.taiwan[0]).toMatchObject({ value: '93.23%', y: 98 });
    expect(located.countryContexts?.[0].h).toBeGreaterThan(100);
    const merged = mergeScreenshots([located]);
    expect(merged.uncertainSources?.taiwan).toHaveLength(1);
    expect(merged.countryContexts).toHaveLength(1);
    expect(merged.fields.taiwan).toBeUndefined();
  });
  it('keeps conflicting image regions as uncertain evidence without selecting a value', () => {
    const first = parseScreenshot(fixture('s3-geography-telegram'), true);
    const region = first.sources?.taiwan[0];
    expect(region).toMatchObject({ value: '93.23', x: 70, y: 98 });
    expect(region?.w).toBeGreaterThan(1100);
    expect(first.countryTable).toBe(true);
    expect(first.sources?.countries.map((s) => s.value)).toContain('TW 93.23');
    const conflicting = parseScreenshot(fixture('s3-geography-telegram').replace('93.23%', '92.23%'), true);
    const result = mergeScreenshots([first, conflicting]);
    expect(result.fields.taiwan).toBeUndefined();
    expect(result.sources?.taiwan).toBeUndefined();
    expect(result.uncertainSources?.taiwan.map((region) => region.value)).toEqual(['93.23', '92.23']);
    expect(result.sources?.desktop_Direct).toHaveLength(2);
  });
  it('skips country retries for complete tables, absent tables and restricted device scopes', async () => {
    let attempts = 0;
    for (const tsv of [fixture('engagement'), fixture('channels'), fixture('extension-geography').replace(/\t1143\t/g, '\t10\t')]) {
      const primary = parseScreenshot(tsv);
      expect(
        await reviewScreenshotCountries(tsv, primary, async () => {
          attempts++;
          return primary;
        }),
      ).toBe(primary);
    }
    expect(attempts).toBe(0);
  });
  it('requires an explicit all-traffic scope for extension source lists and preserves explicit zeroes', () => {
    const input = fixture('extension-geography');
    // Simulate an all-device source card using the real extension row layout.
    const allTraffic = input.replace('Desktop', 'All').replace('Only', 'traffic');
    const result = parseScreenshot(allTraffic);
    expect(result.fields).toMatchObject({
      Direct: '60.69',
      search: '32.53',
      SocialOrganic: '3.63',
      ai: '0.69',
      Mail: '0.32',
      SocialPaid: '0',
      SearchPaid: '0',
      Affiliate: '0',
      DisplayAds: '0',
    });
    // Tesseract lost the decimal in 2.13%; never copy its out-of-range 213%.
    expect(result.fields.Referrals).toBeUndefined();
    const noScope = parseScreenshot(allTraffic.replace('Worldwide', 'Unknown'));
    expect(noScope.fields.Direct).toBeUndefined();
    expect(noScope.fields.taiwan).toBe('97.02');
    expect(noScope.warnings.join(' ')).toContain('已略過該區塊');
  });
  it('refuses explicit desktop traffic and reports missing or conflicting dates', () => {
    expect(parseScreenshot(fixture('engagement').replace('Worldwide', 'Desktop')).fields).toEqual({});
    expect(parseScreenshot(fixture('engagement').replace(/0ct2026/g, 'October2026')).months).toEqual(['202610']);
    expect(parseScreenshot(fixture('engagement').replace(/0ct2026/g, '')).months).toEqual([]);
    expect(
      mergeScreenshots([parseScreenshot(fixture('engagement')), parseScreenshot(fixture('channels').replace('0ct2026', 'Sep2026'))]).months,
    ).toEqual(['202610', '202609']);
  });
  it('drops conflicting fields across images and leaves unrecognized content empty', () => {
    const result = mergeScreenshots([
      parseScreenshot(fixture('engagement')),
      parseScreenshot(fixture('engagement').replace('29.54M', '99.54M')),
    ]);
    expect(result.fields.visits).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('不一致');
    expect(parseScreenshot('random screenshot').fields).toEqual({});
  });
});
