import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

// /internal/* is for the observe services on this machine only: a direct
// loopback connection (no cf-connecting-ip, which Cloudflare always sets, and
// no forwarding headers) with a service token. Anything else gets a plain 404,
// so the routes do not show from outside. Tokens come from the environment
// (TRAFFIC_TOKEN_<REQUESTER>, at least 32 characters), never from Git; the token
// decides the requester.

const FORWARDED = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'tailscale-user-login'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function serviceTokens(env: Record<string, string | undefined> = process.env) {
  const out = new Map<string, Buffer>();
  for (const [key, value] of Object.entries(env)) {
    const m = /^TRAFFIC_TOKEN_([A-Z0-9]{1,16})$/.exec(key);
    if (m && value && value.length >= 32) out.set(m[1].toLowerCase(), Buffer.from(value));
  }
  return out;
}

export function requesterOf(request: FastifyRequest, tokens: Map<string, Buffer>) {
  if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) return null;
  if (FORWARDED.some((h) => request.headers[h] !== undefined)) return null;
  const auth = request.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  const given = Buffer.from(auth.slice(7));
  for (const [requester, token] of tokens) if (given.length === token.length && timingSafeEqual(given, token)) return requester;
  return null;
}

/** The requester, or null after sending the 404. */
export function authenticate(request: FastifyRequest, reply: FastifyReply, tokens: Map<string, Buffer>) {
  reply.header('cache-control', 'no-store');
  const requester = tokens.size ? requesterOf(request, tokens) : null;
  if (!requester) reply.code(404).send({ error: 'not found' });
  return requester;
}
