import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { Pool } from '../src/db.ts';
import { registerSeo } from '../src/seo.ts';

// None of these routes reads the database.
const app = () => buildApp({} as Pool, { tokens: new Map(), login: null, logger: false });

describe('robots.txt and sitemap', () => {
  it('points crawlers at the sitemap and keeps them off service and sign-in routes', async () => {
    const res = await app().inject('/robots.txt');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['x-robots-tag']).toBeUndefined();
    expect(res.body).toContain('Disallow: /internal/\nDisallow: /auth/\n');
    expect(res.body).toContain('Sitemap: https://traffic.observe.tw/sitemap.xml');
    expect(res.body).not.toMatch(/Disallow: \/api\//);
  });

  it('lists only the public entry pages', async () => {
    const res = await app().inject('/sitemap.xml');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/xml/);
    expect([...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual([
      'https://traffic.observe.tw/',
      'https://traffic.observe.tw/table/',
      'https://traffic.observe.tw/tag/',
      'https://traffic.observe.tw/tech/',
    ]);
  });
});

describe('head tags and noindex', () => {
  it('gives the report a description and a canonical link without its query string', async () => {
    const res = await app().inject('/?to=202609&q=news');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-robots-tag']).toBeUndefined();
    expect(res.body).toContain('<link rel="canonical" href="https://traffic.observe.tw/">');
    expect(res.body).toMatch(/<meta name="description" content="[^"]+">/);
    expect(res.body).not.toContain('noindex');
  });

  it('marks sign-in pages noindex', async () => {
    const res = await app().inject('/login/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.body).toContain('<meta name="robots" content="noindex">');
    expect(res.body).not.toContain('rel="canonical"');
  });

  it('serves the public API as before, marked noindex', async () => {
    const res = await app().inject('/api/v1/');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('service', 'traffic.observe.tw');
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });

  it('answers unknown routes 404 with noindex, never with the report', async () => {
    for (const url of ['/nope', '/table', '/index.html', '/site/', '/api/v2/']) {
      const res = await app().inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['x-robots-tag'], url).toBe('noindex');
      expect(res.body, url).not.toContain('report-page');
    }
  });

  it('moves the old tags address to /tag/ with its query string', async () => {
    for (const [from, to] of [
      ['/topics/', '/tag/'],
      ['/topics/?topic=%E6%96%B0%E8%81%9E', '/tag/?topic=%E6%96%B0%E8%81%9E'],
    ]) {
      const res = await app().inject(from);
      expect(res.statusCode, from).toBe(301);
      expect(res.headers.location, from).toBe(to);
    }
  });

  it('documents every endpoint the same way in the page, the index and the OpenAPI document', async () => {
    const { ENDPOINTS } = await import('../src/api-docs.ts');
    const page = (await app().inject('/api/')).body;
    const index = (await app().inject('/api/v1/')).json();
    const spec = (await app().inject('/api/v1/openapi.json')).json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).sort()).toEqual(ENDPOINTS.map((e) => e.path).sort());
    expect(Object.keys(index.endpoints)).toHaveLength(ENDPOINTS.length);
    expect(index).toMatchObject({ service: 'traffic.observe.tw', docs: 'https://traffic.observe.tw/api/' });
    for (const e of ENDPOINTS) expect(page, e.path).toContain(`id="api-${e.id}"`);
    // Read-only and public, so browsers on other sites may call it.
    expect((await app().inject('/api/v1/')).headers['access-control-allow-origin']).toBe('*');
    expect((await app().inject('/api/')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps /internal/ a plain 404', async () => {
    const res = await app().inject({ method: 'POST', url: '/internal/v1/traffic', payload: { domains: ['example.com'] } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('gives a found site page a canonical link to its normalised domain, and a missing one noindex', async () => {
    const server = Fastify({ logger: false });
    server.get<{ Params: { domain: string } }>('/site/:domain/', async (request, reply) => {
      reply.type('text/html; charset=utf-8');
      if (request.params.domain.includes('missing')) reply.code(404);
      return '<html><head><title>t</title></head><body></body></html>';
    });
    registerSeo(server, 'https://traffic.observe.tw');
    const found = await server.inject('/site/Example.COM.tw/');
    expect(found.body).toContain('<link rel="canonical" href="https://traffic.observe.tw/site/example.com.tw/">');
    expect(found.headers['x-robots-tag']).toBeUndefined();
    const missing = await server.inject('/site/missing.tw/');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['x-robots-tag']).toBe('noindex');
    expect(missing.body).toContain('<meta name="robots" content="noindex">');
  });
});
