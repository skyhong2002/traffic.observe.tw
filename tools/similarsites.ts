// Fetches similarsites.com's similar sites for tracked domains, slowly, and prints the untracked ones named most:
//   node --env-file=.env tools/similarsites.ts [--limit N] [--delay-ms MS] [--max-age-days D]   fetch what is due
//   node --env-file=.env tools/similarsites.ts --candidates [--min-votes N] [--top N]            only print candidates
// Stops at the first 403/429 so a refusal is never hammered.
import { createPool } from '../src/db.ts';
import { candidates, dueDomains, requestSimilarSites, saveSimilarSites } from '../src/similarsites.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  const n = i >= 0 ? Number(args[i + 1]) : fallback;
  if (!Number.isFinite(n) || n < 0) throw Error(`--${name} needs a number`);
  return n;
};

const pool = createPool(undefined, { size: 2 });
try {
  if (!flag('candidates')) {
    const delay = value('delay-ms', 2500);
    const olderThan = new Date(Date.now() - value('max-age-days', 30) * 86_400_000);
    const due = await dueDomains(pool, olderThan, value('limit', 100_000));
    console.log(`${due.length} domains due`);
    let done = 0;
    for (const domain of due) {
      const result = await requestSimilarSites(domain);
      if (result.status === 'failed' && (result.httpStatus === 403 || result.httpStatus === 429)) {
        console.log(`refused with ${result.httpStatus} at ${domain}; stopping after ${done}`);
        break;
      }
      await saveSimilarSites(pool, domain, result);
      done++;
      if (done % 25 === 0 || result.status !== 'ok') console.log(`${done}/${due.length} ${domain} ${result.status}`);
      await new Promise((r) => setTimeout(r, delay));
    }
    console.log(`fetched ${done}`);
  }
  const top = value('top', 50);
  for (const c of await candidates(pool, { minVotes: value('min-votes', 2), limit: top }))
    console.log(
      [
        c.domain,
        `${c.votes}站`,
        `最高${c.bestGrade.toFixed(2)}`,
        c.category ?? '-',
        c.totalVisits === null ? '-' : `${(c.totalVisits / 1e6).toFixed(1)}m`,
        c.listedBy.join(' '),
      ].join('\t'),
    );
} finally {
  await pool.end();
}
