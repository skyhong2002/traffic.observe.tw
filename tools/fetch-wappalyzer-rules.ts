// The pinned Wappalyzer rule data (GPL-3.0, enthec/webappanalyzer), moved with blog's /tech/. Never committed:
//   node tools/fetch-wappalyzer-rules.ts [--dir <dir>]           download the files data/wappalyzer-pin.json names, verify their hashes
//   node tools/fetch-wappalyzer-rules.ts --check [--dir <dir>]   load them; list mapped products the data no longer has
//   node tools/fetch-wappalyzer-rules.ts --update [--dir <dir>]  fetch the newest commit and print a new pin to review
// <dir> defaults to TRAFFIC_WAPPALYZER_RULES_DIR or ~/.local/share/traffic-observe/wappalyzer; files go in <dir>/<commit>/.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WAPPALYZER_NAMES } from '../src/tech.ts';
import { loadRules, readPin, rulesDirectory, type WappalyzerPin } from '../src/wappalyzer.ts';

const REPOSITORY = 'enthec/webappanalyzer';
const FILES = [...['_', ...'abcdefghijklmnopqrstuvwxyz'].map((letter) => `technologies/${letter}.json`), 'categories.json'];
const at = process.argv.indexOf('--dir');
const directory = at >= 0 ? process.argv[at + 1] : rulesDirectory();
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const headers = { 'user-agent': 'traffic-observe-rules-fetch' };

async function download(commit: string, file: string) {
  const response = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/src/${file}`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw Error(`${file}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
function store(commit: string, file: string, data: Buffer) {
  const path = join(directory, commit, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.part`, data);
  renameSync(`${path}.part`, path);
}

if (process.argv.includes('--check')) {
  const rules = loadRules(WAPPALYZER_NAMES, directory);
  console.log(JSON.stringify({ version: rules.version, products: rules.products.size, missing: rules.missing }));
  process.exit(rules.missing.length ? 1 : 0);
} else if (process.argv.includes('--update')) {
  const latest = (await (await fetch(`https://api.github.com/repos/${REPOSITORY}/commits/main`, { headers })).json()) as { sha?: string };
  if (!latest.sha || !/^[0-9a-f]{40}$/.test(latest.sha)) throw Error('could not read the latest commit');
  const files: Record<string, string> = {};
  for (const file of FILES) {
    const data = await download(latest.sha, file);
    store(latest.sha, file, data);
    files[file] = sha256(data);
  }
  const pin: WappalyzerPin = {
    repository: REPOSITORY,
    commit: latest.sha,
    license: 'GPL-3.0',
    pinnedAt: new Date().toISOString().slice(0, 10),
    files,
  };
  console.log(JSON.stringify(pin, null, 2));
  console.error(`downloaded to ${join(directory, latest.sha)}; run --check and the tests, then replace data/wappalyzer-pin.json`);
} else {
  const pin = readPin();
  for (const [file, expected] of Object.entries(pin.files)) {
    const data = await download(pin.commit, file);
    if (sha256(data) !== expected) throw Error(`${file}: hash differs from the pin; refusing to install`);
    store(pin.commit, file, data);
  }
  console.log(JSON.stringify({ installed: join(directory, pin.commit), files: Object.keys(pin.files).length }));
}
