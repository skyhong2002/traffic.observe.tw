import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('recovers an unacknowledged outbox after process restart without fetching again', async () => {
  const state = await mkdtemp(join(tmpdir(), 'contributor-agent-'));
  const now = new Date().toISOString();
  const reply = { domain: 'a.tw', requestId: '123', fetchedAt: now, status: 200, headers: {}, body: '{"persisted":true}' };
  await mkdir(join(state, 'responses'));
  await writeFile(join(state, 'responses/123.json'), JSON.stringify(reply));
  let issued = false;
  let fail = true;
  const results: string[] = [];
  let uploaded!: () => void;
  let rejected!: () => void;
  const firstRejected = new Promise<void>((resolve) => {
    rejected = resolve;
  });
  const delivered = new Promise<void>((resolve) => {
    uploaded = resolve;
  });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('content-type', 'application/json');
    expect(request.headers.authorization).toBe('Bearer test-only-node-key');
    if (request.url?.endsWith('/claim')) {
      response.end(
        JSON.stringify({
          job: issued ? null : { domain: 'a.tw', requestId: '123', expiresAt: new Date(Date.now() + 45_000).toISOString() },
        }),
      );
      issued = true;
    } else {
      results.push(body);
      response.statusCode = fail ? 503 : 200;
      response.end(JSON.stringify(fail ? { error: 'temporary' } : { ok: true }));
      if (fail) rejected();
      else uploaded();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const start = () => {
    const child = spawn(process.execPath, ['tools/contributor-agent.ts'], {
      env: {
        ...process.env,
        CONTRIBUTOR_URL: `http://127.0.0.1:${address.port}`,
        CONTRIBUTOR_STATE: state,
        CONTRIBUTOR_VERSION: 'test-v1',
        TRAFFIC_CONTRIBUTOR_TOKEN: 'test-only-node-key',
        TRAFFIC_CONTRIBUTOR_TOKEN_FILE: '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.resume();
    return child;
  };
  const stop = async (child: ChildProcess) => {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
  };
  let child = start();
  try {
    await firstRejected;
    await stop(child);
    expect(JSON.parse(await readFile(join(state, '123.outbox.json'), 'utf8')).reply).toEqual(reply);
    fail = false;
    child = start();
    await delivered;
    expect(results).toHaveLength(2);
    expect(results[0]).toBe(results[1]);
    expect(JSON.parse(results[1])).toMatchObject({ sourceVersion: 'test-v1', reply });
  } finally {
    if (child.exitCode === null && child.signalCode === null) await stop(child);
    server.close();
    await rm(state, { recursive: true, force: true });
  }
}, 10_000);
