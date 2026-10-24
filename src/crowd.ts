import { type Pool, rows } from './db.ts';

// Tags beyond the editors' list (0006_tag_votes.sql). The rules came over from blog's genres
// (blog app/src/blog-genres/resolve.ts, 2026-10-19), now for every domain:
// - the editors' list (or the sheet's) always shows, unless an admin hides one of its tags;
// - an AI suggestion shows until disagreements outnumber agreements by AI_HIDE_THRESHOLD;
// - a tag a reader adds shows at once (the reader's own agree) and hides when disagreements catch up;
// - an admin's set or hide wins over everything, and release hands the tag back to the rules above.
// Votes need a signed-in Google account; the voter is the verified email. Political leaning is not a tag here.

export type TagSource = 'editor' | 'sheet' | 'ai' | 'community' | 'admin';
export interface TagItem {
  tag: string;
  source: TagSource;
  visible: boolean;
  agrees: number;
  disagrees: number;
  adminOverride: 'set' | 'hide' | null;
}
export interface CrowdTag {
  tag: string;
  ai: boolean;
  community: boolean;
  admin: 'set' | 'hide' | null;
  agrees: number;
  disagrees: number;
}
export type Crowd = Map<string, CrowdTag[]>;
export type TagAction = 'vote' | 'propose' | 'admin';

export const COMMUNITY_THRESHOLD = 1;
export const AI_HIDE_THRESHOLD = 2;
/** Longest tag a reader or a service may add, in characters (the column holds 64). */
export const TAG_LIMIT = 32;
/** Writes per voter per minute, across the web and the services. */
const RATE = 30;

export class TagError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Every tag of one site: the base list in its own order, then the rest by agreement; shown tags first. */
export function resolveTags(base: string[], crowd: CrowdTag[] = [], baseSource: 'editor' | 'sheet' = 'editor'): TagItem[] {
  const byTag = new Map(crowd.map((c) => [c.tag, c]));
  const inBase = new Set(base);
  const item = (tag: string): TagItem => {
    const c = byTag.get(tag);
    const admin = c?.admin ?? null;
    const agrees = c?.agrees ?? 0;
    const disagrees = c?.disagrees ?? 0;
    const listed = inBase.has(tag);
    return {
      tag,
      source: admin ? 'admin' : listed ? baseSource : c?.ai ? 'ai' : 'community',
      visible: admin
        ? admin === 'set'
        : listed || (c?.ai ? disagrees - agrees < AI_HIDE_THRESHOLD : agrees - disagrees >= COMMUNITY_THRESHOLD),
      agrees,
      disagrees,
      adminOverride: admin,
    };
  };
  // Votes alone do not make a tag: one that left the editors' list goes with it.
  const others = crowd
    .filter((c) => !inBase.has(c.tag) && (c.ai || c.community || c.admin))
    .map((c) => item(c.tag))
    .sort((a, b) => b.agrees - a.agrees || a.tag.localeCompare(b.tag, 'zh-TW'));
  return [...base.map(item), ...others].sort((a, b) => Number(b.visible) - Number(a.visible));
}
export const shownTags = (base: string[], crowd?: CrowdTag[]) =>
  resolveTags(base, crowd)
    .filter((t) => t.visible)
    .map((t) => t.tag);

/** Assignments and vote counts, by domain; all domains when `domains` is left out. */
export async function loadCrowd(pool: Pick<Pool, 'query'>, domains?: string[]): Promise<Crowd> {
  if (domains && !domains.length) return new Map();
  const where = domains ? 'WHERE domain IN (?)' : '';
  const [assigned, counted] = await Promise.all([
    rows<{ domain: string; tag: string; ai: number; community: number; adminSet: number; adminHide: number }>(
      pool,
      `SELECT domain, tag, MAX(source = 'ai' AND status = 'active') AS ai, MAX(source = 'community') AS community,
        MAX(source = 'admin' AND status = 'active') AS adminSet, MAX(source = 'admin' AND status = 'hidden') AS adminHide
      FROM tag_assignments ${where} GROUP BY domain, tag`,
      domains ? [domains] : [],
    ),
    rows<{ domain: string; tag: string; agrees: number; disagrees: number }>(
      pool,
      `SELECT domain, tag, SUM(vote = 1) AS agrees, SUM(vote = -1) AS disagrees FROM tag_votes ${where} GROUP BY domain, tag`,
      domains ? [domains] : [],
    ),
  ]);
  const out: Crowd = new Map();
  const entry = (domain: string, tag: string) => {
    const list = out.get(domain) ?? out.set(domain, []).get(domain) ?? [];
    let c = list.find((x) => x.tag === tag);
    if (!c) list.push((c = { tag, ai: false, community: false, admin: null, agrees: 0, disagrees: 0 }));
    return c;
  };
  for (const r of assigned)
    Object.assign(entry(r.domain, r.tag), {
      ai: !!Number(r.ai),
      community: !!Number(r.community),
      admin: Number(r.adminHide) ? 'hide' : Number(r.adminSet) ? 'set' : null,
    });
  for (const r of counted) Object.assign(entry(r.domain, r.tag), { agrees: Number(r.agrees), disagrees: Number(r.disagrees) });
  return out;
}

/**
 * A tag as typed: NFKC, single spaces, no leading #, and the spelling of an existing tag that differs only in
 * case. null without a letter or digit, past TAG_LIMIT, or with separators or control characters.
 */
export function cleanTag(text: unknown, known: Iterable<string> = []): string | null {
  if (typeof text !== 'string') return null;
  const tag = text
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '');
  if (!/[\p{L}\p{N}]/u.test(tag) || [...tag].length > TAG_LIMIT || /[\p{Cc}\p{Cf},，、;；/\\|<>]/u.test(tag)) return null;
  const lower = tag.toLowerCase();
  for (const k of known) if (k.toLowerCase() === lower) return k;
  return tag;
}
/** Political leaning is not a tag (2026-10-24): tag.observe.tw keeps it. Readers, admins and AI cannot add these here. */
export const RESERVED_TAGS = new Set(['藍', '綠', '藍營', '綠營', '藍營傾向', '綠營傾向', '藍營傾向媒體', '綠營傾向媒體']);
const RESERVED = () => new TagError('reserved_tag', '政治傾向不是標籤，由 tag.observe.tw 另外處理。');
/** A verified Google email, lower case; services pass their signed-in reader's. */
export function voterOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 255) return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email) ? email : null;
}

const recent = new Map<string, { start: number; count: number }>();
/** At most RATE writes a minute per voter; entries expire as writes come in. */
export function allowWrite(voter: string, now = Date.now()) {
  for (const [key, r] of recent) if (now - r.start >= 60_000) recent.delete(key);
  const r = recent.get(voter) ?? { start: now, count: 0 };
  if (r.count >= RATE || (!recent.has(voter) && recent.size >= 10_000)) return false;
  r.count++;
  recent.set(voter, r);
  return true;
}

/** One voter's votes on these domains: domain → tag → 1 or -1. */
export async function votesOf(pool: Pick<Pool, 'query'>, voter: string, domains: string[]) {
  const out: Record<string, Record<string, number>> = {};
  if (!domains.length) return out;
  const list = await rows<{ domain: string; tag: string; vote: number }>(
    pool,
    'SELECT domain, tag, vote FROM tag_votes WHERE voter = ? AND domain IN (?)',
    [voter, domains],
  );
  for (const r of list) (out[r.domain] ??= {})[r.tag] = Number(r.vote);
  return out;
}

/** What an admin sees as their votes: the admin overrides, set as 1 and hide as -1 (admins do not vote). */
export async function overridesOf(pool: Pick<Pool, 'query'>, domains: string[]) {
  const out: Record<string, Record<string, number>> = {};
  if (!domains.length) return out;
  const list = await rows<{ domain: string; tag: string; status: string }>(
    pool,
    "SELECT domain, tag, status FROM tag_assignments WHERE source = 'admin' AND domain IN (?)",
    [domains],
  );
  for (const r of list) (out[r.domain] ??= {})[r.tag] = r.status === 'active' ? 1 : -1;
  return out;
}

export interface ActionInput {
  domain: string;
  /** The site's editor or sheet tags, which can be voted on without being proposed. */
  base: string[];
  /** Tags in use anywhere, so a proposal takes an existing spelling. */
  known?: Iterable<string>;
  kind: TagAction;
  tag: unknown;
  /** vote: 1, -1 or 0 (withdraw); admin: set, hide or release. */
  value?: unknown;
  voter: string;
  admin: boolean;
  via: string;
}
/** One reader's vote or proposal, or an admin's override, in a transaction with its log row. Returns the tag. */
export async function tagAction(pool: Pool, input: ActionInput) {
  const { domain, voter, via } = input;
  let { kind, value } = input;
  const tag = kind === 'propose' ? cleanTag(input.tag, input.known) : typeof input.tag === 'string' ? input.tag : null;
  if (!tag) throw new TagError('invalid_tag', `標籤需含文字或數字，最多 ${TAG_LIMIT} 字，不能有逗號、頓號或斜線。`);
  if (kind === 'vote' && ![1, -1, 0].includes(value as number)) throw new TagError('invalid_vote', '投票只能是同意、不同意或收回。');
  // Admins do not vote (2026-10-24): agree shows the tag, disagree hides it, withdrawing releases it, adding sets it.
  if (input.admin && kind !== 'admin') {
    value = kind === 'propose' ? 'set' : value === 1 ? 'set' : value === -1 ? 'hide' : 'release';
    kind = 'admin';
  }
  if (kind === 'admin' && !['set', 'hide', 'release'].includes(value as string))
    throw new TagError('invalid_action', '管理動作只能是指定顯示、隱藏或解除覆寫。');
  if (kind === 'admin' && !input.admin) throw new TagError('not_admin', '只有管理員可以覆寫標籤。', 403);
  if (RESERVED_TAGS.has(tag) && (kind === 'propose' || value === 'set')) throw RESERVED();
  if (!allowWrite(voter)) throw new TagError('rate_limited', '操作太頻繁，請一分鐘後再試。', 429);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [before] = await rows<{ sources: string | null }>(
      conn,
      "SELECT GROUP_CONCAT(CONCAT(source, ':', status) ORDER BY source) AS sources FROM tag_assignments WHERE domain = ? AND tag = ? FOR UPDATE",
      [domain, tag],
    );
    if (kind === 'vote' && !before?.sources && !input.base.includes(tag)) throw new TagError('unknown_tag', '這個網站沒有這個標籤。', 404);
    if (kind === 'propose' || (kind === 'admin' && value !== 'release' && !input.base.includes(tag)))
      // Admin-introduced tags keep a candidate too, so releasing the override hands them to the votes.
      await conn.query(
        `INSERT IGNORE INTO tag_assignments (domain, tag, source, status, actor, created_at, updated_at)
        VALUES (?, ?, 'community', 'candidate', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [domain, tag, voter],
      );
    if (kind === 'admin') {
      await conn.query('DELETE FROM tag_votes WHERE domain = ? AND tag = ? AND voter = ?', [domain, tag, voter]);
      if (value === 'release')
        await conn.query("DELETE FROM tag_assignments WHERE domain = ? AND tag = ? AND source = 'admin'", [domain, tag]);
      else
        await conn.query(
          `INSERT INTO tag_assignments (domain, tag, source, status, actor, created_at, updated_at)
          VALUES (?, ?, 'admin', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
          ON DUPLICATE KEY UPDATE status = VALUES(status), actor = VALUES(actor), updated_at = UTC_TIMESTAMP()`,
          [domain, tag, value === 'set' ? 'active' : 'hidden', voter],
        );
    } else {
      const vote = kind === 'propose' ? 1 : (value as number);
      if (vote === 0) await conn.query('DELETE FROM tag_votes WHERE domain = ? AND tag = ? AND voter = ?', [domain, tag, voter]);
      else
        await conn.query(
          `INSERT INTO tag_votes (domain, tag, voter, vote, via, at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())
          ON DUPLICATE KEY UPDATE vote = VALUES(vote), via = VALUES(via), at = UTC_TIMESTAMP()`,
          [domain, tag, voter, vote, via],
        );
    }
    await conn.query('INSERT INTO tag_log (at, actor, via, action, domain, tag, detail) VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?)', [
      voter,
      via,
      kind === 'admin' ? String(value) : kind,
      domain,
      tag,
      JSON.stringify({ before: before?.sources ?? null, value: input.value ?? null, as: input.kind }),
    ]);
    await conn.commit();
    return tag;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * A service's AI suggestions, replacing what that service suggested before for each listed domain
 * (other services' suggestions, reader tags and admin overrides stay). Returns how many rows changed.
 */
export async function setAiTags(
  pool: Pool,
  requester: string,
  sites: Array<{ domain: string; tags: Array<{ tag: string; reason: string | null }> }>,
) {
  const actor = `service:${requester}`;
  const conn = await pool.getConnection();
  let changed = 0;
  try {
    await conn.beginTransaction();
    for (const { domain, tags: suggested } of [...sites].sort((a, b) => a.domain.localeCompare(b.domain))) {
      const tags = suggested.map((t) => t.tag);
      const reasonOf = (tag: string) => suggested.find((t) => t.tag === tag)?.reason ?? null;
      const old = await rows<{ tag: string }>(
        conn,
        "SELECT tag FROM tag_assignments WHERE domain = ? AND source = 'ai' AND actor = ? FOR UPDATE",
        [domain, actor],
      );
      const gone = old.map((r) => r.tag).filter((t) => !tags.includes(t));
      const added = tags.filter((t) => !old.some((r) => r.tag === t));
      if (gone.length)
        await conn.query("DELETE FROM tag_assignments WHERE domain = ? AND source = 'ai' AND actor = ? AND tag IN (?)", [
          domain,
          actor,
          gone,
        ]);
      for (const tag of tags)
        await conn.query(
          `INSERT INTO tag_assignments (domain, tag, source, status, reason, actor, created_at, updated_at)
          VALUES (?, ?, 'ai', 'active', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
          ON DUPLICATE KEY UPDATE status = 'active', reason = VALUES(reason), actor = VALUES(actor), updated_at = UTC_TIMESTAMP()`,
          [domain, tag, reasonOf(tag), actor],
        );
      for (const [action, list] of [
        ['ai-add', added],
        ['ai-remove', gone],
      ] as const)
        for (const tag of list)
          await conn.query('INSERT INTO tag_log (at, actor, via, action, domain, tag, detail) VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?)', [
            actor,
            requester,
            action,
            domain,
            tag,
            JSON.stringify({ reason: reasonOf(tag) }),
          ]);
      changed += added.length + gone.length;
    }
    await conn.commit();
    return changed;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/** How many tag votes each of these voters has standing, and when they last voted; only those cast via `via` when given. */
export async function voterStats(pool: Pick<Pool, 'query'>, voters: string[], via?: string) {
  const out: Record<string, { votes: number; lastAt: string | null }> = Object.fromEntries(
    voters.map((v) => [v, { votes: 0, lastAt: null }]),
  );
  if (!voters.length) return out;
  const list = await rows<{ voter: string; votes: number; lastAt: Date }>(
    pool,
    `SELECT voter, COUNT(*) AS votes, MAX(at) AS lastAt FROM tag_votes WHERE voter IN (?) ${via ? 'AND via = ?' : ''} GROUP BY voter`,
    via ? [voters, via] : [voters],
  );
  for (const r of list) out[r.voter] = { votes: Number(r.votes), lastAt: r.lastAt.toISOString() };
  return out;
}
