import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseManualChannels, parseManualDetails, parseShare, parseVisits } from '../src/manual.ts';
import { mergeScreenshots, parseScreenshot, refineScreenshotNumbers } from '../src/manual-ocr-parser.js';

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
    expect(result.warnings.join(' ')).toContain('請核對範圍');
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
