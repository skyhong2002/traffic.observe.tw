import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseManualChannels, parseManualDetails, parseShare, parseVisits } from '../src/manual.ts';
import { mergeScreenshots, parseScreenshot } from '../src/manual-ocr-parser.js';

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
