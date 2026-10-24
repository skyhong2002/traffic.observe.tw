// Copy from blog's database (read only): each verified blog's last successful technology snapshot (blog_tech_scans),
// on its domain (canonical_host), as origin 'blog'. The worker rescans these first after the never-checked domains and
// its own result replaces them. Domains this service has already scanned itself are left alone; detections of products
// tech.ts does not list are dropped. Safe to rerun.
//   node --env-file=.env --env-file=$HOME/.config/blog-observe.env tools/import-blog-tech.ts [--dry-run]
import { createPool, rows } from '../src/db.ts';
import { publicDomain } from '../src/similarweb.ts';
import { PRODUCTS, safeSourceUrl, type TechDetection } from '../src/tech.ts';
import { loadTech, saveObservation } from '../src/tech-scan.ts';

const dry = process.argv.includes('--dry-run');
const blog = createPool(process.env.BLOG_DB_URL, { size: 2 });
const pool = createPool();
try {
  const list = await rows<{
    host: string;
    detections: TechDetection[] | string | null;
    source_url: string | null;
    rule_version: string;
    observed_at: Date;
  }>(
    blog,
    `SELECT b.canonical_host AS host, s.detections, s.source_url, s.rule_version, s.observed_at
     FROM blog_tech_scans s JOIN blogs b ON b.id = s.blog_id AND b.status = 'verified'
     WHERE s.observed_at IS NOT NULL ORDER BY s.observed_at`,
  );
  const ours = await loadTech(pool);
  const tally = { snapshots: list.length, imported: 0, ownScan: 0, badDomain: [] as string[], droppedDetections: 0 };
  for (const r of list) {
    const domain = publicDomain(r.host);
    if (!domain) {
      tally.badDomain.push(r.host);
      continue;
    }
    if (ours.get(domain)?.origin === 'traffic') {
      tally.ownScan++;
      continue;
    }
    const all = (typeof r.detections === 'string' ? JSON.parse(r.detections) : (r.detections ?? [])) as TechDetection[];
    const detections = all.filter((d) => PRODUCTS.has(d.id));
    tally.droppedDetections += all.length - detections.length;
    const at = r.observed_at.toISOString();
    tally.imported++;
    if (!dry)
      await saveObservation(
        pool,
        domain,
        {
          status: detections.length ? 'detected' : 'unknown',
          sourceUrl: r.source_url ? safeSourceUrl(r.source_url) : null,
          httpStatus: null,
          errorCode: null,
          ruleVersion: r.rule_version,
          at,
          detections: detections.map((d) => ({ ...d, ...PRODUCTS.get(d.id), observedAt: at })),
        },
        'blog',
      );
  }
  console.log(JSON.stringify({ dry, ...tally }));
} finally {
  await blog.end();
  await pool.end();
}
