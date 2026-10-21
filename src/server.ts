import { buildApp } from './app.ts';
import { createPool } from './db.ts';

const pool = createPool();
const app = buildApp(pool);
const close = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
await app.listen({ host: process.env.TRAFFIC_HOST || '127.0.0.1', port: Number(process.env.TRAFFIC_PORT || 18150) });
