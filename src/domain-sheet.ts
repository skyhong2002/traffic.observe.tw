import ExcelJS from 'exceljs';
import { divisorOf, type SheetRow, siteName, text } from './sheet.ts';
import { SHEET_DOMAINS } from './sheet-domains.ts';
import { trafficDomain } from './similarweb.ts';

// The「網址對照表」: a Google Sheet laid out like GeneHong's latest month tab
// (標籤 A／B, 名次, 網站名, 網址, 流量…), with the 網址 cells his tab leaves blank
// filled in, so he keeps filling it the way he fills his own. It takes over from
// SHEET_DOMAINS: every row maps 網站名 → 網址, and「不追蹤」in 網址 opts a name
// out. Only names and domains are read from it; tags stay in traffic.

export const DOMAIN_SHEET_ID = process.env.TRAFFIC_DOMAIN_SHEET_ID ?? '';
export const domainSheetUrl = (id = DOMAIN_SHEET_ID) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;

export const NOT_TRACKED = '不追蹤';
export const OLDER_TAB = '更早月份';
const BLUE = 'FF0000FF';
const GREY = 'FF999999';
const HEADER = 'FFC9DAF8';
const FILLS = { ai: 'FFFFF2CC', unsure: 'FFFCE5CD', todo: 'FFF4CCCC' };

const HELP: Array<[string, string?]> = [
  ['網址對照表怎麼填'],
  [''],
  ['用途', '「Similar Web 新聞」月份分頁只寫網站名、沒寫網址的網站，在這裡補上網址，site.observe.tw 才能追蹤流量、套上標籤。'],
  [
    '格式',
    '和月份分頁相同。系統只讀「網站名」和「網址」兩欄，其他欄照抄原表供參考，改了不會有作用；標籤請在 site.observe.tw 的網站頁修改。',
  ],
  ['網址', '寫網域或網址都可以，例如 8891.com.tw、https://www.kktix.com/；子網域可以（tw.news.yahoo.com）。'],
  ['不追蹤', '不是網站、已經關站，或不要追蹤的，在網址欄寫「不追蹤」。'],
  [
    '台灣估算',
    '原表網站名結尾的「/5」「/100」這類除數（估計 1/5 的流量來自台灣），拉到「台灣」右邊這一欄，寫成比例（20%、1%）；網站名只留名稱。',
  ],
  ['數字', '這份是參考用的複本，原表的公式都換成當時算出來的數值。'],
  ['網站名', '和月份分頁一字不差（結尾的 /5 這類除數不影響）。月份分頁出現新的「只有名稱」網站時，在最下面加一列即可。'],
  ['淡黃底', 'AI 查到並核對過的網址，滑鼠移到格子上可看查證依據。'],
  ['橘底', 'AI 也不確定的網址，請優先確認。'],
  ['紅底', '還沒有網址。'],
  [OLDER_TAB, '只出現在更早月份、最新分頁沒有的網站名，格式相同。'],
];

export interface DomainSheetRow {
  name: string;
  domain: string | null;
  a: string | null;
  b: string | null;
  month: string;
  visits: number | null;
  source: string;
}

/** What to write into a name's blank 網址 cell. */
export interface DomainFill {
  domain: string | null;
  /** 不追蹤 writes「不追蹤」; 待填 leaves the cell blank. */
  status: '已對應' | '不確定' | '不追蹤' | '待填';
  note?: string | null;
  ai?: boolean;
}

/**
 * One row per name that some month tab writes without a domain of its own,
 * with the domain readWorkbook would give it today. `tabs` are the rows as
 * readMonthTabs returns them (before any matching).
 */
export function domainSheetRows(tabs: SheetRow[]): DomainSheetRow[] {
  const sorted = [...tabs].sort((a, b) => a.month.localeCompare(b.month) || a.rowNo - b.rowNo);
  const ownDomain = new Map<string, string>();
  const latest = new Map<string, SheetRow>();
  const nameOnly = new Set<string>();
  for (const r of sorted) {
    if (r.domain) ownDomain.set(r.name, r.domain);
    else nameOnly.add(r.name);
    latest.set(r.name, r);
  }
  return [...nameOnly].map((name) => {
    const r = latest.get(name) as SheetRow;
    const hand = SHEET_DOMAINS[name];
    const other = ownDomain.get(name);
    return {
      name,
      domain: hand ?? other ?? null,
      a: r.group,
      b: r.topics,
      month: r.month,
      visits: r.visits,
      source: hand ? '人工對照' : other ? '同名其他月份' : '',
    };
  });
}

const columns = (ws: ExcelJS.Worksheet) => {
  const col = new Map<string, number>();
  ws.getRow(1).eachCell((cell, n) => {
    const t = text(cell);
    if (t) col.set(t.replace(/\s+/g, ' '), n);
  });
  return { name: col.get('網站名') ?? col.get('媒體名'), url: col.get('網址'), taiwan: col.get('台灣') };
};

/** Formulas become the value they show: this tab is a reference copy, and Sheets would recalculate them against moved columns. */
const flatten = (ws: ExcelJS.Worksheet) =>
  ws.eachRow((row) =>
    row.eachCell((cell) => {
      const v = cell.value as { formula?: string; sharedFormula?: string; result?: unknown } | null;
      if (!v || typeof v !== 'object' || !('formula' in v || 'sharedFormula' in v)) return;
      const r = v.result;
      cell.value = r === undefined || (typeof r === 'object' && r !== null && !(r instanceof Date)) ? null : (r as ExcelJS.CellValue);
    }),
  );

export const ESTIMATE = '台灣估算';
/**
 * Moves the divisor out of the name (「threads.com /5」→「threads.com」) into a
 * 台灣估算 column after `after` (the 台灣 column), as the share it stands for (20%).
 */
const splitDivisors = (ws: ExcelJS.Worksheet, nameCol: number, after: number) => {
  const found = new Map<number, number>();
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const cell = row.getCell(nameCol);
    const raw = text(cell);
    const d = raw ? divisorOf(raw) : null;
    if (!raw || !d) return;
    cell.value = cell.hyperlink ? { text: siteName(raw), hyperlink: cell.hyperlink } : siteName(raw);
    found.set(n, d);
  });
  // Shift the cells right of `after` by one by hand: spliceColumns drops some column widths.
  const last = ws.columnCount;
  for (let n = 1; n <= ws.rowCount; n++) {
    for (let c = last; c > after; c--) {
      const from = ws.getCell(n, c);
      const to = ws.getCell(n, c + 1);
      to.value = from.value;
      to.style = { ...from.style };
      if (from.note) to.note = from.note;
    }
    const gap = ws.getCell(n, after + 1);
    gap.value = null;
    gap.style = {};
  }
  const head = ws.getCell(1, after + 1);
  head.value = ESTIMATE;
  head.style = { ...ws.getCell(1, after).style };
  head.note = '原表網站名結尾的「/5」這類除數：估計 1/5 的流量來自台灣，這裡寫成 20%。';
  for (const [n, d] of found) {
    const cell = ws.getCell(n, after + 1);
    cell.value = 1 / d;
    cell.numFmt = '0.00%';
    cell.note = `原表網站名寫「/${d}」`;
  }
  return found.size;
};

/** CJK characters take two columns. */
const textWidth = (t: string) => [...t].reduce((w, ch) => w + ((ch.codePointAt(0) as number) > 0x2e80 ? 2 : 1), 0);
const shown = (cell: ExcelJS.Cell) => {
  const v = cell.value;
  if (typeof v === 'number') return cell.numFmt?.includes('%') ? `${(v * 100).toFixed(2)}%` : String(Math.round(v * 1000) / 1000);
  return text(cell) ?? '';
};
/** Every column visible and as wide as its header or its longest value (within reason). */
const fitWidths = (ws: ExcelJS.Worksheet, max = 32) => {
  for (let c = 1; c <= ws.columnCount; c++) {
    const col = ws.getColumn(c);
    col.hidden = false;
    let w = 0;
    col.eachCell({ includeEmpty: false }, (cell) => {
      w = Math.max(w, textWidth(shown(cell)));
    });
    const width = Math.min(Math.max(w + 2, 6), max);
    // exceljs leaves out columns exactly 9 wide (its default), and Sheets then uses its own default.
    col.width = width === 9 ? 9.1 : width;
  }
};

const fillCell = (cell: ExcelJS.Cell, fill: DomainFill) => {
  if (fill.status === '不追蹤') {
    cell.value = NOT_TRACKED;
    cell.font = { color: { argb: GREY } };
  } else if (fill.domain) {
    cell.value = { text: fill.domain, hyperlink: `https://${fill.domain}/` };
    cell.font = { color: { argb: BLUE }, underline: true };
  }
  const color = !fill.domain && fill.status !== '不追蹤' ? FILLS.todo : fill.status === '不確定' ? FILLS.unsure : fill.ai ? FILLS.ai : null;
  if (color) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  if (fill.note) cell.note = fill.note;
};

/**
 * Gene's latest month tab with its blank 網址 cells filled, formulas turned
 * into values, divisors moved out of the names into 台灣估算, every column
 * shown and sized to fit, plus the names only older tabs have. `source` is his workbook; `rows` and `fills`
 * say what each name-only name gets.
 */
export async function buildDomainSheet(source: ArrayBuffer, rows: DomainSheetRow[], fills: Map<string, DomainFill>) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(source);
  const months = wb.worksheets.filter((ws) => /^20\d{4}$/.test(ws.name)).sort((a, b) => b.name.localeCompare(a.name));
  const latest = months[0];
  if (!latest) throw new Error('no month tab');
  const col = columns(latest);
  if (!col.name || !col.url) throw new Error(`${latest.name} has no 網站名／網址 column`);
  for (const ws of [...wb.worksheets]) if (ws !== latest) wb.removeWorksheet(ws.id);
  const month = latest.name;
  latest.name = `${month} 網址`;
  flatten(latest);
  const divisors = col.taiwan ? splitDivisors(latest, col.name, col.taiwan) : 0;

  const fillFor = (r: DomainSheetRow): DomainFill => fills.get(r.name) ?? { domain: r.domain, status: r.domain ? '已對應' : '待填' };
  const byName = new Map(rows.map((r) => [r.name, r]));
  const done = new Set<string>();
  latest.eachRow((row, n) => {
    if (n === 1) return;
    const raw = text(row.getCell(col.name as number));
    const url = row.getCell(col.url as number);
    if (!raw || text(url) || url.hyperlink) return;
    const r = byName.get(siteName(raw));
    if (!r) return;
    fillCell(url, fillFor(r));
    done.add(r.name);
  });
  fitWidths(latest);
  // Keep 標籤, 名次, 網站名 and 網址 in view; the old split at the 15th column hid the figures on a laptop.
  latest.views = [{ state: 'frozen', xSplit: col.url, ySplit: 1, topLeftCell: `${latest.getColumn((col.url as number) + 1).letter}2` }];

  const older = wb.addWorksheet(OLDER_TAB, { views: [{ state: 'frozen', ySplit: 1, xSplit: 5 }] });
  older.columns = [
    { header: '', width: 13 },
    { header: '', width: 13 },
    { header: '最近出現', width: 9 },
    { header: '網站名', width: 22 },
    { header: '網址', width: 24 },
    { header: '流量', width: 8 },
  ];
  older.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER } };
  });
  const rest = rows
    .filter((r) => !done.has(r.name))
    .sort((x, y) => y.month.localeCompare(x.month) || x.name.localeCompare(y.name, 'zh-Hant'));
  for (const r of rest) {
    const row = older.addRow([r.a, r.b, r.month, r.name, null, r.visits]);
    fillCell(row.getCell(5), fillFor(r));
  }
  fitWidths(older);

  const help = wb.addWorksheet('說明');
  for (const r of HELP) help.addRow(r);
  help.getColumn(1).width = 12;
  help.getColumn(2).width = 100;
  help.getCell('A1').font = { bold: true, size: 14 };
  for (const [color, label] of [
    [FILLS.ai, '淡黃底'],
    [FILLS.unsure, '橘底'],
    [FILLS.todo, '紅底'],
  ]) {
    const cell = help.getColumn(1).values.indexOf(label);
    help.getCell(cell, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  }
  for (let i = 3; i <= HELP.length; i++) help.getCell(i, 1).font = { bold: true };
  wb.views = [{ x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];
  return { wb, month, filled: done.size, older: rest.length, divisors };
}

/**
 * Reads the sheet back: 網站名 → domain from 網址 on every tab that has both
 * columns, null where 網址 is「不追蹤」. Blank 網址 is skipped; one that is not a
 * domain is reported, not used.
 */
export async function readDomainSheet(buffer: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const domains = new Map<string, string | null>();
  const problems: string[] = [];
  for (const ws of wb.worksheets) {
    const col = columns(ws);
    if (!col.name || !col.url) continue;
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const raw = text(row.getCell(col.name as number));
      if (!raw) return;
      const name = siteName(raw);
      const cell = row.getCell(col.url as number);
      const written = text(cell);
      if (written === NOT_TRACKED) return void domains.set(name, null);
      if (!written && !cell.hyperlink) return;
      const domain = trafficDomain(written ?? '') || trafficDomain(cell.hyperlink ?? '');
      if (!domain) return void problems.push(`${ws.name} 第 ${n} 列 ${name}：網址「${written}」看不懂`);
      if (domains.has(name) && domains.get(name) !== domain)
        problems.push(`${ws.name} 第 ${n} 列 ${name}：和前面的列不同（${domains.get(name)} / ${domain}），用這列`);
      domains.set(name, domain);
    });
  }
  return { domains, problems };
}
