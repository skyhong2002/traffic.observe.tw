import { readdir, readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

export type Pool = mysql.Pool;

export function parseDbUrl(url: string | undefined) {
  if (!url) throw Error('TRAFFIC_DB_URL is required (mysql://user:pass@host:port/db)');
  const u = new URL(url);
  if (u.protocol !== 'mysql:') throw Error('TRAFFIC_DB_URL must use mysql://');
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  };
}

/** DATETIME columns hold UTC; timezone 'Z' makes mysql2 read and write them as such. */
export function createPool(url = process.env.TRAFFIC_DB_URL, { size = 4, multipleStatements = false } = {}) {
  return mysql.createPool({
    ...parseDbUrl(url),
    charset: 'utf8mb4',
    connectionLimit: size,
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    connectTimeout: 5000,
    multipleStatements,
  });
}

export async function rows<T>(pool: Pick<Pool, 'query'>, sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await pool.query(sql, params);
  return result as T[];
}

/** Applies src/migrations/*.sql not yet recorded in schema_migrations, in name order. */
export async function migrate(pool: Pool, dir = new URL('./migrations/', import.meta.url)) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(128) PRIMARY KEY, applied_at DATETIME NOT NULL)');
  const done = new Set((await rows<{ name: string }>(pool, 'SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    await pool.query(await readFile(new URL(name, dir), 'utf8'));
    await pool.query('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [name, new Date()]);
    applied.push(name);
  }
  return applied;
}

export const chunk = <T>(list: T[], size = 500) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
