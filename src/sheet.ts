import ExcelJS from 'exceljs';
import { chunk, type Pool } from './db.ts';
import { SHEET_DOMAINS } from './sheet-domains.ts';
import { trafficDomain } from './similarweb.ts';

// Reads GeneHong's「Similar Web 新聞」sheet (one tab per YYYYMM) as it is: the
// sheet stays the read-only source, this keeps a copy so its history can sit
// next to what the worker fetches. Tabs changed layout over time (202412 has
// 總流量, 2025 tabs SimilarWeb/Ahrefs, 2026 tabs 流量/搜尋S/AI), so columns are
// found by header name, never by position. Cached formula results are read,
// formulas never run.

export const SHEET_ID = '1B5RsSVZSrjKSUFDFZ-2VVlU3-tpTN49J1YzLGOohalM';
export const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;

export interface SheetRow {
  month: string;
  rowNo: number;
  group: string | null;
  topics: string | null;
  /** The name with any manual divisor (「threads.com /5」) removed. */
  name: string;
  url: string | null;
  domain: string | null;
  /** Millions of visits as the sheet has them. */
  visits: number | null;
  /** Hand-adjusted (a 「/5」 divisor or a formula in the visits cell): not a Similarweb figure. */
  adjusted: boolean;
  searchShare: number | null;
  aiShare: number | null;
  taiwanShare: number | null;
  /** Every non-empty cell, keyed by column letter and header. */
  raw: Record<string, string | number>;
}

type Cell = ExcelJS.Cell;
export const text = (cell: Cell): string | null => {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const o = v as { text?: unknown; richText?: Array<{ text: string }>; result?: unknown };
    if (typeof o.text === 'string') return o.text.trim() || null;
    // A hyperlink whose label is rich text (「cosmopolitan/10」 with the divisor in red).
    if (typeof o.text === 'object' && o.text !== null) return text({ value: o.text } as Cell);
    if (Array.isArray(o.richText))
      return (
        o.richText
          .map((r) => r.text)
          .join('')
          .trim() || null
      );
    if (typeof o.result === 'string' || typeof o.result === 'number') return String(o.result);
  }
  return null;
};
const number = (cell: Cell): number | null => {
  const v = cell.value as unknown;
  const n = typeof v === 'object' && v !== null ? (v as { result?: unknown }).result : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const formula = (cell: Cell) => {
  const v = cell.value as { formula?: string } | null;
  return typeof v === 'object' && v !== null && typeof v.formula === 'string' ? v.formula : null;
};
const share = (cell: Cell | null) => {
  const n = cell ? number(cell) : null;
  return n !== null && n >= 0 && n <= 1 ? n : null;
};
const DIVISOR = /\s*\/\s*\d+(?:\.\d+)?\s*$/;
/** A name cell as readMonthTab keys it: any manual divisor (「threads.com /5」) removed. */
export const siteName = (raw: string) => raw.replace(DIVISOR, '').slice(0, 128);
/** The divisor a name ends with (「threads.com /5」 → 5): Gene's guess that 1/5 of the visits are Taiwan's. */
export const divisorOf = (raw: string) => {
  const n = Number(raw.match(DIVISOR)?.[0].replace('/', '').trim());
  return n > 0 ? n : null;
};
/** A domain written into the name: 「元大理財 yuantafunds.com」, 「好想去喔 (lookit.tw)」, 「電視超人isuper.tv」. */
const nameDomain = (name: string) => {
  const found = name.match(/(?<![a-z0-9.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?![a-z0-9-])/i);
  return found ? trafficDomain(found[0]) : null;
};

/** The rows of one month tab. */
export function readMonthTab(ws: ExcelJS.Worksheet, month: string): SheetRow[] {
  const headers = new Map<number, string>();
  ws.getRow(1).eachCell((cell, col) => {
    const t = text(cell);
    if (t) headers.set(col, t.replace(/\s+/g, ' '));
  });
  const find = (names: string[], after = 0) => [...headers].find(([col, h]) => col > after && names.includes(h))?.[0] ?? null;
  const nameCol = find(['網站名', '媒體名']);
  if (!nameCol) return [];
  const urlCol = find(['網址']);
  // 202510–202512 label the visits column 網站 or with a month; there it sits right after the name.
  const next = headers.get(nameCol + 1) ?? '';
  const visitsCol = find(['流量', 'SimilarWeb', '總流量']) ?? (next === '網站' || /^\d{1,2} ?月$/.test(next) ? nameCol + 1 : null);
  const direct = find(['直接', 'Direct']);
  const searchCol = direct ? find(['搜尋', 'Search'], direct) : null;
  const aiCol = direct ? find(['GenAI', 'AI', 'AI 占比'], direct) : null;
  const taiwanCol = find(['台灣']);
  const out: SheetRow[] = [];
  ws.eachRow((row, rowNo) => {
    if (rowNo === 1) return;
    const nameCell = row.getCell(nameCol);
    const rawName = text(nameCell);
    if (!rawName) return;
    const urlCell = urlCol ? row.getCell(urlCol) : null;
    const url = urlCell?.hyperlink || text(urlCell ?? nameCell) || nameCell.hyperlink || null;
    const domain =
      (urlCell && (trafficDomain(urlCell.hyperlink ?? '') || trafficDomain(text(urlCell) ?? ''))) ||
      (nameCell.hyperlink ? trafficDomain(nameCell.hyperlink) : null) ||
      nameDomain(rawName);
    const visitsCell = visitsCol ? row.getCell(visitsCol) : null;
    const visits = visitsCell ? number(visitsCell) : null;
    const first = text(row.getCell(1));
    const second = nameCol > 2 ? text(row.getCell(2)) : null;
    // Rows without a figure still carry the site's labels; keep them for the name → domain matching below.
    if (visits === null && !domain && !first && !second) return;
    const f = visitsCell ? formula(visitsCell) : null;
    const raw: Record<string, string | number> = {};
    row.eachCell((cell, col) => {
      const value = number(cell) ?? text(cell);
      if (value !== null) raw[`${ws.getColumn(col).letter}${headers.has(col) ? ` ${headers.get(col)}` : ''}`] = value;
    });
    out.push({
      month,
      rowNo,
      group: first && first !== '類型' ? first.slice(0, 32) : null,
      topics: second?.slice(0, 128) ?? null,
      name: siteName(rawName),
      url: url?.slice(0, 512) ?? null,
      domain,
      visits,
      adjusted: DIVISOR.test(rawName) || (!!f && /[*/]/.test(f)),
      searchShare: searchCol ? share(row.getCell(searchCol)) : null,
      aiShare: aiCol ? share(row.getCell(aiCol)) : null,
      taiwanShare: taiwanCol ? share(row.getCell(taiwanCol)) : null,
      raw,
    });
  });
  return out;
}

/** Every month tab as written: domains only from the row's own URL, link or name. */
export async function readMonthTabs(buffer: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets.filter((ws) => /^20\d{4}$/.test(ws.name)).flatMap((ws) => readMonthTab(ws, ws.name));
}

/**
 * The rows with name-only ones matched to a domain: first the domain sheet
 * (`domains`, where null means「不追蹤」), then SHEET_DOMAINS, then the domain
 * the latest row of the same name had.
 */
export async function readWorkbook(buffer: ArrayBuffer, domains = new Map<string, string | null>()) {
  const rows = await readMonthTabs(buffer);
  for (const r of rows) r.domain ??= domains.has(r.name) ? (domains.get(r.name) ?? null) : (SHEET_DOMAINS[r.name] ?? null);
  // Older tabs mostly give names only: borrow the domain the latest row of the same name had.
  const byName = new Map<string, string>();
  for (const r of [...rows].sort((a, b) => a.month.localeCompare(b.month))) if (r.domain) byName.set(r.name, r.domain);
  for (const r of rows) if (domains.get(r.name) !== null) r.domain ??= byName.get(r.name) ?? null;
  return rows;
}

/** Replaces the imported months with these rows. */
export async function saveSheet(pool: Pool, list: SheetRow[], now = new Date()) {
  const months = [...new Set(list.map((r) => r.month))];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (months.length) await conn.query('DELETE FROM sheet_rows WHERE month IN (?)', [months]);
    for (const part of chunk(list))
      await conn.query(
        `INSERT INTO sheet_rows (month, row_no, group_label, topics, name, url, domain, visits, adjusted,
           search_share, ai_share, taiwan_share, raw, imported_at) VALUES ?`,
        [
          part.map((r) => [
            r.month,
            r.rowNo,
            r.group,
            r.topics,
            r.name,
            r.url,
            r.domain,
            r.visits,
            r.adjusted ? 1 : 0,
            r.searchShare,
            r.aiShare,
            r.taiwanShare,
            JSON.stringify(r.raw),
            now,
          ]),
        ],
      );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return { months: months.length, rows: list.length };
}
