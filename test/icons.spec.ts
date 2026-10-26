import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { iconStore } from '../src/icons.ts';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
const real = Buffer.alloc(300, 1);
/** Google answers per `answers`; Yandex (the second try) answers per `yandex`: a real icon, its 70-byte blank, or 404. */
const fakeGoogle = (answers: Record<string, number>, yandex: Record<string, 'icon' | 'blank'> = {}) => {
  const asked: string[] = [];
  const request = (async (url: string) => {
    const u = new URL(url);
    if (u.hostname === 'favicon.yandex.net') {
      const domain = decodeURIComponent(u.pathname.split('/').pop() as string);
      asked.push(`yandex:${domain}`);
      const kind = yandex[domain];
      return new Response(kind === 'icon' ? real : Buffer.alloc(70, 2), { headers: { 'content-type': 'image/png' } });
    }
    const domain = u.searchParams.get('domain') as string;
    asked.push(domain);
    const status = answers[domain] ?? 404;
    return new Response(png, { status, headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof fetch;
  return { request, asked };
};

describe('site icons', () => {
  it('fetches each icon once, keeps it on disk and remembers domains without one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'icons-'));
    const { request, asked } = fakeGoogle({ 'udn.com': 200 });
    const icons = iconStore(pathToFileURL(`${dir}/`), request);
    const [first, again] = await Promise.all([icons('udn.com'), icons('udn.com')]);
    expect(first?.body.equals(png)).toBe(true);
    expect(again?.type).toBe('image/png');
    expect(await icons('none.example.tw')).toBeNull();
    // A second store over the same folder answers from disk without asking again.
    const later = iconStore(pathToFileURL(`${dir}/`), request);
    expect((await later('udn.com'))?.body.equals(png)).toBe(true);
    expect(await later('none.example.tw')).toBeNull();
    expect(asked).toEqual(['udn.com', 'none.example.tw', 'yandex:none.example.tw']);
    expect((await readdir(dir)).sort()).toEqual(['none.example.tw.none', 'udn.com.png']);
  });

  it("falls back to Yandex when Google has no icon, and ignores Yandex's blank placeholder", async () => {
    dir = await mkdtemp(join(tmpdir(), 'icons-'));
    const { request } = fakeGoogle({ 'udn.com': 200 }, { 'ecpay.com.tw': 'icon', 'blank.tw': 'blank' });
    const icons = iconStore(pathToFileURL(`${dir}/`), request);
    expect((await icons('ecpay.com.tw'))?.body.equals(real)).toBe(true);
    expect(await icons('blank.tw')).toBeNull();
    // Google's answer wins when it has one.
    expect((await icons('udn.com'))?.body.equals(png)).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['blank.tw.none', 'ecpay.com.tw.png', 'udn.com.png']);
  });

  it('asks again once a stored icon is a month old', async () => {
    dir = await mkdtemp(join(tmpdir(), 'icons-'));
    const { request, asked } = fakeGoogle({ 'udn.com': 200 });
    let now = Date.now();
    const icons = iconStore(pathToFileURL(`${dir}/`), request, () => now);
    await icons('udn.com');
    now += 31 * 24 * 3600_000;
    await icons('udn.com');
    expect(asked).toEqual(['udn.com', 'udn.com']);
  });
});
