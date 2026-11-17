#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extensionHeaders, publicDomain, swContext } from '../src/similarweb.ts';

export interface FetchJob {
  domain: string;
  requestId: string;
}
export interface FetchReply {
  domain: string;
  requestId: string;
  fetchedAt: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}
export const MAX_REPLY_BYTES = 4 * 1024 * 1024;

/** Called over SSH only after the controller reserves a send under its shared lock. */
export async function fetchContributorJob(
  job: FetchJob,
  directory: string,
  request: typeof fetch = fetch,
  now = new Date(),
): Promise<FetchReply> {
  if (publicDomain(job.domain) !== job.domain || !/^[1-9]\d{0,15}$/.test(job.requestId)) throw Error('invalid contributor job');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${job.requestId}.json`);
  const cached = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (cached) {
    const reply = JSON.parse(cached) as FetchReply;
    if (reply.domain !== job.domain) throw Error('contributor job domain mismatch');
    return reply;
  }
  // Retain the reservation on any failure: the same job must never send twice.
  const reservation = await open(`${file}.started`, 'wx', 0o600);
  await reservation.close();
  let device: string;
  const deviceFile = join(directory, 'device-id');
  try {
    device = (await readFile(deviceFile, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    device = randomUUID();
    await writeFile(deviceFile, device, { mode: 0o600, flag: 'wx' });
  }
  if (!/^[a-f0-9-]{36}$/.test(device)) throw Error('invalid persisted device ID');
  const response = await request(`https://data.similarweb.com/api/v1/data?domain=${encodeURIComponent(job.domain)}`, {
    headers: { ...extensionHeaders, 'x-sw-ctx': swContext(device, now) },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_REPLY_BYTES) throw Error('contributor response too large');
      chunks.push(chunk);
    }
  }
  const headers: Record<string, string> = {};
  for (const name of [
    'retry-after',
    'date',
    'server',
    'via',
    'content-type',
    'x-cache',
    'x-amz-cf-pop',
    'ratelimit-limit',
    'ratelimit-remaining',
    'ratelimit-reset',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
  ]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value.slice(0, 256);
  }
  const reply: FetchReply = {
    ...job,
    fetchedAt: now.toISOString(),
    status: response.status,
    headers,
    body: Buffer.concat(chunks).toString('utf8'),
  };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(reply), { mode: 0o600 });
  await rename(temporary, file);
  await unlink(`${file}.started`);
  return reply;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024) throw Error('contributor job too large');
    }
    const directory = process.argv[2];
    if (!directory) throw Error('state directory required');
    console.log(JSON.stringify(await fetchContributorJob(JSON.parse(input), directory)));
  } catch {
    console.error('contributor fetch failed; reservation retained, no automatic retry');
    process.exitCode = 1;
  }
}
