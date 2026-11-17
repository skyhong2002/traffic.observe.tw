import { createHash, timingSafeEqual } from 'node:crypto';
import type { FetchReply } from '../tools/contributor-fetch.ts';
import { contributorTraffic, contributorTrust, saveContributorPayload, verifyContributorToken } from './contributor.ts';
import { type Pool, rows } from './db.ts';
import { parseDomainTraffic } from './similarweb.ts';

const nodePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export function verifyNodeToken(token: unknown, keys = process.env.TRAFFIC_CONTRIBUTOR_NODE_KEYS ?? '') {
  const legacy = verifyContributorToken(token);
  if (legacy) return legacy;
  if (typeof token !== 'string') return null;
  const match = /^cn1:([a-z0-9][a-z0-9._-]{0,63}):([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const expected = keys
    .split(',')
    .map((part) => part.trim().split(':'))
    .find(([node]) => node === match[1])?.[1];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return null;
  return timingSafeEqual(Buffer.from(expected, 'hex'), createHash('sha256').update(token).digest()) ? match[1] : null;
}

export const configuredNodes = () => {
  const nodes = (process.env.TRAFFIC_CONTRIBUTOR_NODES ?? '')
    .split(',')
    .map((node) => node.trim())
    .filter(Boolean);
  if (nodes.some((node) => !nodePattern.test(node)) || new Set(nodes).size !== nodes.length) throw Error('invalid contributor nodes');
  return nodes;
};

export async function claimContributorJob(pool: Pool, node: string, version: string, now = new Date()) {
  if (!configuredNodes().includes(node) || !contributorTrust()[node]) return null;
  if (!/^[a-zA-Z0-9._+-]{1,64}$/.test(version)) throw Error('invalid node version');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'INSERT INTO contributor_nodes (source_node,source_version,last_seen_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE source_version=VALUES(source_version),last_seen_at=VALUES(last_seen_at)',
      [node, version, now],
    );
    const [job] = await rows<{ send_id: number; domain: string; expires_at: Date }>(
      conn,
      'SELECT send_id,domain,expires_at FROM contributor_jobs WHERE source_node=? AND claimed_at IS NULL AND completed_at IS NULL AND expires_at>? ORDER BY send_id LIMIT 1 FOR UPDATE',
      [node, new Date(now.getTime() + 25_000)],
    );
    if (job) await conn.query('UPDATE contributor_jobs SET claimed_at=? WHERE send_id=?', [now, job.send_id]);
    await conn.commit();
    return job ? { domain: job.domain, requestId: String(job.send_id), expiresAt: job.expires_at.toISOString() } : null;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export interface JobResult {
  reply?: FetchReply;
  error?: 'fetch_failed';
  sourceVersion: string;
}
export function validJobResult(raw: unknown): raw is JobResult {
  if (!raw || typeof raw !== 'object') return false;
  const result = raw as JobResult;
  if (typeof result.sourceVersion !== 'string' || !/^[a-zA-Z0-9._+-]{1,64}$/.test(result.sourceVersion)) return false;
  if (result.error === 'fetch_failed' && !result.reply) return true;
  const reply = result.reply;
  return (
    !!reply &&
    !result.error &&
    /^[1-9]\d{0,15}$/.test(reply.requestId) &&
    typeof reply.domain === 'string' &&
    typeof reply.fetchedAt === 'string' &&
    Number.isFinite(Date.parse(reply.fetchedAt)) &&
    Number.isInteger(reply.status) &&
    reply.status >= 200 &&
    reply.status <= 599 &&
    typeof reply.body === 'string' &&
    Buffer.byteLength(reply.body) <= 4 * 1024 * 1024 &&
    !!reply.headers &&
    typeof reply.headers === 'object' &&
    !Array.isArray(reply.headers) &&
    Object.entries(reply.headers).length <= 20 &&
    Object.entries(reply.headers).every(([key, value]) => /^[a-z0-9-]{1,64}$/.test(key) && typeof value === 'string' && value.length <= 256)
  );
}

export async function completeContributorJob(pool: Pool, node: string, id: string, result: JobResult, now = new Date()) {
  if (!/^[1-9]\d{0,15}$/.test(id) || !validJobResult(result)) return false;
  const [job] = await rows<{ domain: string; claimed_at: Date | null; created_at: Date; expires_at: Date }>(
    pool,
    'SELECT domain,claimed_at,created_at,expires_at FROM contributor_jobs WHERE send_id=? AND source_node=?',
    [id, node],
  );
  if (!job?.claimed_at) return false;
  if (
    result.reply &&
    (result.reply.requestId !== id ||
      result.reply.domain !== job.domain ||
      Date.parse(result.reply.fetchedAt) < job.created_at.getTime() - 60_000 ||
      Date.parse(result.reply.fetchedAt) > job.expires_at.getTime() ||
      Date.parse(result.reply.fetchedAt) > now.getTime() + 60_000)
  )
    return false;
  // First acknowledgement wins; retries are idempotent, including after expiry.
  await pool.query('UPDATE contributor_jobs SET result=?,completed_at=? WHERE send_id=? AND source_node=? AND completed_at IS NULL', [
    JSON.stringify(result),
    now,
    id,
    node,
  ]);
  const [stored] = await rows<{ result: string }>(pool, 'SELECT result FROM contributor_jobs WHERE send_id=?', [id]);
  const accepted: JobResult = JSON.parse(stored.result);
  if (accepted.reply && accepted.reply.status >= 200 && accepted.reply.status < 300) {
    let observations: ReturnType<typeof contributorTraffic> = [];
    try {
      observations = contributorTraffic(
        parseDomainTraffic(JSON.parse(accepted.reply.body), job.domain, new Date(accepted.reply.fetchedAt)),
        node,
        accepted.sourceVersion,
      );
    } catch {
      // The scheduler records malformed/no-data responses; do not invent traffic.
    }
    // Persist on receipt even if the worker restarts or its wait has expired.
    for (const observation of observations) await saveContributorPayload(pool, observation, now);
  }
  return true;
}

/** The scheduler already owns the named lock and has durably reserved this send. */
export async function waitForContributor(pool: Pool, node: string, domain: string, id: number, signal?: AbortSignal) {
  const created = new Date();
  await pool.query('INSERT INTO contributor_jobs (send_id,source_node,domain,created_at,expires_at) VALUES (?,?,?,?,?)', [
    id,
    node,
    domain,
    created,
    new Date(created.getTime() + 45_000),
  ]);
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const [job] = await rows<{ result: string | JobResult | null }>(pool, 'SELECT result FROM contributor_jobs WHERE send_id=?', [id]);
    if (job?.result) {
      const result: JobResult = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
      if (result.error || !result.reply) throw Error('contributor fetch failed; no fallback request');
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error('contributor job timed out; no fallback request');
}
