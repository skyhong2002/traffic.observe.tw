// Copy from blog's database (read only): every verified blog's genres, as tags on its domain
// (canonical_host): AI suggestions, reader-added tags, admin overrides and every vote, the voter
// being the blog account's Google email. Genre keys become their labels (food → 美食); reader
// genres are already their text. Blogs whose domain this service does not know are listed and left out.
// Safe to rerun, as before blog switches to /internal/v1/tags: rows are upserted, a newer vote wins.
//   node --env-file=.env --env-file=$HOME/.config/blog-observe.env tools/import-blog-tags.ts [--dry-run]
import { cleanTag } from '../src/crowd.ts';
import { createPool, rows } from '../src/db.ts';
import { managedSites } from '../src/metadata.ts';
import { publicDomain } from '../src/similarweb.ts';

// blog app/src/blog-genre-vocabulary.ts BLOG_GENRES as of 2026-10-17.
const GENRES: Record<string, string> = {
  food: '美食',
  travel: '旅遊',
  gadgets: '3C',
  software: '軟體介紹',
  programming: '程式',
  tech: '技術',
  life: '生活',
  diary: '日記',
  parenting: '親子',
  news: '新聞',
  media: '媒體',
  finance: '財經',
  anime: '動漫',
  games: '遊戲',
  reading: '閱讀',
  culture: '藝文',
  photography: '攝影',
  design: '設計',
  other: '其他',
  general: '綜合',
};

const dry = process.argv.includes('--dry-run');
const blog = createPool(process.env.BLOG_DB_URL, { size: 2 });
const pool = createPool();
try {
  const known = new Set((await managedSites(pool)).map((s) => s.domain));
  const assignments = await rows<{
    host: string;
    slug: string;
    genre: string;
    source: string;
    status: string;
    reason: string | null;
    email: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    blog,
    `SELECT b.canonical_host AS host, b.slug, a.genre, a.source, a.status, a.reason, u.email, a.created_at, a.updated_at
    FROM blog_genre_assignments a JOIN blogs b ON b.id = a.blog_id AND b.status = 'verified' LEFT JOIN users u ON u.id = a.actor_user_id`,
  );
  const votes = await rows<{ host: string; genre: string; email: string; vote: number; at: Date }>(
    blog,
    `SELECT b.canonical_host AS host, v.genre, u.email, v.vote, v.at
    FROM blog_genre_votes v JOIN blogs b ON b.id = v.blog_id AND b.status = 'verified' JOIN users u ON u.id = v.user_id`,
  );
  const unknown = new Set<string>();
  const bad = new Set<string>();
  const place = (host: string, genre: string) => {
    const domain = publicDomain(host);
    const tag = cleanTag(GENRES[genre] ?? genre);
    if (!domain || !known.has(domain)) unknown.add(host);
    else if (!tag) bad.add(genre);
    else return { domain, tag };
    return null;
  };
  // What is here already, so a rerun counts and logs only rows that are new.
  const had = new Set(
    (await rows<{ k: string }>(pool, "SELECT CONCAT_WS(' ', domain, tag, source) AS k FROM tag_assignments")).map((r) => r.k),
  );
  const voted = new Set((await rows<{ k: string }>(pool, "SELECT CONCAT_WS(' ', domain, tag, voter) AS k FROM tag_votes")).map((r) => r.k));
  const counts = { assignments: 0, newAssignments: 0, votes: 0, newVotes: 0 };
  for (const a of assignments) {
    const at = place(a.host, a.genre);
    if (!at || !['ai', 'community', 'admin'].includes(a.source)) continue;
    counts.assignments++;
    const fresh = !had.has(`${at.domain} ${at.tag} ${a.source}`);
    if (fresh) counts.newAssignments++;
    if (dry) continue;
    const actor = a.source === 'ai' || !a.email ? 'service:blog' : a.email.toLowerCase();
    await pool.query(
      `INSERT INTO tag_assignments (domain, tag, source, status, reason, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE status = VALUES(status), reason = VALUES(reason), actor = VALUES(actor), updated_at = VALUES(updated_at)`,
      [at.domain, at.tag, a.source, a.status, a.reason, actor, a.created_at, a.updated_at],
    );
    if (fresh)
      await pool.query(
        "INSERT INTO tag_log (at, actor, via, action, domain, tag, detail) VALUES (UTC_TIMESTAMP(), ?, 'blog', 'import', ?, ?, ?)",
        [actor, at.domain, at.tag, JSON.stringify({ source: a.source, status: a.status, slug: a.slug, genre: a.genre })],
      );
  }
  for (const v of votes) {
    const at = place(v.host, v.genre);
    if (!at || ![1, -1].includes(Number(v.vote))) continue;
    counts.votes++;
    if (!voted.has(`${at.domain} ${at.tag} ${v.email.toLowerCase()}`)) counts.newVotes++;
    if (dry) continue;
    await pool.query(
      `INSERT INTO tag_votes (domain, tag, voter, vote, via, at) VALUES (?, ?, ?, ?, 'blog', ?)
      ON DUPLICATE KEY UPDATE vote = IF(VALUES(at) >= at, VALUES(vote), vote), at = GREATEST(at, VALUES(at))`,
      [at.domain, at.tag, v.email.toLowerCase(), Number(v.vote), v.at],
    );
  }
  console.log({ dry, ...counts, unknownDomains: [...unknown].sort(), unusableGenres: [...bad] });
} finally {
  await blog.end();
  await pool.end();
}
