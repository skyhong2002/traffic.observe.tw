import { type Pool, rows } from './db.ts';
import { publicDomain, trafficDomain } from './similarweb.ts';

// similarsites.com (a Similarweb site) lists 20 similar sites per domain with a similarity grade, the similar site's
// category, visits and blurb, in the __NEXT_DATA__ JSON of /site/<domain>. Fetched here only to find sites worth
// tracking: the pairs are kept in similarsites_edges and counted in candidates(); nothing is tracked automatically.

export interface SimilarEdge {
  similar: string;
  rank: number;
  grade: number;
  category: string | null;
  topCountryRank: number | null;
  totalVisits: number | null;
  description: string | null;
}

export type SimilarResult =
  | { status: 'ok'; edges: SimilarEdge[] }
  | { status: 'not-found' }
  | { status: 'failed'; httpStatus: number | null };

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAX_HTML = 2_000_000;
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** The similar sites in a /site/<domain> page, or null when the page has no such data. */
export function parseSimilarSites(html: string, domain: string): SimilarEdge[] | null {
  const json = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!json) return null;
  let list: unknown;
  try {
    list = JSON.parse(json)?.props?.pageProps?.siteData?.SimilarSites;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const edges: SimilarEdge[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    const similar = publicDomain(item?.Site);
    const grade = item?.Grade;
    if (!similar || similar === domain || seen.has(similar) || typeof grade !== 'number' || !(grade >= 0 && grade <= 1)) continue;
    seen.add(similar);
    edges.push({
      similar,
      rank: count(item.SimilarityRank) ?? edges.length + 1,
      grade,
      category: text(item.Category, 64),
      topCountryRank: count(item.TopCountryRank),
      totalVisits: count(item.TotalVisits),
      description: text(item.Description, 500),
    });
  }
  return edges;
}

export async function requestSimilarSites(domain: string, request = fetch): Promise<SimilarResult> {
  if (trafficDomain(domain) !== domain) throw Error('Invalid domain');
  let response: Response;
  try {
    response = await request(`https://www.similarsites.com/site/${encodeURIComponent(domain)}`, {
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
  } catch {
    return { status: 'failed', httpStatus: null };
  }
  if (response.status === 404) return { status: 'not-found' };
  if (!response.ok) return { status: 'failed', httpStatus: response.status };
  const edges = parseSimilarSites((await response.text()).slice(0, MAX_HTML), domain);
  return edges ? { status: 'ok', edges } : { status: 'not-found' };
}

/** Records an attempt; on success the domain's pairs are replaced by the fresh list. */
export async function saveSimilarSites(pool: Pool, domain: string, result: SimilarResult, now = new Date()) {
  const httpStatus = result.status === 'failed' ? result.httpStatus : null;
  const ok = result.status === 'ok';
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (result.status === 'ok') {
      await conn.query('DELETE FROM similarsites_edges WHERE domain = ?', [domain]);
      for (const e of result.edges)
        await conn.query(
          'INSERT INTO similarsites_edges (domain, similar, similarity_rank, grade, category, top_country_rank, total_visits, description, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [domain, e.similar, e.rank, e.grade, e.category, e.topCountryRank, e.totalVisits, e.description, now],
        );
    }
    await conn.query(
      `INSERT INTO similarsites_state (domain, status, http_status, last_attempt_at, fetched_at, failures) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), http_status = VALUES(http_status), last_attempt_at = VALUES(last_attempt_at),
         fetched_at = IF(VALUES(status) = 'ok', VALUES(fetched_at), fetched_at), failures = IF(VALUES(status) = 'failed', failures + 1, 0)`,
      [domain, result.status, httpStatus, now, ok ? now : null, result.status === 'failed' ? 1 : 0],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/** Tracked domains (those with Similarweb months) that have no fresh answer from similarsites.com yet, oldest attempt first. */
export const dueDomains = (pool: Pool, olderThan: Date, limit: number) =>
  rows<{ domain: string }>(
    pool,
    `SELECT t.domain FROM (SELECT DISTINCT domain FROM traffic_months) t
     LEFT JOIN similarsites_state s ON s.domain = t.domain
     WHERE s.domain IS NULL OR s.last_attempt_at < ?
     ORDER BY s.last_attempt_at IS NOT NULL, s.last_attempt_at, t.domain LIMIT ?`,
    [olderThan, limit],
  ).then((r) => r.map((x) => x.domain));

// Clues that a site is Taiwanese, without asking Similarweb for its country shares: a .tw domain, or a blurb written in
// Traditional Chinese. Pairs of Traditional and Simplified characters that differ; a blurb counts as Traditional when it
// has several of the first kind and few of the second.
const CHARACTER_PAIRS =
  '這这 個个 們们 來来 與与 為为 說说 時时 後后 會会 對对 區区 網网 資资 訊讯 體体 業业 務务 動动 從从 還还 應应 該该 關关 門门 開开 實实 發发 現现 問问 題题 總总 報报 導导 點点 樣样 讓让 處处 進进 電电 戲戏 優优 購购 員员 學学 習习 機机 認认 證证 灣湾 舊旧';
const PAIRS = CHARACTER_PAIRS.split(' ');
const TRADITIONAL = new Set(PAIRS.map((pair) => pair[0]));
const SIMPLIFIED = new Set(PAIRS.map((pair) => pair[1]));
export type TaiwanClue = 'tw' | 'zh-hant';
/** 'tw' for a .tw domain, 'zh-hant' for a blurb mostly in Traditional characters, otherwise null (English, Simplified, none). */
export function taiwanClue(domain: string, descriptions: Array<string | null> = []): TaiwanClue | null {
  if (/\.tw$/.test(domain)) return 'tw';
  for (const text of descriptions) {
    if (!text) continue;
    let traditional = 0;
    let simplified = 0;
    for (const ch of text) {
      if (TRADITIONAL.has(ch)) traditional++;
      else if (SIMPLIFIED.has(ch)) simplified++;
    }
    if (traditional >= 2 && traditional > simplified * 2) return 'zh-hant';
  }
  return null;
}

export interface Candidate {
  domain: string;
  /** How many tracked sites list it as similar. */
  votes: number;
  bestGrade: number;
  avgGrade: number;
  category: string | null;
  topCountryRank: number | null;
  totalVisits: number | null;
  listedBy: string[];
  clue: TaiwanClue | null;
}

/** Similar sites that are not tracked yet, the ones named by most tracked sites first. */
export async function candidates(
  pool: Pool,
  { minVotes = 1, limit = 100, taiwanOnly = false }: { minVotes?: number; limit?: number; taiwanOnly?: boolean } = {},
): Promise<Candidate[]> {
  const found = await rows<{
    similar: string;
    votes: number;
    best: number;
    average: number;
    category: string | null;
    top_country_rank: number | null;
    total_visits: number | null;
    listed_by: string;
  }>(
    pool,
    `SELECT e.similar, COUNT(*) AS votes, MAX(e.grade) AS best, AVG(e.grade) AS average, MAX(e.category) AS category,
            MIN(e.top_country_rank) AS top_country_rank, MAX(e.total_visits) AS total_visits,
            SUBSTRING_INDEX(GROUP_CONCAT(e.domain ORDER BY e.grade DESC SEPARATOR ','), ',', 5) AS listed_by
     FROM similarsites_edges e
     WHERE e.similar NOT IN (SELECT DISTINCT domain FROM traffic_months)
     GROUP BY e.similar HAVING votes >= ?
     ORDER BY votes DESC, average DESC LIMIT ?`,
    // Filtering by clue happens after the query, so look further down the list.
    [minVotes, taiwanOnly ? 3000 : limit],
  );
  const blurbs = new Map<string, string[]>();
  if (found.length)
    for (const b of await rows<{ similar: string; description: string }>(
      pool,
      'SELECT similar, description FROM similarsites_edges WHERE similar IN (?) AND description IS NOT NULL',
      [found.map((c) => c.similar)],
    ))
      blurbs.set(b.similar, [...(blurbs.get(b.similar) ?? []), b.description]);
  const result = found.map((c) => ({
    domain: c.similar,
    votes: Number(c.votes),
    bestGrade: Number(c.best),
    avgGrade: Number(c.average),
    category: c.category,
    topCountryRank: c.top_country_rank,
    totalVisits: c.total_visits === null ? null : Number(c.total_visits),
    listedBy: c.listed_by.split(','),
    clue: taiwanClue(c.similar, blurbs.get(c.similar)),
  }));
  return (taiwanOnly ? result.filter((c) => c.clue) : result).slice(0, limit);
}

export interface SimilarListing {
  /** What similarsites.com lists as similar to the domain, most similar first. */
  similar: Array<SimilarEdge & { fetchedAt: Date }>;
  /** Tracked sites that list the domain as similar, most similar first. */
  listedBy: Array<{ domain: string; grade: number }>;
}

/** Both directions for one domain: the sites it is said to resemble, and the tracked sites that say it resembles them. */
export async function similarListing(pool: Pool, domain: string): Promise<SimilarListing> {
  const [similar, listedBy] = await Promise.all([
    rows<{
      similar: string;
      similarity_rank: number;
      grade: number;
      category: string | null;
      top_country_rank: number | null;
      total_visits: number | null;
      description: string | null;
      fetched_at: Date;
    }>(
      pool,
      'SELECT similar, similarity_rank, grade, category, top_country_rank, total_visits, description, fetched_at FROM similarsites_edges WHERE domain = ? ORDER BY similarity_rank',
      [domain],
    ),
    rows<{ domain: string; grade: number }>(
      pool,
      'SELECT domain, grade FROM similarsites_edges WHERE similar = ? ORDER BY grade DESC, domain LIMIT 80',
      [domain],
    ),
  ]);
  return {
    similar: similar.map((e) => ({
      similar: e.similar,
      rank: e.similarity_rank,
      grade: Number(e.grade),
      category: e.category,
      topCountryRank: e.top_country_rank,
      totalVisits: e.total_visits === null ? null : Number(e.total_visits),
      description: e.description,
      fetchedAt: e.fetched_at,
    })),
    listedBy: listedBy.map((l) => ({ domain: l.domain, grade: Number(l.grade) })),
  };
}
