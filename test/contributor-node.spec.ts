import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createContributorPayload } from '../src/contributor.ts';
import { emptyNodeState, enqueue, type NodeState, saveNodeState, syncNode } from '../tools/contributor-node.ts';

const now = new Date('2026-11-17T12:00:00Z');
const payload = (domain: string) =>
  createContributorPayload({
    domain,
    targetMonth: '202610',
    fetchedAt: '2026-11-01T00:00:00Z',
    sourceNode: 'node',
    sourceVersion: 'test',
    responseStatus: 200,
    payload: { visits: 100 },
  });
it('persists partial acknowledgements and retries pending work after restart without resending successes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'traffic-node-'));
  try {
    const state = emptyNodeState();
    enqueue(state, [payload('a.tw'), payload('b.tw')], now);
    enqueue(state, [payload('a.tw')], now);
    expect(state.items).toHaveLength(2);
    await syncNode(
      state,
      'https://example.com',
      'test',
      (async () =>
        new Response(JSON.stringify({ results: [{ ok: true }, { ok: false, error: 'invalid_month' }] }), { status: 207 })) as typeof fetch,
      now,
    );
    expect(state.items.map((r) => r.state)).toEqual(['sent', 'rejected']);
    enqueue(state, [payload('c.tw')], now);
    let calls = 0;
    await syncNode(
      state,
      'https://example.com',
      'test',
      (async (_url, init) => {
        calls++;
        expect(String(init?.body)).toContain('c.tw');
        expect(String(init?.body)).not.toContain('a.tw');
        return new Response('', { status: 429, headers: { 'retry-after': '120' } });
      }) as typeof fetch,
      now,
    );
    const file = join(dir, 'queue.json');
    await saveNodeState(file, state);
    const restored = JSON.parse(await readFile(file, 'utf8')) as NodeState;
    expect(restored.items[2]).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: '2026-11-17T12:02:00.000Z' });
    await syncNode(
      restored,
      'https://example.com',
      'test',
      (async () => {
        calls++;
        throw Error('should not send before retry');
      }) as typeof fetch,
      now,
    );
    expect(calls).toBe(1);
    await syncNode(
      restored,
      'https://example.com',
      'new-token',
      (async () => new Response(JSON.stringify({ results: [{ ok: true }] }), { status: 201 })) as typeof fetch,
      new Date('2026-11-17T12:02:00Z'),
    );
    expect(restored.items[2].state).toBe('sent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('keeps data pending when the network or acknowledgement fails', async () => {
  for (const response of [null, new Response(JSON.stringify({ results: [] }), { status: 201 })]) {
    const state = emptyNodeState();
    enqueue(state, [payload('a.tw')], now);
    await syncNode(
      state,
      'https://example.com',
      'test',
      (async () => {
        if (!response) throw Error('timeout');
        return response;
      }) as typeof fetch,
      now,
    );
    expect(state.items[0]).toMatchObject({ state: 'pending', attempts: 1, error: 'network_or_invalid_acknowledgement' });
    expect(Date.parse(state.items[0].nextAttemptAt!)).toBeGreaterThan(now.getTime());
  }
});

it('runs scheduled imports with loopback health and rejects a second process sharing the durable queue', async () => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:http');
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'traffic-node-service-'));
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as unknown[];
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results: input.map(() => ({ ok: true })) }));
  });
  const reserve = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const healthPort = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const input = join(dir, 'input.json'),
    queue = join(dir, 'queue.json');
  await writeFile(input, JSON.stringify([payload('a.tw')]));
  const child = spawn(
    process.execPath,
    ['tools/contributor-node.ts', '--queue', queue, '--input', input, '--interval-seconds', '60', '--port', String(healthPort)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONTRIBUTOR_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        TRAFFIC_CONTRIBUTOR_TOKEN: 'test-token',
        TRAFFIC_CONTRIBUTOR_TOKEN_FILE: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => {
        throw Error(stderr);
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(Error('node start timeout')), 5000).unref()),
    ]);
    const health = await (await fetch(`http://127.0.0.1:${healthPort}/health`)).json();
    expect(health).toMatchObject({ pending: 0, sent: 1, rejected: 0 });
    const second = spawn(process.execPath, ['tools/contributor-node.ts', '--queue', queue, '--dry-run'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    second.stderr.on('data', (chunk) => {
      error += chunk;
    });
    const [code] = await once(second, 'exit');
    expect(code).not.toBe(0);
    expect(error).toContain('queue is locked');
    expect(JSON.parse(await readFile(queue, 'utf8')).items[0].state).toBe('sent');
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);
