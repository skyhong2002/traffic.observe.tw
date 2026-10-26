import type { PoolConnection } from 'mysql2/promise';
import { type Pool, rows } from './db.ts';
import { breakdownValues, parseBreakdowns, parseReportedPercent } from './manual-breakdowns.ts';
import { EditError } from './metadata.ts';
import type { TrafficChannel, TrafficProfile } from './similarweb.ts';

// Months copied by hand from the Similarweb platform (pro.similarweb.com) for
// domains the free data endpoint does not estimate. A free account sees only
// the latest month, so each month has to be entered while it is shown.

export const manualChannels = [
  ['Direct', '直接造訪（Direct）'],
  ['Referrals', '其他網站連入（Referral）'],
  ['SocialOrganic', '自然社群（Organic Social）'],
  ['SocialPaid', '社群廣告（Paid Social）'],
  ['SearchPaid', '搜尋廣告（Paid Search）'],
  ['Mail', '電子郵件（Email）'],
  ['DisplayAds', '展示廣告（Display Ads）'],
  ['Affiliate', '聯盟行銷（Affiliate）'],
] as const;
export function parseManualChannels(body: Record<string, unknown>) {
  const channels: Partial<Record<TrafficChannel, number>> = {};
  for (const [key, label] of manualChannels) {
    const value = parseShare(body[key], label);
    if (value !== null) channels[key] = value;
  }
  for (const [key, totalKey] of [
    ['Referrals', 'referralTotal'],
    ['DisplayAds', 'displayTotal'],
  ] as const) {
    const total = parseReportedPercent(body[totalKey]);
    if (total?.bound === null) {
      if (channels[key] !== undefined && Math.abs(channels[key] - total.value) > 0.001)
        throw new EditError(`${key} 渠道占比與明細總占比不一致。`);
      channels[key] ??= total.value;
    }
  }
  return channels;
}

export type ManualDetails = Omit<TrafficProfile, 'month' | 'channels' | 'source'>;
export const manualDetailFields = [
  ['bounce', '跳出率', '百分比，例如 42.5', '%'],
  ['pages', '每次造訪頁數', '例如 3.25', '頁'],
  ['duration', '平均停留時間', '秒數或時:分:秒，例如 125 或 00:02:05', ''],
  ['globalRank', '全球排名', '正整數，例如 1234', ''],
  ['countryCode', '排名國家', '兩碼國家代碼，例如 TW', ''],
  ['countryRank', '國家排名', '該國家的網站排名', ''],
  ['category', '排名分類', '平台顯示的分類名稱', ''],
  ['categoryRank', '分類排名', '該分類的網站排名', ''],
] as const;

export function parseManualDetails(body: Record<string, unknown>): ManualDetails {
  const positive = (key: string, integer = false) => {
    const text = String(body[key] ?? '')
      .trim()
      .replace(/,/g, '');
    if (!text) return null;
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isSafeInteger(n)))
      throw new EditError(`${manualDetailFields.find(([k]) => k === key)?.[1] ?? key}請填${integer ? '正整數' : '大於 0 的數字'}。`);
    return n;
  };
  let duration = String(body.duration ?? '').trim();
  if (duration.includes(':')) {
    if (!/^\d+:[0-5]\d:[0-5]\d$/.test(duration)) throw new EditError('平均停留時間請填秒數或時:分:秒。');
    const [h, m, sec] = duration.split(':').map(Number);
    duration = String(h * 3600 + m * 60 + sec);
  }
  const timeOnSite = duration ? Number(duration) : null;
  if (timeOnSite !== null && (!Number.isFinite(timeOnSite) || timeOnSite < 0)) throw new EditError('平均停留時間請填非負秒數。');
  const countryCode = String(body.countryCode ?? '')
    .trim()
    .toUpperCase();
  const countryRank = positive('countryRank', true);
  if ((countryCode || countryRank !== null) && (!/^[A-Z]{2}$/.test(countryCode) || countryRank === null))
    throw new EditError('國家排名請同時填兩碼國家代碼與排名。');
  const category = String(body.category ?? '').trim();
  const categoryRank = positive('categoryRank', true);
  if ((category || categoryRank !== null) && (!category || category.length > 128 || categoryRank === null))
    throw new EditError('分類排名請同時填分類名稱（最多 128 字）與排名。');
  const countries: TrafficProfile['countries'] = [];
  const countryText = String(body.countries ?? '').trim();
  if (countryText.length > 8000) throw new EditError('國家占比內容過長。');
  for (const line of countryText.split(/\r?\n/).filter((v) => v.trim())) {
    const match = /^\s*([a-z]{2})[\s,]+(\d+(?:\.\d+)?%?)\s*$/i.exec(line);
    if (!match) throw new EditError('國家占比請每行填國家代碼與百分比，例如 TW 61.57。');
    const code = match[1].toUpperCase();
    if (countries.some((c) => c.code === code)) throw new EditError('國家代碼不能重複。');
    countries.push({ code, share: parseShare(match[2], '國家占比') as number });
  }
  const tw = parseShare(body.taiwan, '台灣占比');
  const listedTw = countries.find((c) => c.code === 'TW');
  if (listedTw && tw !== null && Math.abs(listedTw.share - tw) > 1e-9) throw new EditError('台灣占比與國家列表的 TW 不一致。');
  if (!listedTw && tw !== null) countries.push({ code: 'TW', share: tw });
  if (countries.reduce((sum, c) => sum + c.share, 0) > 1.001) throw new EditError('國家占比合計不能超過 100%。');
  return {
    breakdowns: parseBreakdowns(body),
    countries: countries.sort((a, b) => b.share - a.share),
    bounceRate: parseShare(body.bounce, '跳出率'),
    pagesPerVisit: positive('pages'),
    timeOnSite,
    globalRank: positive('globalRank', true),
    countryRank: countryRank === null ? null : { code: countryCode, rank: countryRank },
    categoryRank: categoryRank === null ? null : { category, rank: categoryRank },
  };
}

export function manualProfile(
  entry: Pick<ManualMonth, 'month' | 'channels' | 'details' | 'searchShare' | 'aiShare' | 'taiwanShare'>,
): TrafficProfile {
  const details = entry.details ?? parseManualDetails({ taiwan: entry.taiwanShare === null ? '' : entry.taiwanShare * 100 });
  return {
    ...details,
    month: entry.month,
    source: 'manual',
    channels: {
      ...entry.channels,
      ...(entry.searchShare === null ? {} : { SearchOrganic: entry.searchShare }),
      ...(entry.aiShare === null ? {} : { GenAi: entry.aiShare }),
    },
  };
}

export function manualDetailValues(entry?: ManualMonth): Record<string, string> {
  const p = entry?.details;
  return {
    ...breakdownValues(p?.breakdowns),
    bounce: p?.bounceRate == null ? '' : String(p.bounceRate * 100),
    pages: String(p?.pagesPerVisit ?? ''),
    duration: String(p?.timeOnSite ?? ''),
    globalRank: String(p?.globalRank ?? ''),
    countryCode: p?.countryRank?.code ?? '',
    countryRank: String(p?.countryRank?.rank ?? ''),
    category: p?.categoryRank?.category ?? '',
    categoryRank: String(p?.categoryRank?.rank ?? ''),
    countries: p?.countries.map((c) => `${c.code} ${Number((c.share * 100).toFixed(6))}`).join('\n') ?? '',
  };
}

export interface ManualMonth {
  domain: string;
  month: string;
  /** Visits, not millions. */
  visits: number;
  channels: Partial<Record<TrafficChannel, number>>;
  details: ManualDetails | null;
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
  channels: ManualMonth['channels'] | string | null;
  details: ManualDetails | string | null;
  search_share: number | null;
  ai_share: number | null;
  taiwan_share: number | null;
  updated_at: Date;
  updated_by: string;
}): ManualMonth => ({
  domain: r.domain,
  month: r.month,
  visits: Number(r.visits),
  channels: (typeof r.channels === 'string' ? JSON.parse(r.channels) : r.channels) ?? {},
  details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
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
    `SELECT domain, month, visits, channels, details, search_share, ai_share, taiwan_share, updated_at, updated_by FROM manual_months${
      where.length ? ` WHERE ${where.join(' AND ')}` : ''
    } ORDER BY domain, month`,
    [...(domain ? [domain] : []), ...(months ? [months] : [])],
  );
  return list.map(toMonth);
}

type Entry = Pick<ManualMonth, 'domain' | 'month' | 'visits' | 'details' | 'channels' | 'searchShare' | 'aiShare' | 'taiwanShare'>;

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
        `INSERT INTO manual_months (domain, month, visits, search_share, ai_share, taiwan_share, updated_at, updated_by, channels, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE details = VALUES(details), channels = VALUES(channels), visits = VALUES(visits), search_share = VALUES(search_share), ai_share = VALUES(ai_share),
           taiwan_share = VALUES(taiwan_share), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
        [
          domain,
          month,
          entry.visits,
          entry.searchShare,
          entry.aiShare,
          entry.taiwanShare,
          now,
          email,
          JSON.stringify(entry.channels),
          JSON.stringify(entry.details),
        ],
      );
    else if (before.length) await conn.query('DELETE FROM manual_months WHERE domain = ? AND month = ?', [domain, month]);
    else throw new EditError('這個月份沒有補登資料。', 404);
    const value = (e: Entry | null) =>
      e &&
      JSON.stringify({
        visits: e.visits,
        channels: e.channels,
        details: e.details,
        searchShare: e.searchShare,
        aiShare: e.aiShare,
        taiwanShare: e.taiwanShare,
      });
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
