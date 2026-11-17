import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contributorTraffic } from '../src/contributor.ts';
import { validJobResult, verifyNodeToken } from '../src/contributor-jobs.ts';
import { parseDomainTraffic } from '../src/similarweb.ts';
import { fetchContributorJob } from '../tools/contributor-fetch.ts';

const directories: string[] = [];
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), 'contributor-fetch-'));
  directories.push(path);
  return path;
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Docker contributor fetcher', () => {
  it('persists responses before delivery, replays without a second fetch and retains its own device identity', async () => {
    const path = await directory();
    const contexts: string[] = [];
    const request = vi.fn(async (_url, init) => {
      contexts.push(new Headers(init?.headers).get('x-sw-ctx')!);
      return new Response('{"SiteName":"a.tw"}', { headers: { 'set-cookie': 'never-forward', 'retry-after': '120' } });
    }) as unknown as typeof fetch;
    const first = await fetchContributorJob({ domain: 'a.tw', requestId: '1' }, path, request);
    expect(await fetchContributorJob({ domain: 'a.tw', requestId: '1' }, path, request)).toEqual(first);
    await fetchContributorJob({ domain: 'b.tw', requestId: '2' }, path, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(contexts[0].split('.')[0]).toBe(contexts[1].split('.')[0]);
    expect(first.headers).toEqual({ 'content-type': 'text/plain;charset=UTF-8', 'retry-after': '120' });
    expect((await stat(join(path, '1.json'))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(path, 'device-id'), 'utf8')).trim()).toBe(contexts[0].split('.')[0]);
  });

  it('does not reissue a request after a network failure or an uncertain interrupted fetch', async () => {
    const path = await directory();
    const request = vi.fn(async () => {
      throw Error('network failure');
    }) as unknown as typeof fetch;
    await expect(fetchContributorJob({ domain: 'a.tw', requestId: '3' }, path, request)).rejects.toThrow();
    await expect(fetchContributorJob({ domain: 'a.tw', requestId: '3' }, path, request)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves refusals and rejects private domains before sending', async () => {
    const path = await directory();
    const request = vi.fn(
      async () => new Response('quota exceeded', { status: 429, headers: { 'retry-after': '3600' } }),
    ) as unknown as typeof fetch;
    expect(await fetchContributorJob({ domain: 'a.tw', requestId: '4' }, path, request)).toMatchObject({
      status: 429,
      headers: { 'retry-after': '3600' },
    });
    await expect(fetchContributorJob({ domain: 'localhost', requestId: '5' }, path, request)).rejects.toThrow('invalid contributor job');
    await expect(fetchContributorJob({ domain: 'a.tw', requestId: '../5' }, path, request)).rejects.toThrow('invalid contributor job');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses individually revocable node keys and rejects malformed result envelopes', () => {
    const token = `cn1:sky-mini:${'a'.repeat(43)}`;
    const keys = `sky-mini:${createHash('sha256').update(token).digest('hex')}`;
    expect(verifyNodeToken(token, keys)).toBe('sky-mini');
    expect(verifyNodeToken(`${token.slice(0, -1)}b`, keys)).toBeNull();
    expect(verifyNodeToken(token, '')).toBeNull();
    expect(validJobResult({ error: 'fetch_failed' })).toBe(false);
    expect(validJobResult({ sourceVersion: 'v1', error: 'fetch_failed' })).toBe(true);
    expect(validJobResult({ sourceVersion: 'v1', reply: { status: 200 } })).toBe(false);
  });

  it('keeps profile fields on their actual month and omits zero/unavailable months', () => {
    const traffic = parseDomainTraffic(
      {
        SiteName: 'a.tw',
        EstimatedMonthlyVisits: { '2026-08-01': 0, '2026-09-01': 1234.8, '2026-10-01': 2345 },
        Engagments: { Year: '2026', Month: '10', BounceRate: '0', PagePerVisit: '2', TimeOnSite: '100' },
        TrafficSources: { GenAi: 0 },
      },
      'a.tw',
      new Date('2026-11-17T00:00:00Z'),
    );
    const payloads = contributorTraffic(traffic, 'sky-mini', 'v1');
    expect(payloads).toHaveLength(2);
    expect(payloads[0].payload).toEqual({ visits: 1235 });
    expect(payloads[1].payload).toMatchObject({ visits: 2345, channels: { GenAi: 0 }, bounceRate: 0 });
  });
});
