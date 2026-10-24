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
const fakeGoogle = (answers: Record<string, number>) => {
  const asked: string[] = [];
  const request = (async (url: string) => {
    const domain = new URL(url).searchParams.get('domain') as string;
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
    expect(asked).toEqual(['udn.com', 'none.example.tw']);
    expect((await readdir(dir)).sort()).toEqual(['none.example.tw.none', 'udn.com.png']);
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
