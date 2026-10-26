import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Pool, rows } from './db.ts';
import { publicOrigin } from './origin.ts';

// Google sign-in, ported from tag (app/src/auth/google-login.ts) and cut down.
// Any verified Google account gets a session, to vote on and add site tags
// (crowd.ts); only the editors in TRAFFIC_ADMIN_EMAILS manage domains, names,
// the tag lists and tag overrides. Reading the public pages needs no sign-in.
// Sessions are stored as SHA-256 hashes.

export type LoginConfig = { clientId: string; clientSecret: string; origin: string; admins: Set<string> };
export type Editor = { email: string; name: string | null; picture?: string | null };
/** Exchanges an authorization code for the ID token's claims. */
export type CodeExchange = (code: string, verifier: string) => Promise<Record<string, unknown>>;

const SESSION_COOKIE = 'traffic_session';
const FLOW_COOKIE = 'traffic_oauth';
const SESSION_DAYS = 30;
const FLOW_SECONDS = 600;

export function loginConfig(env: Record<string, string | undefined> = process.env): LoginConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw Error('Google login needs both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  const origin = new URL(publicOrigin(env));
  if (!['http:', 'https:'].includes(origin.protocol)) throw Error('TRAFFIC_PUBLIC_ORIGIN must be http(s)');
  const admins = new Set(
    (env.TRAFFIC_ADMIN_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  return { clientId, clientSecret, origin: origin.origin, admins };
}

const token = () => randomBytes(32).toString('base64url');
const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

function readCookie(request: FastifyRequest, name: string) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** Only same-site paths survive the round trip, so the login can't be used as an open redirect. */
export function safeNext(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (value.startsWith('/auth/') || value.length > 512 || [...value].some((c) => c < ' ')) return '/';
  return value;
}

function googleExchange(config: LoginConfig): CodeExchange {
  return async (code, verifier) => {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        code_verifier: verifier,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: `${config.origin}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw Error(`token endpoint ${response.status}`);
    const { id_token: idToken } = (await response.json()) as { id_token?: string };
    if (typeof idToken !== 'string') throw Error('no id_token');
    // Straight from Google's token endpoint over TLS (OpenID Connect Core 3.1.3.7).
    return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
  };
}

/** The profile picture URL, only when Google serves it from its own image host over https. */
function googlePicture(value: unknown) {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)googleusercontent\.com$/.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Checks the ID token claims; returns null when anything is off. */
export function verifiedEditor(claims: Record<string, unknown>, config: LoginConfig, nonce: string, now = Date.now()): Editor | null {
  const { iss, aud, azp, exp, email, email_verified: verified, name, picture } = claims;
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(String(iss))) return null;
  if (aud !== config.clientId || (azp !== undefined && azp !== config.clientId)) return null;
  if (typeof exp !== 'number' || exp * 1000 <= now || claims.nonce !== nonce) return null;
  if (verified !== true || typeof email !== 'string' || !email || email.length > 255) return null;
  return {
    email: email.toLowerCase(),
    name: typeof name === 'string' && name ? name.slice(0, 255) : null,
    picture: googlePicture(picture),
  };
}

export type LoginOptions = { exchange?: CodeExchange; now?: () => number };

export function registerLogin(app: FastifyInstance, pool: Pool, config: LoginConfig | null, options: LoginOptions = {}) {
  const now = options.now ?? Date.now;
  const secure = config?.origin.startsWith('https:') ? '; Secure' : '';
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;

  /** Whoever is signed in, editor or not. */
  async function currentUser(request: FastifyRequest): Promise<Editor | null> {
    const value = readCookie(request, SESSION_COOKIE);
    if (!config || !value || value.length > 64) return null;
    const [row] = await rows<Editor>(pool, 'SELECT email, name, picture FROM sessions WHERE token_hash = ? AND expires_at > ?', [
      hashToken(value),
      new Date(now()),
    ]);
    return row ?? null;
  }
  /** The list is re-read on every request, so removing an email takes editing away at once. */
  const isEditor = (email: string) => Boolean(config?.admins.has(email.toLowerCase()));
  /** The signed-in editor. */
  async function currentEditor(request: FastifyRequest): Promise<Editor | null> {
    const user = await currentUser(request);
    return user && isEditor(user.email) ? user : null;
  }
  /** Form posts must come from this site (the cookie is SameSite=Lax, this is the second guard). */
  const sameOrigin = (request: FastifyRequest) => Boolean(config && request.headers.origin === config.origin);

  if (!config) return { enabled: false, currentUser, currentEditor, isEditor, sameOrigin };
  const exchange = options.exchange ?? googleExchange(config);
  const callback = `${config.origin}/auth/google/callback`;
  const fail = (reply: FastifyReply, reason: string) => reply.redirect(`/login/?error=${reason}`, 303);

  app.get<{ Querystring: { next?: string } }>('/auth/google', async (request, reply) => {
    const state = token();
    const nonce = token();
    const verifier = token();
    const flow = Buffer.from(JSON.stringify({ state, nonce, verifier, next: safeNext(request.query.next) })).toString('base64url');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: callback,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return reply
      .header('cache-control', 'no-store')
      .header('set-cookie', cookie(FLOW_COOKIE, flow, FLOW_SECONDS))
      .redirect(url.toString(), 302);
  });

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>('/auth/google/callback', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('set-cookie', cookie(FLOW_COOKIE, '', 0));
    let flow: { state?: string; nonce?: string; verifier?: string; next?: string } = {};
    try {
      flow = JSON.parse(Buffer.from(readCookie(request, FLOW_COOKIE) ?? '', 'base64url').toString('utf8'));
    } catch {}
    const { state, code, error } = request.query;
    if (!flow.state || !flow.nonce || !flow.verifier || state !== flow.state) return fail(reply, 'state');
    if (error) return fail(reply, 'cancelled');
    if (!code || code.length > 2048) return fail(reply, 'invalid');
    let editor: Editor | null;
    try {
      editor = verifiedEditor(await exchange(code, flow.verifier), config, flow.nonce, now());
    } catch (err) {
      // Never log the code, tokens or the client secret.
      request.log.warn({ err: (err as Error).message }, 'google login exchange failed');
      return fail(reply, 'failed');
    }
    if (!editor) return fail(reply, 'invalid');
    const at = new Date(now());
    const session = token();
    // Sign-ins are rare, so expired sessions are swept here rather than by a job.
    await pool.query('DELETE FROM sessions WHERE expires_at < ?', [at]);
    await pool.query('INSERT INTO sessions (token_hash, email, name, picture, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
      hashToken(session),
      editor.email,
      editor.name,
      editor.picture ?? null,
      at,
      new Date(at.getTime() + SESSION_DAYS * 86_400_000),
    ]);
    return reply
      .header('set-cookie', [cookie(FLOW_COOKIE, '', 0), cookie(SESSION_COOKIE, session, SESSION_DAYS * 86_400)])
      .redirect(safeNext(flow.next), 303);
  });

  app.post('/auth/logout', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'same-origin requests only' });
    const value = readCookie(request, SESSION_COOKIE);
    if (value && value.length <= 64) await pool.query('DELETE FROM sessions WHERE token_hash = ?', [hashToken(value)]);
    return reply.header('set-cookie', cookie(SESSION_COOKIE, '', 0)).redirect('/', 303);
  });

  return { enabled: true, currentUser, currentEditor, isEditor, sameOrigin };
}
