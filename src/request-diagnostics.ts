import { type Pool, rows } from './db.ts';

/** Read saved sends only. Old rows remain unknown; never invent a route or missing provider headers. */
export async function recentRequestDiagnostics(pool: Pool) {
  const requests = await rows<{
    id: number;
    domain: string;
    at: Date;
    outcome: string;
    http_status: number | null;
    response_meta: string | Record<string, unknown> | null;
  }>(pool, 'SELECT id,domain,at,outcome,http_status,response_meta FROM sends ORDER BY id DESC LIMIT 24');
  return requests.map((request) => {
    const meta: Record<string, unknown> =
      typeof request.response_meta === 'string' ? JSON.parse(request.response_meta) : (request.response_meta ?? {});
    const text = (key: string) => (typeof meta[key] === 'string' ? meta[key].slice(0, 256) : null);
    const node = text('sourceNode');
    const sourceNode = node && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(node) ? node : null;
    const route = text('egressRoute');
    return {
      sendId: request.id,
      at: request.at.toISOString(),
      domain: request.domain,
      outcome: request.outcome,
      httpStatus: request.http_status,
      sourceNode,
      egressRoute:
        ['direct', 'vessel-tokyo', 'vessel-singapore'].includes(route ?? '') || (sourceNode && route === `contributor:${sourceNode}`)
          ? route
          : null,
      httpClient: ['node-fetch', 'curl', 'contributor-docker'].includes(text('httpClient') ?? '') ? text('httpClient') : null,
      experiment: text('egressExperiment'),
      diagnosticsRecorded: text('diagnosticsVersion') === '1',
      provider: text('provider') === 'CloudFront' ? 'CloudFront' : null,
      cache: text('x-cache'),
      pop: text('x-amz-cf-pop'),
      contentType: text('content-type'),
      retryAfter: text('retry-after'),
      retrySource: text('retrySource'),
      quotaExceeded: text('reason') === 'quota-exceeded',
      latestMonth: text('latestMonth'),
      latestProfileMonth: text('latestProfileMonth'),
    };
  });
}
