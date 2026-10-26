import type { FastifyInstance } from 'fastify';

/** Kept configurable while DNS and OAuth are switched to the new domain. */
export const publicOrigin = (env: Record<string, string | undefined> = process.env) =>
  new URL(env.TRAFFIC_PUBLIC_ORIGIN || 'https://site.observe.tw').origin;

export function registerLegacyOrigin(app: FastifyInstance, origin = publicOrigin()) {
  const target = new URL(origin);
  if (target.hostname === 'traffic.observe.tw') return;
  app.addHook('onRequest', async (request, reply) => {
    // Local service callers retain their loopback URL; forwarded Host is not trusted.
    if (request.url.startsWith('/internal/') || !request.url.startsWith('/')) return;
    const host = (request.headers.host ?? '').toLowerCase();
    // The tunnel forwards the visitor's scheme. It cannot choose the redirect host.
    const needsHttps = target.protocol === 'https:' && host === target.host && request.headers['x-forwarded-proto'] === 'http';
    if (/^traffic\.observe\.tw(?::\d+)?$/.test(host) || needsHttps) {
      return reply.redirect(`${origin}${request.url}`, 308);
    }
  });
}
