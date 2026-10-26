import type { FastifyInstance } from 'fastify';

/** Kept configurable while DNS and OAuth are switched to the new domain. */
export const publicOrigin = (env: Record<string, string | undefined> = process.env) =>
  new URL(env.TRAFFIC_PUBLIC_ORIGIN || 'https://site.observe.tw').origin;

export function registerLegacyOrigin(app: FastifyInstance, origin = publicOrigin()) {
  if (new URL(origin).hostname === 'traffic.observe.tw') return;
  app.addHook('onRequest', async (request, reply) => {
    // Local service callers retain their loopback URL; forwarded Host is not trusted.
    if (request.url.startsWith('/internal/') || !request.url.startsWith('/')) return;
    if (/^traffic\.observe\.tw(?::\d+)?$/i.test(request.headers.host ?? '')) {
      return reply.redirect(`${origin}${request.url}`, 308);
    }
  });
}
