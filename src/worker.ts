import { createPool } from './db.ts';
import { runRadar } from './radar.ts';
import { runConfig, runOnce } from './scheduler.ts';
import { browserFetcher } from './tech-browser.ts';
import { runTech, techConfig } from './tech-scan.ts';

// Runs the Similarweb batch once an hour at TRAFFIC_RUN_MINUTE (default :35,
// where tag's job ran), and the Cloudflare Radar batch once a day after the
// run in Taipei hour TRAFFIC_RADAR_HOUR (default 3, as tag did), then up to TRAFFIC_TECH_BUDGET homepages for /tech/
// (tech-scan.ts; stops early when the worker is asked to stop). Config is reread every run, so a budget change in the
// environment takes effect after a restart without a code change.

const pool = createPool();
const minute = runConfig().runMinute;
const radarHour = Number(process.env.TRAFFIC_RADAR_HOUR ?? 3);
const taipeiHour = (now: Date) => (now.getUTCHours() + 8) % 24;
let timer: NodeJS.Timeout | undefined;
let running: Promise<unknown> | null = null;
let stopping = false;

const nextRun = (now = new Date()) => {
  const at = new Date(now);
  at.setUTCSeconds(0, 0);
  at.setUTCMinutes(minute);
  if (at <= now) at.setUTCHours(at.getUTCHours() + 1);
  return at;
};
const schedule = () => {
  const at = nextRun();
  timer = setTimeout(tick, at.getTime() - Date.now());
};
const log = (job: string, work: Promise<unknown>) =>
  work
    .then((result) => console.log(JSON.stringify({ at: new Date().toISOString(), job, result })))
    .catch((error) => console.error(JSON.stringify({ at: new Date().toISOString(), job, error: String(error?.stack ?? error) })));
/** Homepages for /tech/; a WAF page gets a second try in a browser started for this run only. */
const techRun = async () => {
  const browser = browserFetcher();
  try {
    return await runTech(pool, { stopping: () => stopping, fallback: browser.fetchPage });
  } finally {
    await browser.close();
  }
};
async function tick() {
  const radar = taipeiHour(new Date()) === radarHour;
  running = log('similarweb', runOnce(pool, { config: runConfig() }))
    .then(() => (radar ? log('radar', runRadar(pool)) : undefined))
    .then(() => (stopping ? undefined : log('tech', techRun())))
    .finally(() => {
      running = null;
    });
  await running;
  schedule();
}

const stop = async () => {
  stopping = true;
  clearTimeout(timer);
  await running;
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
console.log(
  JSON.stringify({ worker: 'traffic-observe', budget: runConfig().budget, techBudget: techConfig().budget, next: nextRun().toISOString() }),
);
schedule();
