import ExcelJS from 'exceljs';
import type { SheetRow } from './sheet.ts';
import { SHEET_DOMAINS } from './sheet-domains.ts';
import { trafficDomain } from './similarweb.ts';

// The「網域對照表」: a Google Sheet next to GeneHong's, one row per site name
// his month tabs write without a URL, saying which domain it is tracked under.
// It takes over from SHEET_DOMAINS so names can be matched without a release.
// Only names and domains live here; tags stay in traffic (site_metadata).

export const DOMAIN_SHEET_ID = process.env.TRAFFIC_DOMAIN_SHEET_ID ?? '';
export const domainSheetUrl = (id = DOMAIN_SHEET_ID) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;

export const DOMAIN_TAB = '網域';
export const STATUSES = ['已對應', '待填', '不確定', '不追蹤'] as const;
const COLUMNS = [
  { header: '網站名稱', key: 'name', width: 28 },
  { header: '網域', key: 'domain', width: 26 },
  { header: '狀態', key: 'status', width: 10 },
  { header: '備註', key: 'note', width: 30 },
  { header: '標籤 A（參考）', key: 'a', width: 14 },
  { header: '標籤 B（參考）', key: 'b', width: 22 },
  { header: '最近出現（參考）', key: 'month', width: 14 },
  { header: '最近流量（參考，百萬）', key: 'visits', width: 18 },
  { header: '網域來源（參考）', key: 'source', width: 18 },
] as const;

const HELP = [
  ['網域對照表怎麼填'],
  [''],
  ['用途', '「Similar Web 新聞」表上只寫名稱、沒有網址的網站，在這裡寫它的網域，traffic.observe.tw 才能追蹤流量、套上標籤。'],
  ['網站名稱', '和月份分頁的「網站名」一字不差（名稱結尾的 /5 這類除數不用寫）。同一個網站有幾種寫法，就各佔一列、填同一個網域。'],
  ['網域', '只寫網域，例如 8891.com.tw、news.google.com；不用 https://、www. 和路徑。子網域可以（tw.news.yahoo.com）。'],
  ['狀態', '已對應：網域確定。待填：還不知道。不確定：寫了猜測的網域但沒把握，系統仍會採用，請在備註說明。不追蹤：不是網站或不要追蹤，系統不會對應任何網域。'],
  ['參考欄', '「（參考）」欄是產生這張表時從月份分頁帶入的資料，改了不會有作用；標籤請在 traffic.observe.tw 的網站頁修改。'],
  ['新網站', '月份分頁出現新的「只有名稱」網站時，在最下面加一列即可。'],
  ['網址已寫在月份分頁的網站', '不用列在這裡，系統直接用月份分頁的網址。'],
];

export interface DomainSheetRow {
  name: string;
  domain: string | null;
  status: (typeof STATUSES)[number];
  a: string | null;
  b: string | null;
  month: string;
  visits: number | null;
  source: string;
}

/**
 * One row per name that some month tab writes without a domain of its own,
 * prefilled with the domain readWorkbook would give it today. `tabs` are the
 * rows as readMonthTabs returns them (before any matching).
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
  const out: DomainSheetRow[] = [];
  for (const name of nameOnly) {
    const r = latest.get(name) as SheetRow;
    const hand = SHEET_DOMAINS[name];
    const other = ownDomain.get(name);
    const domain = hand ?? other ?? null;
    out.push({
      name,
      domain,
      status: domain ? '已對應' : '待填',
      a: r.group,
      b: r.topics,
      month: r.month,
      visits: r.visits,
      source: hand ? '人工對照' : other ? '同名其他月份' : '',
    });
  }
  // Still to fill first, the most recently seen on top.
  return out.sort(
    (x, y) =>
      Number(!!x.domain) - Number(!!y.domain) || y.month.localeCompare(x.month) || x.name.localeCompare(y.name, 'zh-Hant'),
  );
}

export function buildDomainSheet(rows: DomainSheetRow[]) {
  const wb = new ExcelJS.Workbook();
  const help = wb.addWorksheet('說明');
  for (const r of HELP) help.addRow(r);
  help.getColumn(1).width = 22;
  help.getColumn(2).width = 100;
  help.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  help.getCell('A1').font = { bold: true, size: 14 };
  for (let i = 3; i <= HELP.length; i++) help.getCell(`A${i}`).font = { bold: true };

  const ws = wb.addWorksheet(DOMAIN_TAB, { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ ...c }));
  for (const r of rows) ws.addRow({ ...r, note: null });
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };
  const ref = { argb: 'FF808080' };
  for (let col = 5; col <= COLUMNS.length; col++) ws.getColumn(col).font = { color: ref };
  ws.getRow(1).font = { bold: true };
  // Leave room below for new names.
  for (let row = 2; row <= rows.length + 500; row++)
    ws.getCell(row, 3).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${STATUSES.join(',')}"`],
      showErrorMessage: true,
      errorTitle: '狀態',
      error: `請選 ${STATUSES.join('、')}`,
    };
  return wb;
}

/**
 * Reads the domain sheet back: name → domain, or null for「不追蹤」. Rows with
 * no domain are skipped; domains that are not valid are reported, not used.
 */
export async function readDomainSheet(buffer: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(DOMAIN_TAB);
  if (!ws) throw new Error(`no ${DOMAIN_TAB} tab`);
  const col = new Map<string, number>();
  ws.getRow(1).eachCell((cell, n) => col.set(String(cell.text).trim(), n));
  const [nameCol, domainCol, statusCol] = ['網站名稱', '網域', '狀態'].map((h) => {
    const n = col.get(h);
    if (!n) throw new Error(`no ${h} column`);
    return n;
  });
  const domains = new Map<string, string | null>();
  const problems: string[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const name = String(row.getCell(nameCol).text).trim();
    if (!name) return;
    const status = String(row.getCell(statusCol).text).trim();
    const raw = String(row.getCell(domainCol).text).trim();
    if (status === '不追蹤') return void domains.set(name, null);
    if (!raw) return;
    const domain = trafficDomain(raw);
    if (!domain) return void problems.push(`第 ${n} 列 ${name}：網域「${raw}」看不懂`);
    if (domains.has(name) && domains.get(name) !== domain)
      problems.push(`第 ${n} 列 ${name}：和前面的列不同（${domains.get(name)} / ${domain}），用這列`);
    domains.set(name, domain);
  });
  return { domains, problems };
}
