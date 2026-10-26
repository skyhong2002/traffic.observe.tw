import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { Pool } from '../src/db.ts';
import { visitParts } from '../src/pages.ts';
import { limitRows, publicTraffic, trafficAccess } from '../src/traffic-access.ts';

const profile = {
  visits: 0.123456,
  channels: {
    Direct: 0.123456,
    SearchOrganic: 0.345678,
    Referrals: 0.12345,
    SocialOrganic: 0.12345,
    GenAi: 0.00012345,
    Mail: 0.12,
    SearchPaid: 0.1234,
  },
  countries: [
    { code: 'TW', share: 0.87654 },
    { code: 'US', share: 0.12346 },
  ],
};

describe('traffic visibility', () => {
  it('projects nested profiles and history without changing the cached source or structural values', () => {
    const source = {
      profile,
      profiles: [profile],
      m: { '202609': [0.123456, 0.012345, null, 0.87654, 2, 0.87654, 3, 0.99999, 1] },
      rank: 1234,
    };
    const result = trafficAccess.run(false, () => publicTraffic(source));
    expect(result.profile.visits).toBe(0.12);
    expect(result.profile.countries).toEqual([{ code: 'TW', share: 0.88 }]);
    expect(Object.keys(result.profile.channels)).toEqual(['Direct', 'SearchOrganic', 'Referrals', 'SocialOrganic', 'GenAi']);
    expect(result.profiles[0]).toEqual(result.profile);
    expect(result.m['202609']).toEqual([0.12, 0.012, null, 0.88, 2, 0.88, 3, 1, 1]);
    expect(result.rank).toBe(1234);
    expect(source.profile.visits).toBe(0.123456);
    expect(trafficAccess.run(true, () => publicTraffic(source))).toBe(source);
    expect(trafficAccess.run(false, () => visitParts(0.123456))).toEqual(['120', 'k']);
  });

  it('isolates concurrent guest, ordinary member, sky and gene requests', async () => {
    const hash = (v: string) => createHash('sha256').update(v).digest('hex');
    const users = new Map(['member', 'sky9109', 'genehong'].map((name) => [hash(name), { email: `${name}@gmail.com`, name }]));
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const user = users.get(String(params[0]));
        return [user ? [user] : []];
      },
    } as unknown as Pool;
    const app = buildApp(pool, {
      logger: false,
      login: {
        clientId: 'id',
        clientSecret: 'secret',
        origin: 'https://traffic.example',
        admins: new Set(['sky9109@gmail.com', 'genehong@gmail.com']),
      },
    });
    app.get('/test/traffic', async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { profile, sites: limitRows(Array.from({ length: 45 }, (_, i) => ({ domain: `${i}.example.com` }))) };
    });
    try {
      const responses = await Promise.all(
        ['', 'member', 'sky9109', 'genehong'].map((name) =>
          app.inject({ url: '/test/traffic', headers: name ? { cookie: `traffic_session=${name}` } : {} }),
        ),
      );
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.headers.vary).toBe('Cookie');
      }
      expect(responses.map((r) => r.json().sites.length)).toEqual([30, 30, 45, 45]);
      expect(responses.map((r) => r.json().profile.visits)).toEqual([0.12, 0.12, 0.123456, 0.123456]);
      expect(responses[3].json().profile.channels.Mail).toBe(0.12);
      expect(responses[0].json().profile.channels.Mail).toBeUndefined();
      for (const name of ['member', 'sky9109', 'genehong']) {
        const page = await app.inject({ url: '/', headers: { cookie: `traffic_session=${name}` } });
        expect(page.body).toContain(`const limitedTraffic = ${name === 'member'};`);
        expect(page.body).toContain(`const trafficDigits = ${name === 'member' ? 2 : 4};`);
      }
      const guestPage = await app.inject('/');
      expect(guestPage.body).toContain('const limitedTraffic = true;');
      expect(guestPage.body).toContain('const trafficDigits = 2;');
    } finally {
      await app.close();
    }
  });
});
