import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { cleanTag, resolveTags, voterOf } from '../src/crowd.ts';
import { buildDomainSheet, domainSheetRows, readDomainSheet } from '../src/domain-sheet.ts';
import { parseShare, parseVisits, recentMonths } from '../src/manual.ts';
import { ranking, type SiteMonth, topicSummary } from '../src/metrics.ts';
import { categoryLabel, channelTiles, similarwebSection, watchPage } from '../src/pages.ts';
import { lookupStatus } from '../src/requests.ts';
import { type Candidate, dueDomains, previousMonth, runConfig } from '../src/scheduler.ts';
import { readMonthTab, readMonthTabs, readWorkbook } from '../src/sheet.ts';
import { publicDomain, searchShare } from '../src/similarweb.ts';
import { fetchQueue } from '../src/status.ts';

const now = new Date('2026-10-21T10:00:00Z');
const DAY = 86_400_000;
const candidate = (domain: string, over: Partial<Candidate> = {}): Candidate => ({
  domain,
  tier: 0,
  refreshDays: 7,
  pendingSince: null,
  lastAttempt: 0,
  lastSuccess: 0,
  nextAttempt: 0,
  latestProfile: null,
  ...over,
});

describe('dueDomains', () => {
  it('orders missing last month first, then never tried, each group by requester priority, then the oldest success', () => {
    const t = now.getTime();
    const month = previousMonth(now);
    const due = dueDomains(
      [
        candidate('sheet-old.tw', { tier: 2, lastSuccess: t - 40 * DAY, lastAttempt: t - 40 * DAY, refreshDays: 30, latestProfile: month }),
        candidate('sheet-behind.tw', {
          tier: 2,
          lastSuccess: t - 5 * DAY,
          lastAttempt: t - 5 * DAY,
          refreshDays: 30,
          latestProfile: '202608',
        }),
        candidate('sheet-new.tw', { tier: 2, refreshDays: 30 }),
        candidate('tag-old.tw', { lastSuccess: t - 9 * DAY, lastAttempt: t - 9 * DAY, latestProfile: month }),
        candidate('tag-new.tw'),
        candidate('blog.tw', { tier: 1, refreshDays: null, pendingSince: t - DAY }),
      ],
      now,
    );
    expect(due).toEqual(['sheet-behind.tw', 'tag-new.tw', 'blog.tw', 'sheet-new.tw', 'tag-old.tw', 'sheet-old.tw']);
  });

  it('skips fresh domains, backoffs and answered one-off lookups', () => {
    const t = now.getTime();
    const due = dueDomains(
      [
        candidate('fresh.tw', { lastSuccess: t - DAY, lastAttempt: t - DAY, latestProfile: previousMonth(now) }),
        candidate('backoff.tw', { nextAttempt: t + DAY }),
        candidate('answered.tw', { refreshDays: null, pendingSince: null }),
      ],
      now,
    );
    expect(due).toEqual([]);
  });

  it('sends one domain missing last month per run until the month has appeared', () => {
    const t = now.getTime();
    const behind = { lastSuccess: t - 5 * DAY, lastAttempt: t - 5 * DAY, latestProfile: '202608' };
    const list = [candidate('a.tw', behind), candidate('b.tw', behind), candidate('new.tw', { tier: 1 })];
    expect(dueDomains(list, now, false)).toEqual(['a.tw', 'new.tw']);
    expect(dueDomains(list, now, true)).toEqual(['a.tw', 'b.tw', 'new.tw']);
  });

  it('retries a watched domain still missing last month every three days', () => {
    const t = now.getTime();
    const base = { lastSuccess: t - 2 * DAY, latestProfile: '202608' };
    expect(dueDomains([candidate('a.tw', { ...base, lastAttempt: t - 2 * DAY })], now)).toEqual([]);
    expect(dueDomains([candidate('a.tw', { ...base, lastAttempt: t - 4 * DAY })], now)).toEqual(['a.tw']);
  });

  it('puts every due domain in an hourly batch, budget at a time, from the next :35', () => {
    const t = now.getTime();
    const config = { ...runConfig({ TRAFFIC_RUN_BUDGET: '2' }) };
    const queue = fetchQueue(
      [
        candidate('a.tw'),
        candidate('b.tw'),
        candidate('c.tw', { lastSuccess: t - 9 * DAY, lastAttempt: t - 9 * DAY, latestProfile: previousMonth(now) }),
      ],
      config,
      null,
      now,
    );
    expect(queue.map((e) => [e.domain, e.position, e.reason, e.requester, e.expectedAt])).toEqual([
      ['a.tw', 1, 'new', 'tag', '2026-10-21T10:35:00.000Z'],
      ['b.tw', 2, 'new', 'tag', '2026-10-21T10:35:00.000Z'],
      ['c.tw', 3, 'refresh', 'tag', '2026-10-21T11:35:00.000Z'],
    ]);
    const cooling = new Date('2026-10-21T10:50:00Z');
    expect(fetchQueue([candidate('a.tw')], config, cooling, now)[0].expectedAt).toBe('2026-10-21T11:35:00.000Z');
  });
});

describe('runConfig', () => {
  it('sends nothing unless a budget is set', () => {
    expect(runConfig({}).budget).toBe(0);
    expect(runConfig({ TRAFFIC_RUN_BUDGET: '15' }).budget).toBe(15);
    expect(runConfig({ TRAFFIC_RUN_BUDGET: 'x' }).budget).toBe(0);
  });
});

describe('publicDomain', () => {
  it('normalises and refuses private names', () => {
    expect(publicDomain('https://www.Example.com.tw/path')).toBe('example.com.tw');
    for (const bad of ['localhost', '10.0.0.1', 'a.local', 'tag.observe.tw', 'x.ts.net', 'u:p@x.com', 'a b.com'])
      expect(publicDomain(bad)).toBeNull();
  });
});

describe('searchShare', () => {
  it('is organic search only, as the sheet computes 搜尋S', () => {
    expect(searchShare({ channels: { SearchOrganic: 0.2387, SearchPaid: 0.01 } })).toBe(0.2387);
    expect(searchShare({ channels: {} })).toBeNull();
  });
});

describe('lookupStatus', () => {
  const asked = new Date('2026-10-20T00:00:00Z');
  const state = (over: object) => ({
    last_attempt_at: null,
    last_response_at: null,
    last_success_at: null,
    failures: 0,
    next_attempt_at: null,
    refused_at: null,
    result: null,
    ...over,
  });
  const later = new Date('2026-10-20T01:00:00Z');
  it('follows the fetch state', () => {
    expect(lookupStatus('traffic', asked, undefined)).toBe('pending');
    expect(lookupStatus('traffic', asked, state({ last_response_at: later, last_success_at: later }))).toBe('ok');
    expect(lookupStatus('traffic', asked, state({ last_response_at: later }))).toBe('no-data');
    expect(lookupStatus('similar_sites', asked, state({ last_response_at: later, result: { similarSites: ['a.com'] } }))).toBe('ok');
    expect(lookupStatus('similar_sites', asked, state({ last_response_at: later, result: { similarSites: [] } }))).toBe('no-data');
    expect(lookupStatus('traffic', asked, state({ refused_at: later }))).toBe('blocked');
    expect(lookupStatus('traffic', asked, state({ failures: 3 }))).toBe('no-data');
  });

  it('is answered by a response from the 30 days before it was asked', () => {
    const before = new Date('2026-10-01T00:00:00Z');
    expect(lookupStatus('traffic', asked, state({ last_response_at: before, last_success_at: before }))).toBe('ok');
    const old = new Date('2026-09-01T00:00:00Z');
    expect(lookupStatus('traffic', asked, state({ last_response_at: old, last_success_at: old }))).toBe('pending');
  });
});

describe('readMonthTab', () => {
  it('finds columns by header, takes cached formula results and flags manual divisors', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('202609');
    ws.addRow([
      null,
      null,
      '名次',
      '網站名',
      '網址',
      '流量',
      '8月',
      '成長',
      '上月',
      '搜尋S',
      'AI',
      '搜尋',
      '8月',
      '成長',
      '搜尋排名',
      '台灣',
      '直接',
      '搜尋',
      '推薦',
      '社群',
      'AI',
    ]);
    ws.addRow(['通路', '電商', 1, '蝦皮', { text: 'shopee.tw', hyperlink: 'https://shopee.tw/' }, 47.24, 50.85]);
    ws.getRow(2).getCell(10).value = { formula: 'F2*R2', result: 11.276 };
    for (const [col, v] of [
      [16, 0.9723],
      [17, 0.4602],
      [18, 0.2387],
      [21, 0.0045],
    ] as const)
      ws.getRow(2).getCell(col).value = v;
    ws.addRow(['社群', '社群', null, { text: 'threads.com /5', hyperlink: 'http://threads.com/' }, null, 499.6]);
    ws.addRow([null, null, null, '只有名字']);
    const rows = readMonthTab(ws, '202609');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      group: '通路',
      topics: '電商',
      name: '蝦皮',
      domain: 'shopee.tw',
      visits: 47.24,
      adjusted: false,
      searchShare: 0.2387,
      aiShare: 0.0045,
      taiwanShare: 0.9723,
    });
    expect(rows[0].raw['J 搜尋S']).toBe(11.276);
    expect(rows[1]).toMatchObject({ name: 'threads.com', domain: 'threads.com', adjusted: true });
  });

  it('reads the 202512 layout, where the visits column is headed 網站', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('202512');
    ws.addRow([null, null, '名次', '網站名', '網站', '11月', '成長']);
    ws.addRow(['多元', '新聞', 1, 'Yahoo 新聞', 48.98, 51.49]);
    expect(readMonthTab(ws, '202512')[0]).toMatchObject({ name: 'Yahoo 新聞', visits: 48.98, domain: null });
  });

  it('keeps labelled rows without figures, rich-text links and domains written into names', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('202609');
    ws.addRow([null, null, '名次', '網站名', '網址', '流量']);
    ws.addRow([
      '非台灣',
      '女性',
      7,
      { text: { richText: [{ text: 'cosmopolitan/' }, { text: '10' }] }, hyperlink: 'http://cosmopolitan.com/' },
    ]);
    ws.addRow(['公家', null, null, '台北市']);
    ws.addRow(['品牌', '財經 (其他)', null, '元大理財 yuantafunds.com']);
    ws.addRow([null, null, null, '只有名字']);
    expect(readMonthTab(ws, '202609').map((r) => [r.name, r.domain, r.group, r.topics, r.adjusted])).toEqual([
      ['cosmopolitan', 'cosmopolitan.com', '非台灣', '女性', true],
      ['台北市', null, '公家', null, false],
      ['元大理財 yuantafunds.com', 'yuantafunds.com', '品牌', '財經 (其他)', false],
    ]);
  });
});

describe('readWorkbook', () => {
  it('gives name-only rows the hand-matched domain, then the domain another month had', async () => {
    const wb = new ExcelJS.Workbook();
    for (const [month, rows] of [
      [
        '202608',
        [
          [null, null, '名次', '網站名', '網址', '流量'],
          ['媒體', '測試', null, '某網站', 'some.tw', 1],
        ],
      ],
      [
        '202609',
        [
          [null, null, '名次', '網站名', '網址', '流量'],
          ['公家', null, null, '台北市'],
          ['媒體', '新聞', null, '某網站'],
        ],
      ],
    ] as const) {
      const ws = wb.addWorksheet(month);
      for (const r of rows) ws.addRow([...r]);
    }
    const rows = await readWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(rows.filter((r) => r.month === '202609').map((r) => [r.name, r.domain])).toEqual([
      ['台北市', 'gov.taipei'],
      ['某網站', 'some.tw'],
    ]);
  });

  it('fills the blank 網址 cells of the latest tab, which win over the hand list and can opt a name out', async () => {
    const wb = new ExcelJS.Workbook();
    for (const [month, rows] of [
      [
        '202608',
        [
          [null, null, '名次', '網站名', '網址', '流量'],
          [null, '舊', null, '舊站'],
        ],
      ],
      [
        '202609',
        [
          [null, null, '名次', '網站名', '網址', '流量', '台灣', '直接'],
          ['公家', null, null, '台北市'],
          ['品牌', '汽機車', null, '8891 /2', null, 3, 0.9, 0.4],
          [null, '書', null, 'Kobo'],
          ['媒體', null, null, '某網站', 'some.tw', 1],
        ],
      ],
    ] as const) {
      const ws = wb.addWorksheet(month);
      for (const r of rows) ws.addRow([...r]);
    }
    const source = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const rows = domainSheetRows(await readMonthTabs(source));
    expect(rows.map((r) => [r.name, r.domain])).toEqual([
      ['舊站', null],
      ['台北市', 'gov.taipei'],
      ['8891', null],
      ['Kobo', null],
    ]);

    const fills = new Map([['8891', { domain: '8891.com.tw', status: '已對應' as const, ai: true, note: 'AI' }]]);
    const sheet = await buildDomainSheet(source, rows, fills);
    expect([sheet.month, sheet.filled, sheet.older]).toEqual(['202609', 3, 1]);
    expect(sheet.wb.worksheets.map((ws) => ws.name)).toEqual(['202609 網址', '更早月份', '說明']);
    const tab = sheet.wb.getWorksheet('202609 網址') as ExcelJS.Worksheet;
    expect(['E2', 'E3', 'E4', 'E5'].map((c) => tab.getCell(c).text)).toEqual(['gov.taipei', '8891.com.tw', '', 'some.tw']);
    // The divisor leaves the name for 台灣估算, right of 台灣; later columns move over.
    expect([
      tab.getCell('D3').text,
      tab.getCell('H1').text,
      tab.getCell('H3').value,
      tab.getCell('I1').text,
      tab.getCell('I3').value,
    ]).toEqual(['8891', '台灣估算', 0.5, '直接', 0.4]);
    expect(sheet.divisors).toBe(1);
    tab.getCell('E2').value = 'https://www.taipei.gov/';
    tab.getCell('E4').value = '不追蹤';
    const { domains, problems } = await readDomainSheet((await sheet.wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(problems).toEqual([]);
    expect((await readWorkbook(source, domains)).filter((r) => r.month === '202609').map((r) => [r.name, r.domain])).toEqual([
      ['台北市', 'taipei.gov'],
      ['8891', '8891.com.tw'],
      ['Kobo', null],
      ['某網站', 'some.tw'],
    ]);
  });
});

describe('ranking and topicSummary', () => {
  const site = (domain: string, visits: number, prevVisits: number | null, topics: string[], search = 0.5, ai = 0.01): SiteMonth => ({
    domain,
    name: domain,
    group: null,
    topics,
    visits,
    prevVisits,
    visitsSource: 'similarweb',
    searchShare: search,
    aiShare: ai,
    taiwanShare: null,
    prevSearchShare: search,
    prevAiShare: ai,
    channels: null,
  });
  const view = [site('a.tw', 10, 8, ['台灣', '電商']), site('b.tw', 9, 12, ['台灣', '電商', '科技']), site('c.tw', 1, null, [])];

  it('ranks within a topic and reports last month’s rank there', () => {
    const list = ranking(view, '電商');
    expect(list.map((s) => [s.domain, s.rank, s.prevRank])).toEqual([
      ['a.tw', 1, 2],
      ['b.tw', 2, 1],
    ]);
    expect(list[0].growth).toBeCloseTo(0.25);
    expect(list[0].searchVisits).toBe(5);
  });

  it('ranks all sites and treats geographic labels like every other tag', () => {
    const foreign = { ...site('f.com', 20, 30, ['非台灣', '電商']), group: '非台灣' };
    const list = ranking([foreign, ...view], '電商');
    expect(list.map((s) => [s.domain, s.rank, s.prevRank])).toEqual([
      ['f.com', 1, 1],
      ['a.tw', 2, 3],
      ['b.tw', 3, 2],
    ]);
    expect(ranking([foreign, ...view], '非台灣').map((s) => s.domain)).toEqual(['f.com']);
    expect(ranking([foreign, ...view], '台灣').map((s) => s.domain)).toEqual(['a.tw', 'b.tw']);
  });

  it('ranks sites without geographic labels', () => {
    const unknown = { ...site('unknown.tw', 100, 90, ['新聞']), taiwanShare: 0.99 };
    expect(ranking([unknown], null)[0]).toMatchObject({ rank: 1, prevRank: 1 });
  });

  it('sums each topic, counting multi-topic sites in each, leaving out unlabelled ones', () => {
    const summary = Object.fromEntries(topicSummary(view).map((t) => [t.topic, t]));
    expect(summary['電商'].visitsGrowth).toBeCloseTo(19 / 20 - 1);
    expect(summary['科技'].sites).toBe(1);
    expect(Object.keys(summary).sort()).toEqual(['台灣', '科技', '電商'].sort());
  });
});

describe('months copied from the Similarweb platform', () => {
  it('reads visits as the platform writes them, or as a plain count', () => {
    expect(parseVisits('60.10M')).toBe(60_100_000);
    expect(parseVisits(' 950k ')).toBe(950_000);
    expect(parseVisits('1.2B')).toBe(1_200_000_000);
    expect(parseVisits('60,100,000')).toBe(60_100_000);
    for (const bad of ['', '60.1', 'abc', '-5M', '0M']) expect(() => parseVisits(bad), bad).toThrow();
  });
  it('reads shares as percentages and leaves blanks empty', () => {
    expect(parseShare('36.45%', '搜尋')).toBeCloseTo(0.3645, 10);
    expect(parseShare('0.37', 'AI')).toBeCloseTo(0.0037, 10);
    expect(parseShare('', 'AI')).toBeNull();
    expect(() => parseShare('120', 'AI')).toThrow();
  });
  it('offers the three months before the current one in Taipei', () => {
    expect(recentMonths(new Date('2026-10-24T03:00:00Z'))).toEqual(['202609', '202608', '202607']);
    // 2027-01-01 01:00 in Taipei is still 2026-12-31 in UTC.
    expect(recentMonths(new Date('2026-12-31T17:00:00Z'))).toEqual(['202612', '202611', '202610']);
  });
});

describe('visit counts', () => {
  it('shows four significant digits with k under a million, m under ten billion, then b', async () => {
    const { volText } = await import('../src/pages.ts');
    const cases: Array<[number, string]> = [
      [437e-6, '437'],
      [12_340e-6, '12.34k'],
      [950_249e-6, '950.2k'],
      [999_960e-6, '1000k'],
      [1.2, '1.200m'],
      [60.1, '60.10m'],
      [757.316, '757.3m'],
      [4030.84, '4031m'],
      [12_345.6, '12.35b'],
      [0, '0'],
    ];
    for (const [millions, shown] of cases) expect(volText(millions), String(millions)).toBe(shown);
    expect(volText(null)).toBe('');
  });
});

describe('filter chips', () => {
  it('marks a chosen chip and a left-out chip, each with where the next click leads', async () => {
    const { chipRow } = await import('../src/pages.ts');
    const row = chipRow('網站標籤', { href: '/all', text: '全部標籤', on: false }, [
      { href: '/exclude-a', text: 'A', count: 3, on: true, hint: '再按一次改為排除' },
      { href: '/clear-b', text: 'B', count: 2, on: false, excluded: true, hint: '已排除，再按一次取消' },
    ]);
    expect(row).toContain('<a class="chip-filter" href="/exclude-a" aria-current="true" title="再按一次改為排除">A');
    expect(row).toContain('<a class="chip-filter excluded" href="/clear-b" title="已排除，再按一次取消">−B');
  });
});

describe('crowd tags', () => {
  const crowd = (tag: string, more: object) => ({ tag, ai: false, community: false, admin: null, agrees: 0, disagrees: 0, ...more });
  it('keeps the base list, hides AI at two net disagreements and reader tags when disagreements catch up', () => {
    const tags = resolveTags(
      ['新聞', '台灣'],
      [
        crowd('新聞', { disagrees: 5 }),
        crowd('美食', { ai: true, disagrees: 1 }),
        crowd('旅遊', { ai: true, disagrees: 2 }),
        crowd('咖啡', { community: true, agrees: 2, disagrees: 1 }),
        crowd('登山', { community: true, agrees: 1, disagrees: 1 }),
        crowd('只有票', { agrees: 3 }),
        crowd('台灣', { admin: 'hide' }),
      ],
    );
    expect(tags.filter((t) => t.visible).map((t) => [t.tag, t.source])).toEqual([
      ['新聞', 'editor'],
      ['咖啡', 'community'],
      ['美食', 'ai'],
    ]);
    expect(tags.filter((t) => !t.visible).map((t) => t.tag)).toEqual(['台灣', '登山', '旅遊']);
  });
  it('cleans what readers type and takes an existing spelling', () => {
    expect(cleanTag(' ＃ ai  工具 ', ['AI 工具'])).toBe('AI 工具');
    expect(cleanTag('#咖啡')).toBe('咖啡');
    for (const bad of ['', '!!!', 'a、b', 'x/y', 'a'.repeat(33), 3]) expect(cleanTag(bad)).toBeNull();
    expect(voterOf(' A@Gmail.com ')).toBe('a@gmail.com');
    expect(voterOf('nobody')).toBeNull();
  });
});

describe('Similarweb composition', () => {
  it('names categories in plain words and shows every channel and country', () => {
    expect(categoryLabel('Finance/Investing')).toBe('金融 › 投資');
    expect(categoryLabel('Health/Health')).toBe('健康');
    expect(categoryLabel('Pets_and_Animals/Birds')).toBe('寵物與動物 › Birds');
    const html = similarwebSection({
      domain: 'x.tw',
      category: null,
      similarSites: [],
      months: [{ month: '202609', similarweb: 10, sheet: null, searchShare: null, aiShare: null, taiwanShare: null }],
      profile: {
        month: '202609',
        countries: [{ code: 'TW', share: 0.9 }],
        channels: { Direct: 0.5, SearchOrganic: 0.4, GenAi: 0.005 },
        bounceRate: 0.5,
        pagesPerVisit: 2,
        timeOnSite: 125,
        globalRank: 1000,
        countryRank: { code: 'TW', rank: 20 },
        categoryRank: { category: 'News_and_Media', rank: 3 },
      },
    });
    for (const text of ['#1,000', '台灣排名', '新聞與媒體', '2 分 05 秒', '直接造訪', '約 5.000m', '0.50%', '聯盟行銷', '其他國家'])
      expect(html).toContain(text);
    expect(similarwebSection({ domain: 'x.tw', category: null, similarSites: [], months: [], profile: null })).toBe('');
  });
});

describe('channel tiles', () => {
  it('draws one tile per channel, largest share first, with the change in percentage points', () => {
    const html = channelTiles([
      { month: '202609', shares: { Direct: 0.5, GenAi: 0.01 } },
      { month: '202610', shares: { Direct: 0.4, GenAi: 0.03 } },
    ]);
    expect(html.match(/class="chart-box channel-tile/g)?.length).toBe(10);
    expect(html.indexOf('直接造訪')).toBeLessThan(html.indexOf('AI 工具'));
    expect(html).toContain('▼10.0 個百分點');
    expect(html).toContain('持平');
    expect(html).toContain('▲2.0 個百分點');
  });
});

describe('watchPage', () => {
  it('shows who added a domain to editors only', () => {
    const row = {
      domain: 'ambassador-hotels.com',
      requester: 'manual',
      refreshDays: 30,
      addedBy: 'editor@example.com',
      note: '國賓飯店',
      requestedAt: now,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastResponseAt: null,
      failures: 0,
      lastError: null,
      latestMonth: null,
      latestVisits: null,
    };
    const page = (editor: { email: string } | null) => watchPage({ editor, loginEnabled: true, manual: [row], others: [], flash: null });
    expect(page(null)).toContain('ambassador-hotels.com');
    expect(page(null)).not.toContain('editor@example.com');
    expect(page({ email: 'editor@example.com' })).toContain('editor@example.com');
  });
});
