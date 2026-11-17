import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { type Pool, rows } from './db.ts';
import { publicDomain, type TrafficChannel, type TrafficProfile, trafficChannels } from './similarweb.ts';

export const CONTRIBUTOR_SCHEMA = 1;
const NODE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MONTH = /^20\d{2}(0[1-9]|1[0-2])$/;
export interface ContributorData {
  /** Absolute visits, not millions. Unknown profile fields are omitted. */
  visits?: number;
  channels?: Partial<Record<TrafficChannel, number>>;
  countries?: Array<{ code: string; share: number }>;
  bounceRate?: number;
  pagesPerVisit?: number;
  timeOnSite?: number;
}
export interface ContributorPayload {
  domain: string;
  targetMonth: string;
  fetchedAt: string;
  sourceNode: string;
  sourceVersion: string;
  schemaVersion: number;
  responseStatus: number;
  fields: string[];
  payloadHash: string;
  payload: ContributorData;
}
export type ContributorError = { ok: false; error: string; field?: string };
export type ContributorAccepted = { ok: true; payload: ContributorPayload; idempotencyKey: string };
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
export const contributorHash = (payload: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(payload)))
    .digest('hex');
export const contributorFields = (p: ContributorData) =>
  Object.entries(p)
    .flatMap(([key, value]) =>
      key === 'channels'
        ? Object.keys(value ?? {}).map((c) => `channels.${c}`)
        : value === undefined || (key === 'countries' && Array.isArray(value) && !value.length)
          ? []
          : [key],
    )
    .sort();
export const communityEnabled = () => process.env.TRAFFIC_COMMUNITY_ENABLED === '1';

export function createContributorPayload(
  input: Omit<ContributorPayload, 'payloadHash' | 'schemaVersion' | 'fields'> & { fields?: string[] },
): ContributorPayload {
  return {
    ...input,
    schemaVersion: CONTRIBUTOR_SCHEMA,
    fields: contributorFields(input.payload),
    payloadHash: contributorHash(input.payload),
  };
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;

export function validateContributorPayload(raw: unknown, expectedNode?: string, now = new Date()): ContributorAccepted | ContributorError {
  const error = (field: string, reason = `invalid_${field}`): ContributorError => ({ ok: false, error: reason, field });
  if (!record(raw)) return error('payload');
  const keys = [
    'domain',
    'targetMonth',
    'fetchedAt',
    'sourceNode',
    'sourceVersion',
    'schemaVersion',
    'responseStatus',
    'fields',
    'payloadHash',
    'payload',
  ];
  if (Object.keys(raw).some((k) => !keys.includes(k))) return error('payload', 'unknown_field');
  const domain = typeof raw.domain === 'string' ? publicDomain(raw.domain) : null;
  if (!domain || domain !== String(raw.domain).toLowerCase()) return error('domain');
  if (
    typeof raw.targetMonth !== 'string' ||
    !MONTH.test(raw.targetMonth) ||
    raw.targetMonth >= now.toISOString().slice(0, 7).replace('-', '')
  )
    return error('targetMonth');
  const fetched =
    typeof raw.fetchedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(raw.fetchedAt)
      ? Date.parse(raw.fetchedAt)
      : NaN;
  if (
    !Number.isFinite(fetched) ||
    (typeof raw.fetchedAt === 'string' && new Date(fetched).toISOString().slice(0, 10) !== raw.fetchedAt.slice(0, 10)) ||
    fetched > now.getTime() + 60_000 ||
    fetched < Date.UTC(Number(raw.targetMonth.slice(0, 4)), Number(raw.targetMonth.slice(4)), 1)
  )
    return error('fetchedAt');
  if (typeof raw.sourceNode !== 'string' || !NODE.test(raw.sourceNode)) return error('sourceNode');
  if (expectedNode && raw.sourceNode !== expectedNode) return error('sourceNode', 'source_node_mismatch');
  if (typeof raw.sourceVersion !== 'string' || !/^[a-zA-Z0-9._+-]{1,64}$/.test(raw.sourceVersion)) return error('sourceVersion');
  if (raw.schemaVersion !== CONTRIBUTOR_SCHEMA) return error('schemaVersion', 'unsupported_schema');
  if (!Number.isInteger(raw.responseStatus) || !finite(raw.responseStatus, 599) || Number(raw.responseStatus) < 100)
    return error('responseStatus');
  if (!record(raw.payload) || Buffer.byteLength(JSON.stringify(raw.payload)) > 256 * 1024) return error('payload');
  const p = raw.payload;
  if (Object.keys(p).some((k) => !['visits', 'channels', 'countries', 'bounceRate', 'pagesPerVisit', 'timeOnSite'].includes(k)))
    return error('payload', 'unknown_data_field');
  if ('visits' in p && (!Number.isSafeInteger(p.visits) || !finite(p.visits))) return error('visits');
  if (
    'channels' in p &&
    (!record(p.channels) ||
      Object.entries(p.channels).some(([k, v]) => !trafficChannels.includes(k as TrafficChannel) || !finite(v, 1)) ||
      Object.values(p.channels).reduce<number>((sum, v) => sum + Number(v), 0) > 1.001)
  )
    return error('channels');
  if ('countries' in p) {
    if (!Array.isArray(p.countries) || p.countries.length > 250) return error('countries');
    const seen = new Set<string>();
    let sum = 0;
    for (const c of p.countries) {
      if (
        !record(c) ||
        Object.keys(c).some((k) => !['code', 'share'].includes(k)) ||
        typeof c.code !== 'string' ||
        !/^[A-Z]{2}$/.test(c.code) ||
        seen.has(c.code) ||
        !finite(c.share, 1)
      )
        return error('countries');
      seen.add(c.code);
      sum += Number(c.share);
    }
    if (sum > 1.001) return error('countries');
  }
  for (const key of ['bounceRate', 'pagesPerVisit', 'timeOnSite'])
    if (key in p && !finite(p[key], key === 'bounceRate' ? 1 : Number.MAX_SAFE_INTEGER)) return error(key);
  if (Number(raw.responseStatus) >= 200 && Number(raw.responseStatus) < 300 && !(Number(p.visits) > 0))
    return error('visits', 'success_requires_visits');
  if ((Number(raw.responseStatus) < 200 || Number(raw.responseStatus) >= 300) && Object.keys(p).length)
    return error('payload', 'failure_must_have_empty_payload');
  const fields = contributorFields(p as ContributorData);
  if (!Array.isArray(raw.fields) || JSON.stringify([...raw.fields].sort()) !== JSON.stringify(fields)) return error('fields');
  const hash = contributorHash(p);
  if (raw.payloadHash !== hash) return error('payloadHash', 'payload_hash_mismatch');
  const payload: ContributorPayload = {
    domain,
    targetMonth: raw.targetMonth,
    fetchedAt: new Date(fetched).toISOString(),
    sourceNode: raw.sourceNode,
    sourceVersion: raw.sourceVersion,
    schemaVersion: 1,
    responseStatus: Number(raw.responseStatus),
    fields,
    payloadHash: hash,
    payload: p as ContributorData,
  };
  return { ok: true, payload, idempotencyKey: `${payload.sourceNode}:${domain}:${payload.targetMonth}:${hash}` };
}

export function signContributorToken(
  node: string,
  issuedAt = Math.floor(Date.now() / 1000),
  secret = process.env.TRAFFIC_CONTRIBUTOR_SECRET ?? '',
) {
  if (!NODE.test(node) || secret.length < 32) return null;
  const body = `${node}.${issuedAt}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verifyContributorToken(
  token: unknown,
  secret = process.env.TRAFFIC_CONTRIBUTOR_SECRET ?? '',
  now = Math.floor(Date.now() / 1000),
) {
  if (typeof token !== 'string' || secret.length < 32) return null;
  const m = /^([a-z0-9][a-z0-9._-]{0,63})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m || Number(m[2]) > now + 60 || now - Number(m[2]) > 900) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${m[1]}.${m[2]}`).digest('base64url'));
  const actual = Buffer.from(m[3]);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? m[1] : null;
}
export function contributorTrust(env: Record<string, string | undefined> = process.env) {
  const out: Record<string, number> = {};
  for (const part of (env.TRAFFIC_CONTRIBUTOR_TRUST ?? '').split(',')) {
    const [node, value] = part.trim().split(':');
    const score = Number(value);
    if (node && NODE.test(node) && Number.isFinite(score) && score > 0) out[node] = score;
  }
  return out;
}
export interface ContributorObservation extends ContributorPayload {
  id: number;
  acceptedAt: string;
}
export function selectCanonicalContributor<T extends ContributorPayload>(list: T[], trust = contributorTrust()): T | null {
  return (
    [...list]
      .filter((r) => r.responseStatus >= 200 && r.responseStatus < 300 && (trust[r.sourceNode] ?? 0) > 0)
      .sort(
        (a, b) =>
          (trust[b.sourceNode] ?? 0) - (trust[a.sourceNode] ?? 0) ||
          b.fields.length - a.fields.length ||
          Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt) ||
          a.sourceNode.localeCompare(b.sourceNode) ||
          a.payloadHash.localeCompare(b.payloadHash),
      )[0] ?? null
  );
}
const decode = (r: Record<string, unknown>): ContributorObservation =>
  ({
    id: Number(r.id),
    domain: String(r.domain),
    targetMonth: String(r.target_month),
    fetchedAt: (r.fetched_at as Date).toISOString(),
    sourceNode: String(r.source_node),
    sourceVersion: String(r.source_version),
    schemaVersion: Number(r.schema_version),
    responseStatus: Number(r.response_status),
    fields: typeof r.fields === 'string' ? JSON.parse(r.fields) : r.fields,
    payloadHash: String(r.payload_hash),
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    acceptedAt: (r.accepted_at as Date).toISOString(),
  }) as ContributorObservation;
export async function contributorObservations(
  pool: Pick<Pool, 'query'>,
  domain?: string,
  month?: string,
): Promise<ContributorObservation[]> {
  const where = [];
  const params = [];
  if (domain) {
    where.push('domain = ?');
    params.push(domain);
  }
  if (month) {
    where.push('target_month = ?');
    params.push(month);
  }
  return (
    await rows<Record<string, unknown>>(
      pool,
      `SELECT * FROM contributor_observations${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY fetched_at DESC, id`,
      params,
    )
  ).map(decode);
}
export async function saveContributorPayload(pool: Pool, p: ContributorPayload, acceptedAt = new Date()) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // A row lock serializes canonical decisions for this domain/month, including first upload.
    await conn.query(
      'INSERT IGNORE INTO contributor_canonical (domain, target_month, observation_id, reason, updated_at) VALUES (?, ?, NULL, ?, ?)',
      [p.domain, p.targetMonth, 'no trusted valid observation', acceptedAt],
    );
    await conn.query('SELECT domain FROM contributor_canonical WHERE domain = ? AND target_month = ? FOR UPDATE', [
      p.domain,
      p.targetMonth,
    ]);
    const old = await rows<{ id: number }>(
      conn,
      'SELECT id FROM contributor_observations WHERE source_node = ? AND domain = ? AND target_month = ? AND payload_hash = ?',
      [p.sourceNode, p.domain, p.targetMonth, p.payloadHash],
    );
    if (!old.length)
      await conn.query(
        'INSERT INTO contributor_observations (source_node, domain, target_month, fetched_at, source_version, schema_version, response_status, fields, payload_hash, payload, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          p.sourceNode,
          p.domain,
          p.targetMonth,
          new Date(p.fetchedAt),
          p.sourceVersion,
          p.schemaVersion,
          p.responseStatus,
          JSON.stringify(p.fields),
          p.payloadHash,
          JSON.stringify(p.payload),
          acceptedAt,
        ],
      );
    const choice = selectCanonicalContributor(await contributorObservations(conn, p.domain, p.targetMonth));
    const reason = choice
      ? `trusted=${contributorTrust()[choice.sourceNode]}; fields=${choice.fields.length}; fetchedAt=${choice.fetchedAt}; tie=node,hash`
      : 'no trusted valid observation';
    await conn.query(
      'UPDATE contributor_canonical SET observation_id = ?, reason = ?, updated_at = ? WHERE domain = ? AND target_month = ?',
      [choice?.id ?? null, reason, acceptedAt, p.domain, p.targetMonth],
    );
    await conn.commit();
    return {
      idempotencyKey: `${p.sourceNode}:${p.domain}:${p.targetMonth}:${p.payloadHash}`,
      duplicate: old.length > 0,
      canonicalId: choice?.id ?? null,
      reason,
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
export async function loadCommunity(pool: Pool, months?: string[], domains?: string[]) {
  if (!communityEnabled() || months?.length === 0 || domains?.length === 0) return [] as ContributorObservation[];
  const where = [];
  const params = [];
  if (months) {
    where.push('o.target_month IN (?)');
    params.push(months);
  }
  if (domains) {
    where.push('o.domain IN (?)');
    params.push(domains);
  }
  const list = await rows<Record<string, unknown>>(
    pool,
    `SELECT o.* FROM contributor_canonical c JOIN contributor_observations o ON o.id = c.observation_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  );
  // Removing trust is an immediate rollback, even before the next canonical refresh.
  const trust = contributorTrust();
  return list.map(decode).filter((r) => (trust[r.sourceNode] ?? 0) > 0);
}
export function communityProfile(r: ContributorPayload): TrafficProfile {
  return {
    globalRank: null,
    countryRank: null,
    categoryRank: null,
    month: r.targetMonth,
    source: 'community',
    countries: r.payload.countries ?? [],
    channels: r.payload.channels ?? {},
    bounceRate: r.payload.bounceRate ?? null,
    pagesPerVisit: r.payload.pagesPerVisit ?? null,
    timeOnSite: r.payload.timeOnSite ?? null,
  };
}
