#!/usr/bin/env node
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type FetchJob, fetchContributorJob } from './contributor-fetch.ts';

interface Result {
  sourceVersion: string;
  reply?: Awaited<ReturnType<typeof fetchContributorJob>>;
  error?: 'fetch_failed';
}
const atomic = async (file: string, value: unknown) => {
  await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
};

export async function runContributorAgent() {
  const base = new URL(process.env.CONTRIBUTOR_URL ?? '');
  if (
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(base.hostname)))
  )
    throw Error('CONTRIBUTOR_URL must be an HTTPS origin');
  const state = process.env.CONTRIBUTOR_STATE ?? '/state';
  const version = process.env.CONTRIBUTOR_VERSION ?? 'development';
  await mkdir(state, { recursive: true, mode: 0o700 });
  let stopping = false;
  let lastContactAt: string | null = null;
  let lastError: string | null = null;
  let completed = 0;
  const health = createServer((request, response) => {
    const healthy = !!lastContactAt && Date.now() - Date.parse(lastContactAt) < 120_000;
    response.writeHead(request.url !== '/health' ? 404 : healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ healthy, lastContactAt, lastError, completed, sourceVersion: version }));
  });
  health.listen(18151, '127.0.0.1');
  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const api = async (path: string, body: unknown) => {
    const token = process.env.TRAFFIC_CONTRIBUTOR_TOKEN_FILE
      ? (await readFile(process.env.TRAFFIC_CONTRIBUTOR_TOKEN_FILE, 'utf8')).trim()
      : process.env.TRAFFIC_CONTRIBUTOR_TOKEN;
    if (!token) throw Error('missing_node_key');
    const response = await fetch(new URL(path, base), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw Error(`main_HTTP_${response.status}`);
    lastContactAt = new Date().toISOString();
    return response.json();
  };
  const finish = async (job: FetchJob) => {
    let result: Result;
    try {
      result = { sourceVersion: version, reply: await fetchContributorJob(job, join(state, 'responses')) };
    } catch {
      result = { sourceVersion: version, error: 'fetch_failed' };
    }
    await atomic(join(state, `${job.requestId}.outbox.json`), result);
    await unlink(join(state, `${job.requestId}.job.json`));
  };
  try {
    while (!stopping) {
      try {
        // Recover a claimed job or an unacknowledged result before accepting new work.
        for (const name of (await readdir(state)).filter((name) => /^[1-9]\d*\.job\.json$/.test(name)))
          await finish(JSON.parse(await readFile(join(state, name), 'utf8')));
        for (const name of (await readdir(state)).filter((name) => /^[1-9]\d*\.outbox\.json$/.test(name))) {
          await api(`/api/v1/contributors/jobs/${name.split('.')[0]}/result`, JSON.parse(await readFile(join(state, name), 'utf8')));
          await unlink(join(state, name));
          completed++;
        }
        const { job } = (await api('/api/v1/contributors/jobs/claim', { sourceVersion: version })) as {
          job: (FetchJob & { expiresAt: string }) | null;
        };
        if (job) {
          if (
            !Number.isFinite(Date.parse(job.expiresAt)) ||
            Date.parse(job.expiresAt) <= Date.now() ||
            !/^[1-9]\d{0,15}$/.test(job.requestId)
          )
            throw Error('expired_or_invalid_job');
          await atomic(join(state, `${job.requestId}.job.json`), { domain: job.domain, requestId: job.requestId });
          await finish(job);
          continue;
        }
        lastError = null;
      } catch (error) {
        lastError =
          error instanceof Error && /^(main_HTTP_\d+|missing_node_key|expired_or_invalid_job)$/.test(error.message)
            ? error.message
            : 'network_or_state_error';
        console.error(JSON.stringify({ at: new Date().toISOString(), error: lastError }));
      }
      // Short waits permit a graceful Docker stop, including while upstream is idle.
      for (let i = 0; i < 5 && !stopping; i++) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    health.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runContributorAgent();
