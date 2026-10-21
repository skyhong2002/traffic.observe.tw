// One-time copy from tag's database (read only): every Similarweb month and
// profile tag fetched, the fetch times (so nothing is refetched right away),
// blog's queued lookups, and tag's outlets as requester `tag` (weekly).
// Sheet-seeded (genehong) months are left out; tools/import-sheet.ts keeps the
// sheet itself. Safe to rerun: newer rows win, as in saveTraffic.
//   node --env-file=.env tools/import-tag.ts --tag-db mysql://…/tag_observe
import { createPool, rows } from '../src/db.ts';
import { setWatchList } from '../src/requests.ts';
import type { DomainTraffic, TrafficProfile } from '../src/similarweb.ts';
import { saveTraffic } from '../src/store.ts';

const i = process.argv.indexOf('--tag-db');
const tag = createPool(i > 0 ? process.argv[i + 1] : process.env.TAG_DB_URL, { size: 2 });
const pool = createPool();
try {
  const months = await rows<{ domain: string; month: string; visits: number; fetched_at: Date }>(
    tag,
    "SELECT domain, month, visits, fetched_at FROM media_traffic_months WHERE source = 'similarweb'",
  );
  const profiles = await rows<{ domain: string; month: string; profile: unknown; fetched_at: Date }>(
    tag,
    'SELECT domain, month, profile, fetched_at FROM media_traffic_profiles',
  );
  // One DomainTraffic per domain and fetch time keeps each row's own fetched_at.
  const byKey = new Map<string, DomainTraffic>();
  const entry = (domain: string, at: Date) => {
    const key = `${domain} ${at.toISOString()}`;
    return byKey.get(key) ?? (byKey.set(key, { domain, fetchedAt: at.toISOString(), monthly: [], profiles: {} }).get(key) as DomainTraffic);
  };
  for (const r of months) entry(r.domain, r.fetched_at).monthly.push({ month: r.month, visits: Number(r.visits) });
  for (const r of profiles)
    entry(r.domain, r.fetched_at).profiles[r.month] = (typeof r.profile === 'string' ? JSON.parse(r.profile) : r.profile) as TrafficProfile;
  console.log('traffic', await saveTraffic(pool, [...byKey.values()]));

  const last = new Map<string, Date>();
  for (const r of [...months, ...profiles])
    if (!last.has(r.domain) || (last.get(r.domain) as Date) < r.fetched_at) last.set(r.domain, r.fetched_at);
  for (const [domain, at] of last)
    await pool.query(
      `INSERT INTO fetch_state (domain, last_attempt_at, last_response_at, last_success_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_success_at = GREATEST(COALESCE(last_success_at, 0), VALUES(last_success_at)),
         last_response_at = GREATEST(COALESCE(last_response_at, 0), VALUES(last_response_at)),
         last_attempt_at = GREATEST(COALESCE(last_attempt_at, 0), VALUES(last_attempt_at))`,
      [domain, at, at, at],
    );
  console.log('fetch state', last.size);
  console.log('watch tag', await setWatchList(pool, 'tag', [...last.keys()], 7));

  const lookups = await rows<{
    requester: string;
    domain: string;
    kind: string;
    requested_at: Date;
    status: string;
    attempts: number;
    next_attempt_at: Date | null;
    last_attempt_at: Date | null;
    last_error: string | null;
    fetched_at: Date | null;
    refused_at: Date | null;
    result: unknown;
  }>(tag, 'SELECT * FROM traffic_external_requests');
  for (const r of lookups) {
    await pool.query(
      'INSERT INTO watches (requester, domain, kind, requested_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE requested_at = VALUES(requested_at)',
      [r.requester, r.domain, r.kind, r.requested_at],
    );
    const result = (typeof r.result === 'string' ? JSON.parse(r.result) : r.result) as {
      category?: string;
      similarSites?: string[];
    } | null;
    await pool.query(
      `INSERT INTO fetch_state (domain, last_attempt_at, last_response_at, failures, next_attempt_at, last_error, refused_at, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE result = COALESCE(VALUES(result), result), refused_at = COALESCE(VALUES(refused_at), refused_at),
         last_response_at = GREATEST(COALESCE(last_response_at, 0), COALESCE(VALUES(last_response_at), 0))`,
      [
        r.domain,
        r.last_attempt_at,
        r.fetched_at,
        r.status === 'ok' ? 0 : r.attempts,
        r.status === 'ok' ? null : r.next_attempt_at,
        r.last_error,
        r.refused_at,
        result ? JSON.stringify({ category: result.category ?? null, similarSites: result.similarSites ?? [] }) : null,
      ],
    );
  }
  console.log('lookups', lookups.length);
} finally {
  await Promise.all([tag.end(), pool.end()]);
}
