import { createPool } from './db.ts';
import { experimentalRequest } from './egress-experiment.ts';
import { fetchPolicy } from './fetch-policy.ts';
import { runRadar } from './radar.ts';
import { runConfig, runOnce } from './scheduler.ts';
import { browserFetcher } from './tech-browser.ts';
import { runTech, techConfig } from './tech-scan.ts';
import { nextPacedRun } from './worker-timing.ts';

// Similarweb sends are paced only while eligible; long waits keep an hourly database-only heartbeat.
// Homepage scans have their own persisted daily interval. Radar retains its daily schedule.

const pool = createPool();
const similarwebRequest = experimentalRequest(pool);
const minute = runConfig().runMinute;
const radarHour = Number(process.env.TRAFFIC_RADAR_HOUR ?? 3);
const taipeiHour = (now: Date) => (now.getUTCHours() + 8) % 24;
let timer: NodeJS.Timeout | undefined;
let running: Promise<unknown> | null = null;
let pacedTimer: NodeJS.Timeout | undefined;
let pacedRunning: Promise<unknown> | null = null;
let pacedGeneration = 0;
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
const log = <T>(job: string, work: Promise<T>) =>
  work
    .then((result) => {
      const sent = Number((result as { sent?: number }).sent ?? 0);
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          job,
          activity: sent ? 'upstream-fetch' : 'schedule-check',
          destination: !sent
            ? 'local-database'
            : job === 'similarweb'
              ? 'data.similarweb.com'
              : job === 'radar'
                ? 'api.cloudflare.com'
                : 'website-homepages',
          usesSimilarwebQuota: job === 'similarweb' && sent > 0,
          result,
        }),
      );
      return result;
    })
    .catch((error) => console.error(JSON.stringify({ at: new Date().toISOString(), job, error: String(error?.stack ?? error) })));

const schedulePaced = async (idle = false) => {
  const generation = ++pacedGeneration;
  clearTimeout(pacedTimer);
  if (stopping || idle) return;
  try {
    const config = runConfig();
    if (!config.minIntervalSeconds) return;
    const next = nextPacedRun(config, await fetchPolicy(pool, config));
    if (!next || stopping || generation !== pacedGeneration) return;
    pacedTimer = setTimeout(
      async () => {
        pacedRunning = similarwebRun();
        await pacedRunning;
        pacedRunning = null;
      },
      Math.max(1, next.getTime() - Date.now()),
    );
  } catch (error) {
    console.error(JSON.stringify({ job: 'similarweb-schedule', error: String(error) }));
  }
};
const similarwebRun = async () => {
  const result = await log('similarweb', runOnce(pool, { config: runConfig(), request: similarwebRequest }));
  await schedulePaced(!!result && 'due' in result && result.due === 0);
};
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
  running = similarwebRun()
    .then(() => (radar ? log('radar', runRadar(pool)) : undefined))
    .then(() => (stopping ? undefined : log('website-technology', techRun())))
    .finally(() => {
      running = null;
    });
  await running;
  schedule();
}

const stop = async () => {
  stopping = true;
  clearTimeout(timer);
  clearTimeout(pacedTimer);
  pacedGeneration++;
  await running;
  await pacedRunning;
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
console.log(
  JSON.stringify({ worker: 'traffic-observe', budget: runConfig().budget, techBudget: techConfig().budget, next: nextRun().toISOString() }),
);
schedule();
schedulePaced();
