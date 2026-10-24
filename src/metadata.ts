import { loadCrowd, shownTags } from './crowd.ts';
import { type Pool, rows } from './db.ts';
import { latestTopics, splitTopics } from './tags.ts';

export interface Metadata {
  domain: string;
  name: string | null;
  topics: string[] | null;
  revision: number;
}
export interface ManagedSite {
  domain: string;
  name: string;
  /** What the pages show: the editors' list with readers' and AI tags applied (crowd.ts). */
  topics: string[];
  /** The editors' list, or the sheet's when there is none; what the edit forms change. */
  baseTopics: string[];
  revision: number;
  custom: boolean;
}
export class EditError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export const parseTopics = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 8000) throw new EditError('標籤格式不正確。');
  const topics = splitTopics(value);
  if (topics.length > 100 || topics.some((t) => t.length > 64 || [...t].some((c) => c < ' ' || c.charCodeAt(0) === 127)))
    throw new EditError('最多 100 個標籤，每個標籤最多 64 字。');
  return topics;
};
export async function loadMetadata(pool: Pick<Pool, 'query'>) {
  const list = await rows<Metadata & { topics: string[] | string | null }>(
    pool,
    'SELECT domain, name, topics, revision FROM site_metadata',
  );
  return new Map(
    list.map((r) => [r.domain, { ...r, topics: typeof r.topics === 'string' ? (JSON.parse(r.topics) as string[]) : r.topics }]),
  );
}
export async function managedSites(pool: Pick<Pool, 'query'>): Promise<ManagedSite[]> {
  const [domains, labels, overrides, crowd] = await Promise.all([
    rows<{ domain: string }>(
      pool,
      `SELECT domain FROM traffic_months UNION SELECT domain FROM watches
      UNION SELECT domain FROM sheet_rows WHERE domain IS NOT NULL UNION SELECT domain FROM radar_ranks UNION SELECT domain FROM site_metadata`,
    ),
    rows<{ domain: string; month: string; name: string; group: string | null; topics: string | null }>(
      pool,
      'SELECT domain, month, name, group_label AS `group`, topics FROM sheet_rows WHERE domain IS NOT NULL ORDER BY month, row_no',
    ),
    loadMetadata(pool),
    loadCrowd(pool),
  ]);
  const byDomain = new Map<string, typeof labels>();
  for (const r of labels) {
    if (byDomain.get(r.domain)?.[0]?.month !== r.month) byDomain.set(r.domain, []);
    byDomain.get(r.domain)?.push(r);
  }
  return domains
    .map(({ domain }) => {
      const sheet = byDomain.get(domain) ?? [];
      const manual = overrides.get(domain);
      const base = manual?.topics ?? latestTopics(sheet);
      return {
        domain,
        name: manual?.name ?? sheet.at(-1)?.name ?? domain,
        topics: shownTags(base, crowd.get(domain)),
        baseTopics: base,
        revision: manual?.revision ?? 0,
        custom: manual?.name != null || manual?.topics != null,
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

type Edit = { domain: string; name: string; topics: string; revision: number };
/** Lock manual records in stable order. Batch modifications use the latest values, not a stale form snapshot. */
export async function editSites(pool: Pool, email: string, input: { single: Edit } | { domains: string[]; add: string; remove: string }) {
  const domains = [...new Set('single' in input ? [input.single.domain] : input.domains)].sort();
  if (!domains.length || domains.length > 200) throw new EditError('請選擇 1 至 200 個網站。');
  const conn = await pool.getConnection();
  try {
    await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await conn.beginTransaction();
    const known = new Set((await managedSites(conn)).map((s) => s.domain));
    if (domains.some((d) => !known.has(d))) throw new EditError('包含不存在的網域，請先加入追蹤。');
    for (const domain of domains) {
      await conn.query(
        `INSERT INTO site_metadata (domain, updated_at, updated_by) VALUES (?, NOW(), ?)
        ON DUPLICATE KEY UPDATE domain = VALUES(domain)`,
        [domain, email],
      );
    }
    const sites = new Map((await managedSites(conn)).map((s) => [s.domain, s]));
    const before = await loadMetadata(conn);
    const add = 'single' in input ? [] : parseTopics(input.add);
    const remove = 'single' in input ? [] : parseTopics(input.remove);
    if (add.some((t) => remove.includes(t))) throw new EditError('同一標籤不能同時新增與移除。');
    if (!('single' in input) && !add.length && !remove.length) throw new EditError('請填寫要新增或移除的標籤。');
    for (const domain of domains) {
      const site = sites.get(domain) as ManagedSite;
      const old = before.get(domain) as Metadata;
      let name = old.name;
      let topics: string[];
      if ('single' in input) {
        if (input.single.revision !== old.revision) throw new EditError('資料已被其他編輯更新，請重新開啟編輯頁後再修改。', 409);
        name = input.single.name.trim() || null;
        if (name && (name.length > 128 || [...name].some((c) => c < ' ' || c.charCodeAt(0) === 127)))
          throw new EditError('網站名稱最多 128 字，不能包含控制字元。');
        topics = parseTopics(input.single.topics);
      } else {
        topics = parseTopics([...site.baseTopics.filter((t) => !remove.includes(t)), ...add].join(','));
      }
      await conn.query(
        'UPDATE site_metadata SET name = ?, topics = ?, revision = revision + 1, updated_at = NOW(), updated_by = ? WHERE domain = ?',
        [name, JSON.stringify(topics), email, domain],
      );
      await conn.query('INSERT INTO site_metadata_log (domain, at, email, before_value, after_value) VALUES (?, NOW(), ?, ?, ?)', [
        domain,
        email,
        JSON.stringify(old),
        JSON.stringify({ domain, name, topics, revision: old.revision + 1 }),
      ]);
    }
    await conn.commit();
    return domains.length;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
