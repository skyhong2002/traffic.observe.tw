// Writes the「網址對照表」xlsx from GeneHong's sheet: his latest month tab with
// the blank 網址 cells filled where the name is matched today (src/sheet-domains.ts
// or the same name in another month), plus the names only older tabs have.
// Upload it to Google Drive as a Google Sheet once; after that the sheet is the source.
//   node tools/export-domain-sheet.ts [--input file.xlsx] --out domains.xlsx
import { readFile } from 'node:fs/promises';
import { buildDomainSheet, domainSheetRows } from '../src/domain-sheet.ts';
import { readMonthTabs, SHEET_URL } from '../src/sheet.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const input = arg('--input');
const out = arg('--out');
if (!out) throw new Error('--out file.xlsx is required');
const buffer = input
  ? new Uint8Array(await readFile(input)).buffer
  : await (await fetch(SHEET_URL, { signal: AbortSignal.timeout(60_000) })).arrayBuffer();
const rows = domainSheetRows(await readMonthTabs(buffer));
const sheet = await buildDomainSheet(buffer, rows, new Map());
await sheet.wb.xlsx.writeFile(out);
const matched = rows.filter((r) => r.domain).length;
console.log(
  `${rows.length} name-only names (${matched} matched): ${sheet.filled} in ${sheet.month}, ${sheet.older} in older tabs → ${out}`,
);
