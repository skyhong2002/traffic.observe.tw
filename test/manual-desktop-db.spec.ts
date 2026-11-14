import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { coverageFields } from '../src/collection.ts';
import { createPool, migrate, type Pool, rows } from '../src/db.ts';
import { recentMonths } from '../src/manual.ts';
import { monthView } from '../src/metrics.ts';
import { saveSheet } from '../src/sheet.ts';

const url = process.env.TRAFFIC_TEST_DB_URL;
describe.skipIf(!url)('manual desktop-only channels', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(url, { multipleStatements: true });
    const tables = await rows<{ t: string }>(pool, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE()');
    for (const { t } of tables) await pool.query(`DROP TABLE \`${t}\``);
    await migrate(pool);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
  });

  it('saves, reloads, audits and presents desktop shares without changing all-device metrics', async () => {
    const origin = 'https://traffic.example';
    const server = buildApp(pool, {
      login: { clientId: 'cid', clientSecret: 'secret', origin, admins: new Set(['editor@example.com']) },
      logger: false,
    });
    try {
      const cookie = 'traffic_session=desktop-editor';
      await pool.query('INSERT INTO sessions (token_hash,email,created_at,expires_at) VALUES (?,?,NOW(),DATE_ADD(NOW(),INTERVAL 1 DAY))', [
        createHash('sha256').update('desktop-editor').digest('hex'),
        'editor@example.com',
      ]);
      const [month] = recentMonths();
      const domain = 's3.example.tw';
      await saveSheet(pool, [
        {
          rowNo: 2,
          month,
          domain,
          name: 'Desktop fixture',
          group: null,
          topics: '',
          url: null,
          visits: 0,
          searchShare: null,
          aiShare: null,
          taiwanShare: null,
          adjusted: false,
          raw: {},
        },
      ]);
      const entry = {
        month,
        visits: '482.4K',
        taiwan: '93.23',
        countries: 'TW 93.23\nUS 2.13\nHK 1.59\nID 0.58\nMY 0.57',
        bounce: '71.01',
        pages: '5.66',
        duration: '00:00:57',
        desktop_SearchOrganic: '38.72',
        desktop_SocialPaid: '20.48',
        desktop_Direct: '13.09',
        desktop_SearchPaid: '8.79',
        desktop_SocialOrganic: '6.08',
        desktop_Affiliate: '4.67',
        desktop_Referrals: '3.47',
        desktop_DisplayAds: '2.36',
        desktop_Mail: '2.07',
        desktop_GenAi: '0.27',
      };
      const post = (payload: Record<string, string>) =>
        server.inject({
          method: 'POST',
          url: `/site/${domain}/manual/`,
          headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams(payload).toString(),
        });
      const rejected = await post({ ...entry, desktop_Direct: '101' });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).toContain('name="desktop_Direct" aria-invalid="true"');
      expect(rejected.body).toContain('name="desktop_SearchOrganic" value="38.72"');
      expect((await post(entry)).statusCode).toBe(303);
      const form = (await server.inject({ url: `/site/${domain}/manual/`, headers: { cookie } })).body;
      expect(form).toContain('name="desktop_SearchOrganic" value="38.72"');
      expect(form).toContain('data-desktop_socialpaid="20.48"');
      expect(form).toContain('name="search" value=""');
      const detail = (await server.inject({ url: `/api/v1/sites/${domain}`, headers: { cookie } })).json();
      expect(detail.profile.desktopChannels).toMatchObject({ SearchOrganic: 0.3872, SocialPaid: 0.2048, Direct: 0.1309 });
      expect(detail.profile.channels).toEqual({});
      expect(coverageFields(482400, [detail.profile]).missing).toContain('channels.SearchOrganic');
      expect((await monthView(pool, month)).find((site) => site.domain === domain)).toMatchObject({
        searchShare: null,
        aiShare: null,
        channels: {},
      });
      const page = (await server.inject({ url: `/site/${domain}/`, headers: { cookie } })).body;
      expect(page).toContain('桌面限定流量來源');
      expect(page).toContain('38.72%');
      expect(page).toContain('不換算造訪次數');
      const guest = (await server.inject(`/api/v1/sites/${domain}`)).json();
      expect(guest.profile.desktopChannels).toBeUndefined();
      expect(guest.manualProfiles).toBeUndefined();
      // The independent platform data remains available when an automatic estimate wins.
      await pool.query('INSERT INTO traffic_months (domain,month,visits,first_seen_at,fetched_at) VALUES (?,?,1000000,NOW(),NOW())', [
        domain,
        month,
      ]);
      const withFree = (await server.inject({ url: `/api/v1/sites/${domain}`, headers: { cookie } })).json();
      expect(withFree.manualProfiles[0].desktopChannels.SearchOrganic).toBe(0.3872);
      expect((await server.inject({ url: `/site/${domain}/`, headers: { cookie } })).body).toContain('38.72%');
      const logs = await rows<{ after_value: string | { details: unknown } }>(pool, 'SELECT after_value FROM manual_months_log');
      const saved = typeof logs[0].after_value === 'string' ? JSON.parse(logs[0].after_value) : logs[0].after_value;
      expect(saved.details.desktopChannels.SearchOrganic).toBe(0.3872);
      expect(saved.searchShare).toBeNull();
    } finally {
      await server.close();
    }
  }, 30_000);
});
