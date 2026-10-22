import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { ranking, type SiteMonth, topicSummary } from '../src/metrics.ts';
import { lookupStatus } from '../src/requests.ts';
import { type Candidate, dueDomains, previousMonth, runConfig } from '../src/scheduler.ts';
import { readMonthTab } from '../src/sheet.ts';
import { publicDomain, searchShare } from '../src/similarweb.ts';

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
  it('orders by requester priority, never fetched first, then the oldest success', () => {
    const t = now.getTime();
    const due = dueDomains(
      [
        candidate('sheet-old.tw', { tier: 2, lastSuccess: t - 40 * DAY, refreshDays: 30 }),
        candidate('tag-old.tw', { lastSuccess: t - 9 * DAY, lastAttempt: t - 9 * DAY }),
        candidate('tag-new.tw'),
        candidate('blog.tw', { tier: 1, refreshDays: null, pendingSince: t - DAY }),
      ],
      now,
    );
    expect(due).toEqual(['tag-new.tw', 'tag-old.tw', 'blog.tw', 'sheet-old.tw']);
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

  it('retries a watched domain still missing last month every three days', () => {
    const t = now.getTime();
    const base = { lastSuccess: t - 2 * DAY, latestProfile: '202608' };
    expect(dueDomains([candidate('a.tw', { ...base, lastAttempt: t - 2 * DAY })], now)).toEqual([]);
    expect(dueDomains([candidate('a.tw', { ...base, lastAttempt: t - 4 * DAY })], now)).toEqual(['a.tw']);
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
  });
  const view = [site('a.tw', 10, 8, ['電商']), site('b.tw', 9, 12, ['電商', '科技']), site('c.tw', 1, null, [])];

  it('ranks within a topic and reports last month’s rank there', () => {
    const list = ranking(view, '電商');
    expect(list.map((s) => [s.domain, s.rank, s.prevRank])).toEqual([
      ['a.tw', 1, 2],
      ['b.tw', 2, 1],
    ]);
    expect(list[0].growth).toBeCloseTo(0.25);
    expect(list[0].searchVisits).toBe(5);
  });

  it('lists 非台灣 sites without a rank, so local sites keep their places', () => {
    const foreign = { ...site('f.com', 20, 30, ['電商']), group: '非台灣' };
    const list = ranking([foreign, ...view], '電商');
    expect(list.map((s) => [s.domain, s.rank, s.prevRank])).toEqual([
      ['f.com', null, null],
      ['a.tw', 1, 2],
      ['b.tw', 2, 1],
    ]);
  });

  it('sums each topic, counting multi-topic sites in each, unlabelled ones under 未分類', () => {
    const summary = Object.fromEntries(topicSummary(view).map((t) => [t.topic, t]));
    expect(summary['電商'].visitsGrowth).toBeCloseTo(19 / 20 - 1);
    expect(summary['科技'].sites).toBe(1);
    expect(summary['未分類'].visitsGrowth).toBeNull();
  });
});
