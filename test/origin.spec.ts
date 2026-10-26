import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loginConfig } from '../src/login.ts';
import { publicOrigin, registerLegacyOrigin } from '../src/origin.ts';

describe('網站雷達 domain migration', () => {
  const server = (origin = 'https://site.observe.tw') => {
    const app = Fastify();
    registerLegacyOrigin(app, origin);
    app.get('/*', async () => 'ok');
    return app;
  };

  it('permanently redirects old links while preserving the path and encoded query', async () => {
    const app = server();
    const path = '/site/example.tw/?tag=%E6%96%B0%E8%81%9E&next=%2Ftable%2F';
    const res = await app.inject({ url: path, headers: { host: 'traffic.observe.tw' } });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe(`https://site.observe.tw${path}`);
    await app.close();
  });

  it('leaves the new host, local callers and internal authentication alone', async () => {
    const app = server();
    for (const host of ['site.observe.tw', 'localhost:18150', '127.0.0.1:18150', 'traffic.observe.tw.evil.test']) {
      const res = await app.inject({ url: '/', headers: { host, 'x-forwarded-host': 'traffic.observe.tw' } });
      expect(res.statusCode, host).toBe(200);
    }
    const internal = await app.inject({ url: '/internal/v1/traffic', headers: { host: 'traffic.observe.tw' } });
    expect(internal.headers.location).toBeUndefined();
    await app.close();
  });

  it('keeps the old host usable until the configured public origin is switched', async () => {
    const app = server('https://traffic.observe.tw');
    const res = await app.inject({ url: '/', headers: { host: 'traffic.observe.tw' } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('uses the new domain for default canonical links and Google callbacks', () => {
    expect(publicOrigin({})).toBe('https://site.observe.tw');
    expect(loginConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })?.origin).toBe('https://site.observe.tw');
  });
});
