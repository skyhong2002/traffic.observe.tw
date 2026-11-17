#!/usr/bin/env node
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { type ContributorPayload, createContributorPayload, validateContributorPayload } from '../src/contributor.ts';

export interface QueueItem {
  payload: ContributorPayload;
  attempts: number;
  nextAttemptAt: string | null;
  state: 'pending' | 'sent' | 'rejected';
  error: string | null;
}
export interface NodeState {
  version: 1;
  items: QueueItem[];
  lastSyncAt: string | null;
}
export const emptyNodeState = (): NodeState => ({ version: 1, items: [], lastSyncAt: null });
export function enqueue(state: NodeState, payloads: ContributorPayload[], now = new Date()) {
  for (const raw of payloads) {
    const checked = validateContributorPayload(raw, undefined, now);
    if (!checked.ok) throw Error(`invalid input: ${checked.error}`);
    const p = checked.payload;
    if (
      state.items.some(
        (r) =>
          r.payload.sourceNode === p.sourceNode &&
          r.payload.domain === p.domain &&
          r.payload.targetMonth === p.targetMonth &&
          r.payload.payloadHash === p.payloadHash,
      )
    )
      continue;
    state.items.push({ payload: p, attempts: 0, nextAttemptAt: null, state: 'pending', error: null });
  }
}
export async function syncNode(state: NodeState, url: string, token: string, request: typeof fetch = fetch, now = new Date()) {
  const batch = state.items
    .filter((r) => r.state === 'pending' && (!r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= now.getTime()))
    .slice(0, 100);
  if (!batch.length) return;
  let response: Response | null = null;
  let answers: Array<{ ok: boolean; error?: string }> = [];
  let failure = 'network';
  try {
    response = await request(`${url.replace(/\/$/, '')}/api/v1/contributors/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(batch.map((r) => r.payload)),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 201 || response.status === 207 || response.status === 200) {
      const data = (await response.json()) as { results?: typeof answers };
      if (!Array.isArray(data.results) || data.results.length !== batch.length || data.results.some((r) => typeof r.ok !== 'boolean'))
        throw Error('invalid batch acknowledgement');
      answers = data.results;
    }
    failure = `HTTP ${response.status}`;
  } catch {
    failure = 'network_or_invalid_acknowledgement';
  }
  for (const [i, row] of batch.entries()) {
    row.attempts++;
    const answer = answers[i];
    if (answer?.ok) {
      row.state = 'sent';
      row.error = null;
      row.nextAttemptAt = null;
      continue;
    }
    if (answer || (response && [400, 403, 404, 413, 422].includes(response.status))) {
      row.state = 'rejected';
      row.error = answer?.error ?? failure;
      continue;
    }
    const retry = response?.headers.get('retry-after');
    const providerWait = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - now.getTime())) : 0;
    const delay = Math.max(Number.isFinite(providerWait) ? providerWait : 0, Math.min(3_600_000, 1000 * 2 ** Math.min(12, row.attempts)));
    row.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
    row.error = failure;
  }
  state.lastSyncAt = now.toISOString();
}
export async function saveNodeState(file: string, state: NodeState) {
  const next = `${file}.${process.pid}.tmp`;
  await writeFile(next, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(next, file);
}
export async function runContributorNode(args = process.argv.slice(2)) {
  const option = (name: string, fallback = '') => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : (args[index + 1] ?? fallback);
  };
  const file = option('--queue', 'contributor-queue.json');
  const input = option('--input');
  const once = args.includes('--once');
  const dry = args.includes('--dry-run');
  const interval = Number(option('--interval-seconds', '3600'));
  const port = Number(option('--port', '18151'));
  if (!Number.isInteger(interval) || interval < 60 || !Number.isInteger(port) || port < 0 || port > 65535)
    throw Error('invalid interval or port');
  const base = process.env.CONTRIBUTOR_URL ?? 'http://127.0.0.1:18150';
  const parsed = new URL(base);
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))
  )
    throw Error('use HTTPS or local loopback');
  const lockFile = `${file}.lock`;
  const lock = await open(lockFile, 'wx', 0o600).catch(() => {
    throw Error('queue is locked; stop the other node or remove a stale lock after confirming it has exited');
  });
  await lock.writeFile(String(process.pid));
  let state = emptyNodeState();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const health = createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        request.url === '/health'
          ? {
              lastSyncAt: state.lastSyncAt,
              pending: state.items.filter((r) => r.state === 'pending').length,
              sent: state.items.filter((r) => r.state === 'sent').length,
              rejected: state.items.filter((r) => r.state === 'rejected').length,
              errors: state.items
                .filter((r) => r.error)
                .map((r) => ({ domain: r.payload.domain, error: r.error, nextAttemptAt: r.nextAttemptAt })),
            }
          : { error: 'not_found' },
      ),
    );
  });
  try {
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.items)) throw Error('invalid queue');
      for (const item of state.items) {
        const checked = validateContributorPayload(item.payload);
        if (
          !checked.ok ||
          !['pending', 'sent', 'rejected'].includes(item.state) ||
          !Number.isSafeInteger(item.attempts) ||
          item.attempts < 0 ||
          (item.nextAttemptAt !== null && !Number.isFinite(Date.parse(item.nextAttemptAt)))
        )
          throw Error('invalid persisted queue item');
        item.payload = checked.payload;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!once && !dry)
      await new Promise<void>((resolve, reject) => {
        health.once('error', reject);
        health.listen(port, '127.0.0.1', resolve);
      });
    do {
      if (input) {
        const raw = JSON.parse(await readFile(input, 'utf8'));
        const list = Array.isArray(raw) ? raw : [raw];
        enqueue(
          state,
          list.map((r) => ('payloadHash' in r ? r : createContributorPayload(r))),
        );
      }
      if (dry) {
        console.log(JSON.stringify({ pending: state.items.filter((r) => r.state === 'pending').length, valid: true }));
        break;
      }
      await saveNodeState(file, state);
      const token = process.env.TRAFFIC_CONTRIBUTOR_TOKEN_FILE
        ? (await readFile(process.env.TRAFFIC_CONTRIBUTOR_TOKEN_FILE, 'utf8')).trim()
        : (process.env.TRAFFIC_CONTRIBUTOR_TOKEN ?? '');
      if (!token) throw Error('provide TRAFFIC_CONTRIBUTOR_TOKEN_FILE or TRAFFIC_CONTRIBUTOR_TOKEN (never the server signing secret)');
      await syncNode(state, base, token);
      await saveNodeState(file, state);
      console.log(
        JSON.stringify({
          at: state.lastSyncAt,
          pending: state.items.filter((r) => r.state === 'pending').length,
          sent: state.items.filter((r) => r.state === 'sent').length,
        }),
      );
      if (once) break;
      // Short waits allow graceful shutdown without interrupting an upload.
      const until = Date.now() + interval * 1000;
      while (!stopping && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
    } while (!stopping);
  } finally {
    health.close();
    await lock.close();
    await unlink(lockFile);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runContributorNode();
