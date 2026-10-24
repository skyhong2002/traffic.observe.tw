import type { PoolConnection } from 'mysql2/promise';
import { type Pool, rows } from './db.ts';
import { EditError } from './metadata.ts';

// Months copied by hand from the Similarweb platform (pro.similarweb.com) for
// domains the free data endpoint does not estimate. A free account sees only
// the latest month, so each month has to be entered while it is shown.

export interface ManualMonth {
  domain: string;
  month: string;
  /** Visits, not millions. */
  visits: number;
  searchShare: number | null;
  aiShare: number | null;
  taiwanShare: number | null;
  updatedAt: string;
  updatedBy: string;
}

/** The platform's page for one domain, worldwide, latest month. */
export const proUrl = (domain: string) =>
  `https://pro.similarweb.com/#/digitalsuite/websiteanalysis/overview/website-performance/*/999/1m?webSource=Total&key=${encodeURIComponent(domain)}`;

/** The months before the current one (Taipei time), newest first: the platform shows a month once it has ended. */
export function recentMonths(now = new Date(), count = 3) {
  const [y, m] = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 2 - i, 1));
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

const UNITS: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
/** "60.10M", "950K", "1.2B" or a plain count such as "60,100,000"; the platform shows the first form. */
export function parseVisits(value: unknown) {
  const text = String(value ?? '')
    .trim()
    .replace(/,/g, '')
    .toUpperCase();
  const m = /^(\d+(?:\.\d+)?)\s*([KMB])?$/.exec(text);
  if (!m) throw new EditError('月造訪量請照 Similarweb 平台的寫法填，例如 60.10M。');
  const visits = Math.round(Number(m[1]) * (m[2] ? UNITS[m[2]] : 1));
  if (!m[2] && visits < 1000) throw new EditError('月造訪量請加上單位 K、M 或 B，例如 60.10M。');
  if (!(visits > 0) || visits > 1e12) throw new EditError('月造訪量不正確。');
  return visits;
}
/** "36.45%" or "36.45" → 0.3645; empty → null (not entered). */
export function parseShare(value: unknown, label: string) {
  const text = String(value ?? '')
    .trim()
    .replace(/%$/, '');
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new EditError(`${label}請填 0 到 100 的百分比。`);
  return n / 100;
}

const toMonth = (r: {
  domain: string;
  month: string;
  visits: number | string;
  search_share: number | null;
  ai_share: number | null;
  taiwan_share: number | null;
  updated_at: Date;
  updated_by: string;
}): ManualMonth => ({
  domain: r.domain,
  month: r.month,
  visits: Number(r.visits),
  searchShare: r.search_share,
  aiShare: r.ai_share,
  taiwanShare: r.taiwan_share,
  updatedAt: r.updated_at.toISOString(),
  updatedBy: r.updated_by,
});

export async function loadManualMonths(pool: Pick<Pool, 'query'>, { domain, months }: { domain?: string; months?: string[] } = {}) {
  if (months && !months.length) return [];
  const where = [domain ? 'domain = ?' : '', months ? 'month IN (?)' : ''].filter(Boolean);
  const list = await rows<Parameters<typeof toMonth>[0]>(
    pool,
    `SELECT domain, month, visits, search_share, ai_share, taiwan_share, updated_at, updated_by FROM manual_months${
      where.length ? ` WHERE ${where.join(' AND ')}` : ''
    } ORDER BY domain, month`,
    [...(domain ? [domain] : []), ...(months ? [months] : [])],
  );
  return list.map(toMonth);
}

type Entry = Pick<ManualMonth, 'domain' | 'month' | 'visits' | 'searchShare' | 'aiShare' | 'taiwanShare'>;

/** Saves one month, or removes it when `entry` is null; every change is logged with its previous value. */
export async function setManualMonth(pool: Pool, email: string, domain: string, month: string, entry: Entry | null) {
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(month)) throw new EditError('月份不正確。');
  const conn: PoolConnection = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [before] = (await conn.query('SELECT * FROM manual_months WHERE domain = ? AND month = ? FOR UPDATE', [domain, month])) as [
      Parameters<typeof toMonth>[0][],
      unknown,
    ];
    const now = new Date();
    if (entry)
      await conn.query(
        `INSERT INTO manual_months (domain, month, visits, search_share, ai_share, taiwan_share, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE visits = VALUES(visits), search_share = VALUES(search_share), ai_share = VALUES(ai_share),
           taiwan_share = VALUES(taiwan_share), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
        [domain, month, entry.visits, entry.searchShare, entry.aiShare, entry.taiwanShare, now, email],
      );
    else if (before.length) await conn.query('DELETE FROM manual_months WHERE domain = ? AND month = ?', [domain, month]);
    else throw new EditError('這個月份沒有補登資料。', 404);
    const value = (e: Entry | null) =>
      e && JSON.stringify({ visits: e.visits, searchShare: e.searchShare, aiShare: e.aiShare, taiwanShare: e.taiwanShare });
    await conn.query('INSERT INTO manual_months_log (domain, month, at, email, before_value, after_value) VALUES (?, ?, ?, ?, ?, ?)', [
      domain,
      month,
      now,
      email,
      value(before[0] ? toMonth(before[0]) : null),
      value(entry),
    ]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Domains to fill in by hand: the free endpoint answered 0 for every month of
 * its latest reply, and the site is large enough to matter (the sheet once
 * had at least a million visits for it) or already has entries.
 */
export async function manualCandidates(pool: Pick<Pool, 'query'>) {
  const list = await rows<{
    domain: string;
    sheet_month: string | null;
    sheet_visits: number | null;
    manual_month: string | null;
    manual_visits: number | string | null;
  }>(
    pool,
    `SELECT z.domain,
       (SELECT s.month FROM sheet_rows s WHERE s.domain = z.domain AND s.visits IS NOT NULL AND s.adjusted = 0 ORDER BY s.month DESC LIMIT 1) AS sheet_month,
       (SELECT s.visits FROM sheet_rows s WHERE s.domain = z.domain AND s.visits IS NOT NULL AND s.adjusted = 0 ORDER BY s.month DESC LIMIT 1) AS sheet_visits,
       (SELECT m.month FROM manual_months m WHERE m.domain = z.domain ORDER BY m.month DESC LIMIT 1) AS manual_month,
       (SELECT m.visits FROM manual_months m WHERE m.domain = z.domain ORDER BY m.month DESC LIMIT 1) AS manual_visits
     FROM (
       SELECT t.domain FROM traffic_months t
       JOIN (SELECT domain, MAX(fetched_at) AS at FROM traffic_months GROUP BY domain) latest
         ON latest.domain = t.domain AND latest.at = t.fetched_at
       GROUP BY t.domain HAVING MAX(t.visits) = 0
     ) z
     WHERE EXISTS (SELECT 1 FROM sheet_rows s WHERE s.domain = z.domain AND s.visits >= 1 AND s.adjusted = 0)
        OR EXISTS (SELECT 1 FROM manual_months m WHERE m.domain = z.domain)
     ORDER BY sheet_visits DESC, z.domain`,
  );
  return list.map((r) => ({
    domain: r.domain,
    sheet: r.sheet_month ? { month: r.sheet_month, visits: r.sheet_visits } : null,
    manual: r.manual_month ? { month: r.manual_month, visits: Number(r.manual_visits) / 1e6 } : null,
  }));
}
