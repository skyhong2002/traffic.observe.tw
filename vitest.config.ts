import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// TRAFFIC_TEST_DB_URL comes from .env when present; without it the database tests are skipped.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: { include: ['test/**/*.spec.ts'], fileParallelism: false },
});
