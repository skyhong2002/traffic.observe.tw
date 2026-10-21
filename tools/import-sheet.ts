// Copies GeneHong's sheet into sheet_rows (every YYYYMM tab) and watches the
// domains of its two latest tabs as requester `sheet`, refreshed monthly.
//   node --env-file=.env tools/import-sheet.ts [--input file.xlsx] [--dry-run]
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.ts';
import { setWatchList } from '../src/requests.ts';
import { readWorkbook, SHEET_URL, saveSheet } from '../src/sheet.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const input = arg('--input');
const buffer = input
  ? new Uint8Array(await readFile(input)).buffer
  : await (await fetch(SHEET_URL, { signal: AbortSignal.timeout(60_000) })).arrayBuffer();
const list = await readWorkbook(buffer);
const months = [...new Set(list.map((r) => r.month))].sort();
const latest = months.slice(-2);
const domains = [...new Set(list.filter((r) => latest.includes(r.month) && r.domain).map((r) => r.domain as string))];
console.log(`${list.length} rows, months ${months[0]}–${months.at(-1)}; ${domains.length} domains in ${latest.join(', ')}`);
if (process.argv.includes('--dry-run')) process.exit(0);
const pool = createPool();
try {
  console.log('saved', await saveSheet(pool, list));
  console.log('watch', await setWatchList(pool, 'sheet', domains, 30));
} finally {
  await pool.end();
}
