import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

// Only packaged brand assets are public; request parameters never become file paths.
const names = [
  ...['horizontal', 'stacked', 'mark'].flatMap((layout) =>
    ['dark', 'light', 'black', 'white'].flatMap((color) => [
      `logo-${layout}-${color}.svg`,
      ...(['dark', 'light'].includes(color) ? [`logo-${layout}-${color}.png`] : []),
    ]),
  ),
  'favicon.svg',
  'favicon.ico',
  'app-icon.svg',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
];
const types: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' };
const assets = new Map(
  names.map((name) => {
    const body = readFileSync(new URL(`../assets/brand/${name}`, import.meta.url));
    return [name, { body, type: types[name.split('.').pop()!], hash: createHash('sha256').update(body).digest('hex').slice(0, 10) }];
  }),
);
const href = (name: string) => `/brand/${name}?v=${assets.get(name)!.hash}`;

export const BRAND = `<img class="brand-logo" src="${href('logo-horizontal-dark.svg')}" width="292" height="72" alt="臺灣流量觀察站">`;
export const BRAND_HEAD = `<link rel="icon" type="image/svg+xml" href="${href('favicon.svg')}"><link rel="icon" type="image/x-icon" sizes="16x16 32x32 48x48 64x64" href="${href('favicon.ico')}"><link rel="apple-touch-icon" sizes="180x180" href="${href('apple-touch-icon.png')}">`;

export function registerBrand(app: FastifyInstance) {
  app.get<{ Params: { name: string } }>('/brand/:name', async (request, reply) => {
    const asset = assets.get(request.params.name);
    if (!asset) return reply.code(404).send();
    return reply.type(asset.type).header('cache-control', 'public, max-age=86400').send(asset.body);
  });
  for (const name of ['favicon.ico', 'apple-touch-icon.png']) {
    app.get(`/${name}`, async (_request, reply) => {
      const asset = assets.get(name)!;
      return reply.type(asset.type).header('cache-control', 'public, max-age=86400').send(asset.body);
    });
  }
}
