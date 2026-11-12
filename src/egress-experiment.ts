import { spawn } from 'node:child_process';
import { type Pool, rows } from './db.ts';
import { trafficDomain } from './similarweb.ts';

export const experimentRoutes = ['direct', 'vessel-tokyo', 'vessel-singapore'] as const;
export type EgressRoute = (typeof experimentRoutes)[number];
export type Execute = (command: string, args: string[], input: string) => Promise<string>;

/** No shell, retries, proxy environment or unbounded output. Headers travel over stdin. */
const execute: Execute = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL' });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    // Discard curl/SSH stderr: an error must never echo headers or request configuration.
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.once('error', () => reject(Error('Egress transport could not start')));
    child.once('close', (code) => {
      if (code !== 0 || size > 4 * 1024 * 1024) reject(Error(`Egress transport failed (exit ${code})`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });

/** curl's dump-header precedes the unchanged body; informational responses may precede the final one. */
export function curlResponse(output: string) {
  let rest = output;
  for (;;) {
    const end = rest.indexOf('\r\n\r\n');
    if (end < 0) throw Error('Egress transport returned invalid HTTP headers');
    const lines = rest.slice(0, end).split('\r\n');
    const status = Number(/^HTTP\/\S+ (\d{3})/.exec(lines.shift() ?? '')?.[1]);
    rest = rest.slice(end + 4);
    if (status >= 100 && status < 200) continue;
    if (status < 200 || status > 599 || !Number.isInteger(status)) throw Error('Egress transport returned invalid HTTP status');
    const headers = new Headers();
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    return new Response([204, 205, 304].includes(status) ? null : rest, { status, headers });
  }
}

/** Bind only this request's source address. Existing Vessel policy routes and fail-closed guard remain in force. */
export async function requestViaEgress(route: EgressRoute, input: string, init: RequestInit, run: Execute = execute) {
  const url = new URL(input);
  const domain = url.searchParams.get('domain');
  if (
    url.origin !== 'https://data.similarweb.com' ||
    url.pathname !== '/api/v1/data' ||
    !domain ||
    trafficDomain(domain) !== domain ||
    url.username ||
    url.password ||
    (init.method && init.method !== 'GET') ||
    init.body
  )
    throw Error('Egress experiment only accepts the existing Similarweb GET endpoint');
  init.signal?.throwIfAborted();
  const source = route === 'vessel-tokyo' ? '10.8.1.6' : route === 'vessel-singapore' ? '10.8.1.8' : null;
  const config = [
    'ipv4',
    'http1.1',
    'silent',
    'show-error',
    'noproxy = "*"',
    'proxy = ""',
    'retry = 0',
    'max-time = 20',
    'connect-timeout = 8',
    'max-filesize = 4194304',
    'proto = "=https"',
    'dump-header = "-"',
    ...(source ? [`interface = ${JSON.stringify(source)}`] : []),
    `url = ${JSON.stringify(url.href)}`,
    ...[...new Headers(init.headers)].map(([key, value]) => `header = ${JSON.stringify(`${key}: ${value}`)}`),
  ].join('\n');
  const command = route === 'vessel-singapore' ? 'ssh' : 'curl';
  const args =
    route === 'vessel-singapore'
      ? ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'mint-mbp', 'curl --disable --config -']
      : ['--disable', '--config', '-'];
  return curlResponse(await run(command, args, `${config}\n`));
}

interface Trial {
  id: number;
  at: Date;
  domain: string;
  outcome: string;
  http_status: number | null;
  response_meta: string | Record<string, unknown> | null;
}
const metadata = (value: Trial['response_meta']): Record<string, unknown> =>
  typeof value === 'string' ? JSON.parse(value) : (value ?? {});

export async function egressExperimentStatus(pool: Pool, id = process.env.TRAFFIC_EGRESS_EXPERIMENT) {
  if (!id) return null;
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw Error('Invalid egress experiment ID');
  const trials = await rows<Trial>(
    pool,
    "SELECT id,at,domain,outcome,http_status,response_meta FROM sends WHERE JSON_UNQUOTE(JSON_EXTRACT(response_meta,'$.egressExperiment'))=? ORDER BY id",
    [id],
  );
  return {
    id,
    limit: experimentRoutes.length,
    remaining: Math.max(0, experimentRoutes.length - trials.length),
    nextRoute: experimentRoutes[trials.length] ?? null,
    trials: trials.map((trial) => {
      const meta = metadata(trial.response_meta);
      return {
        ...meta,
        sendId: trial.id,
        at: trial.at.toISOString(),
        domain: trial.domain,
        outcome: trial.outcome,
        httpStatus: trial.http_status,
        egressRoute: experimentRoutes.find((route) => route === meta.egressRoute) ?? null,
        latestMonth: typeof meta.latestMonth === 'string' ? meta.latestMonth : null,
        latestProfileMonth: typeof meta.latestProfileMonth === 'string' ? meta.latestProfileMonth : null,
      };
    }),
  };
}

/** Called only by runOnce, after its shared lock, policy checks and durable recovery reservation. */
export function experimentalRequest(
  pool: Pool,
  id = process.env.TRAFFIC_EGRESS_EXPERIMENT,
  transport = requestViaEgress,
  ordinary = fetch,
): typeof fetch {
  if (!id) return ordinary;
  return (async (input: string, init: RequestInit = {}) => {
    const experiment = await egressExperimentStatus(pool, id);
    if (!experiment?.nextRoute) return ordinary(input, init);
    const domain = new URL(input).searchParams.get('domain');
    const [pending] = await rows<{ id: number; recovery_probe: number; response_meta: Trial['response_meta'] }>(
      pool,
      "SELECT id,recovery_probe,response_meta FROM sends WHERE domain=? AND outcome='pending' ORDER BY id DESC LIMIT 1",
      [domain],
    );
    if (!pending) throw Error('Egress experiment requires a reserved send');
    // The trial budget is a subset of existing recovery requests, never extra requests after recovery.
    if (!pending.recovery_probe) return ordinary(input, init);
    if (metadata(pending.response_meta).egressExperiment) throw Error('Egress trial already reserved');
    await pool.query("UPDATE sends SET response_meta=JSON_MERGE_PATCH(COALESCE(response_meta,'{}'),?) WHERE id=?", [
      JSON.stringify({ egressExperiment: id, egressRoute: experiment.nextRoute, httpClient: 'curl' }),
      pending.id,
    ]);
    // No fallback to another route on any transport/HTTP error.
    const response = await transport(experiment.nextRoute, input, init);
    const headers = Object.fromEntries(
      [
        'retry-after',
        'ratelimit-limit',
        'ratelimit-remaining',
        'ratelimit-reset',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
      ].map((key) => [key, response.headers.get(key)?.slice(0, 256) ?? null]),
    );
    await pool.query('UPDATE sends SET response_meta=JSON_MERGE_PATCH(response_meta,?) WHERE id=?', [JSON.stringify(headers), pending.id]);
    return response;
  }) as typeof fetch;
}
