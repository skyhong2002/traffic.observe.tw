import { chunk, type Pool, rows } from './db.ts';
import type { DomainTraffic, TrafficProfile, VisitMonth } from './similarweb.ts';

// Only a newer fetch may overwrite a value, so replaying an old snapshot never
// undoes a revision; first_seen_at keeps the first sighting. Rows are
// idempotent, so saving the same fetch twice is harmless.
export async function saveTraffic(pool: Pool, domains: DomainTraffic[]) {
  const months = domains.flatMap((row) =>
    row.monthly.map((p) => [row.domain, p.month, Math.round(p.visits), new Date(row.fetchedAt), new Date(row.fetchedAt)]),
  );
  const profiles = domains.flatMap((row) =>
    Object.values(row.profiles).map((p) => [row.domain, p.month, JSON.stringify(p), new Date(row.fetchedAt), new Date(row.fetchedAt)]),
  );
  // MariaDB applies SET left to right with updated values, so fetched_at changes last.
  for (const part of chunk(months))
    await pool.query(
      `INSERT INTO traffic_months (domain, month, visits, first_seen_at, fetched_at) VALUES ?
       ON DUPLICATE KEY UPDATE visits = IF(VALUES(fetched_at) >= fetched_at, VALUES(visits), visits),
       fetched_at = GREATEST(fetched_at, VALUES(fetched_at))`,
      [part],
    );
  for (const part of chunk(profiles))
    await pool.query(
      `INSERT INTO traffic_profiles (domain, month, profile, first_seen_at, fetched_at) VALUES ?
       ON DUPLICATE KEY UPDATE profile = IF(VALUES(fetched_at) >= fetched_at, VALUES(profile), profile),
       fetched_at = GREATEST(fetched_at, VALUES(fetched_at))`,
      [part],
    );
  return { months: months.length, profiles: profiles.length };
}

const parse = <T>(value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as T;

/** Every stored month and profile of the given domains (all domains when omitted). */
export async function loadTraffic(pool: Pool, domains?: string[]): Promise<Map<string, DomainTraffic>> {
  if (domains && !domains.length) return new Map();
  const where = domains ? 'WHERE domain IN (?)' : '';
  const params = domains ? [domains] : [];
  const [months, profiles] = await Promise.all([
    rows<{ domain: string; month: string; visits: number; fetched_at: Date }>(
      pool,
      `SELECT domain, month, visits, fetched_at FROM traffic_months ${where} ORDER BY domain, month`,
      params,
    ),
    rows<{ domain: string; month: string; profile: unknown }>(
      pool,
      `SELECT domain, month, profile FROM traffic_profiles ${where} ORDER BY domain, month`,
      params,
    ),
  ]);
  const out = new Map<string, DomainTraffic>();
  const entry = (domain: string) =>
    out.get(domain) ??
    (out.set(domain, { domain, fetchedAt: new Date(0).toISOString(), monthly: [], profiles: {} }).get(domain) as DomainTraffic);
  for (const row of months) {
    const value = entry(row.domain);
    value.monthly.push({ month: row.month, visits: Number(row.visits) } satisfies VisitMonth);
    if (row.fetched_at.toISOString() > value.fetchedAt) value.fetchedAt = row.fetched_at.toISOString();
  }
  for (const row of profiles) entry(row.domain).profiles[row.month] = parse<TrafficProfile>(row.profile);
  return out;
}

/** Months with Similarweb visits, newest first. */
export async function trafficMonths(pool: Pool) {
  return (await rows<{ month: string }>(pool, 'SELECT DISTINCT month FROM traffic_months ORDER BY month DESC')).map((r) => r.month);
}
