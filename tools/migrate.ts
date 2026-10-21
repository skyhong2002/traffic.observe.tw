// Applies pending src/migrations/*.sql: node --env-file=.env tools/migrate.ts
import { createPool, migrate } from '../src/db.ts';

const pool = createPool(undefined, { size: 1, multipleStatements: true });
try {
  console.log('applied', await migrate(pool));
} finally {
  await pool.end();
}
