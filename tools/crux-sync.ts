// Downloads every CrUX month not stored yet (the first run back-fills from 202102) and matches
// watched domains, without the worker's daily time limit:
//   node --env-file=.env tools/crux-sync.ts
import { runCrux } from '../src/crux.ts';
import { createPool } from '../src/db.ts';

const pool = createPool(undefined, { size: 2 });
try {
  console.log(JSON.stringify(await runCrux(pool, { deadlineMs: 6 * 3600_000 }), null, 2));
} finally {
  await pool.end();
}
