// Copies GeneHong's sheet into sheet_rows (every YYYYMM tab) and watches the
// domains of its two latest tabs as requester `sheet`, refreshed monthly.
// Name-only rows take their domain from the「網域對照表」(TRAFFIC_DOMAIN_SHEET_ID).
//   node --env-file=.env tools/import-sheet.ts [--input file.xlsx] [--domains file.xlsx] [--dry-run]
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.ts';
import { DOMAIN_SHEET_ID, domainSheetUrl, readDomainSheet } from '../src/domain-sheet.ts';
import { setWatchList } from '../src/requests.ts';
import { readWorkbook, SHEET_URL, saveSheet } from '../src/sheet.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const load = async (file: string | undefined, url: string) =>
  file ? new Uint8Array(await readFile(file)).buffer : await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer();

const domainFile = arg('--domains');
let domains = new Map<string, string | null>();
if (domainFile || DOMAIN_SHEET_ID) {
  const sheet = await readDomainSheet(await load(domainFile, domainSheetUrl()));
  domains = sheet.domains;
  console.log(`domain sheet: ${domains.size} names`);
  for (const p of sheet.problems) console.log(`  ${p}`);
} else console.log('domain sheet: not set (TRAFFIC_DOMAIN_SHEET_ID), using src/sheet-domains.ts only');

const list = await readWorkbook(await load(arg('--input'), SHEET_URL), domains);
const months = [...new Set(list.map((r) => r.month))].sort();
const latest = months.slice(-2);
const domainsInLatest = [...new Set(list.filter((r) => latest.includes(r.month) && r.domain).map((r) => r.domain as string))];
const unmatched = [...new Set(list.filter((r) => latest.includes(r.month) && !r.domain && !domains.has(r.name)).map((r) => r.name))];
console.log(`${list.length} rows, months ${months[0]}–${months.at(-1)}; ${domainsInLatest.length} domains in ${latest.join(', ')}`);
console.log(`${unmatched.length} names in ${latest.join(', ')} still without a domain (不追蹤 not counted)`);
if (process.argv.includes('--dry-run')) process.exit(0);
const pool = createPool();
try {
  console.log('saved', await saveSheet(pool, list));
  console.log('watch', await setWatchList(pool, 'sheet', domainsInLatest));
} finally {
  await pool.end();
}
