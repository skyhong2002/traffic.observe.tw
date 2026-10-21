// Compares the sheet's figures with stored Similarweb data for the same
// domain and month: visits, search share (organic, and organic + paid) and AI
// share. Shows whether the sheet's 搜尋S/AI can be reproduced automatically.
// 2026-10-21: visits 81/85 (202607), 95/98 (202608), 37/38 (202609) within 1%;
// 202609 search = organic 33/35 (organic + paid 12/35), AI 34/35. Similarweb
// gives tw.news.yahoo.com no visits; the sheet's figure for it comes from elsewhere.
//   node --env-file=.env tools/backtest-sheet.ts [YYYYMM…]
import { createPool, rows } from '../src/db.ts';
import type { TrafficProfile } from '../src/similarweb.ts';

const pool = createPool();
const close = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
try {
  const months = process.argv.slice(2).length ? process.argv.slice(2) : ['202608', '202609'];
  for (const month of months) {
    const list = await rows<{
      domain: string;
      name: string;
      visits: number | null;
      search_share: number | null;
      ai_share: number | null;
      sw: number | null;
      profile: unknown;
    }>(
      pool,
      `SELECT s.domain, s.name, s.visits, s.search_share, s.ai_share, m.visits AS sw, p.profile
       FROM sheet_rows s
       LEFT JOIN traffic_months m ON m.domain = s.domain AND m.month = s.month
       LEFT JOIN traffic_profiles p ON p.domain = s.domain AND p.month = s.month
       WHERE s.month = ? AND s.adjusted = 0 AND s.domain IS NOT NULL`,
      [month],
    );
    const v = list.filter((r) => r.visits !== null && r.sw !== null);
    const vOk = v.filter((r) => close(r.visits as number, (r.sw as number) / 1e6, Math.max(0.0015, (r.visits as number) * 0.01)));
    const p = list
      .map((r) => ({
        ...r,
        prof: r.profile ? ((typeof r.profile === 'string' ? JSON.parse(r.profile) : r.profile) as TrafficProfile) : null,
      }))
      .filter((r) => r.prof && r.search_share !== null);
    const organic = p.filter((r) => close(r.search_share as number, r.prof?.channels.SearchOrganic ?? -1, 0.0006));
    const both = p.filter((r) =>
      close(r.search_share as number, (r.prof?.channels.SearchOrganic ?? 0) + (r.prof?.channels.SearchPaid ?? 0), 0.0006),
    );
    const ai = p.filter((r) => r.ai_share !== null && r.prof?.channels.GenAi !== undefined);
    const aiOk = ai.filter((r) => close(r.ai_share as number, r.prof?.channels.GenAi as number, 0.0006));
    console.log(
      `${month}: visits ${vOk.length}/${v.length} within 1%; search share = organic ${organic.length}/${p.length}, organic+paid ${both.length}/${p.length}; AI ${aiOk.length}/${ai.length}`,
    );
    for (const r of v.filter((r) => !vOk.includes(r)).slice(0, 8))
      console.log(`  visits differ: ${r.name} ${r.domain} sheet ${r.visits} vs ${((r.sw as number) / 1e6).toFixed(3)}`);
    for (const r of p.filter((r) => !organic.includes(r) && !both.includes(r)).slice(0, 5))
      console.log(
        `  search differs: ${r.name} ${r.domain} sheet ${r.search_share} vs organic ${r.prof?.channels.SearchOrganic} paid ${r.prof?.channels.SearchPaid}`,
      );
  }
} finally {
  await pool.end();
}
