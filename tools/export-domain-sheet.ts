// Writes the「網域對照表」xlsx from GeneHong's sheet: every name its month tabs
// write without a URL, prefilled with the domain it is matched to today. Upload
// it to Google Drive as a Google Sheet once; after that the sheet is the source.
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
await buildDomainSheet(rows).xlsx.writeFile(out);
const filled = rows.filter((r) => r.domain).length;
console.log(`${rows.length} names: ${filled} matched, ${rows.length - filled} to fill → ${out}`);
