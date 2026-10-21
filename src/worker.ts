import { createPool } from './db.ts';
import { runConfig, runOnce } from './scheduler.ts';

// Runs the Similarweb batch once an hour at TRAFFIC_RUN_MINUTE (default :35,
// where tag's job ran). Config is reread every run, so a budget change in the
// environment takes effect after a restart without a code change.

const pool = createPool();
const minute = Number(process.env.TRAFFIC_RUN_MINUTE ?? 35);
let timer: NodeJS.Timeout | undefined;
let running: Promise<unknown> | null = null;

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
async function tick() {
  running = runOnce(pool, { config: runConfig() })
    .then((result) => console.log(JSON.stringify({ at: new Date().toISOString(), result })))
    .catch((error) => console.error(JSON.stringify({ at: new Date().toISOString(), error: String(error?.stack ?? error) })))
    .finally(() => {
      running = null;
    });
  await running;
  schedule();
}

const stop = async () => {
  clearTimeout(timer);
  await running;
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
console.log(JSON.stringify({ worker: 'traffic-observe', budget: runConfig().budget, next: nextRun().toISOString() }));
schedule();
