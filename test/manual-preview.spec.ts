import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createManualPreview } from '../tools/manual-simple-preview.ts';

it('saves only to a cookie-isolated preview file, roundtrips the real form, and rejects invalid changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manual-preview-'));
  const app = await createManualPreview(directory);
  try {
    const path = '/site/s3.com.tw/manual/';
    const initial = await app.inject({ method: 'GET', url: path });
    const cookie = String(initial.headers['set-cookie']).split(';')[0];
    expect(initial.body).toContain('儲存僅保存在這個測試站');
    const body = { month: '202610', visits: '482.4K', taiwan: '93.23', countries: 'TW 93.23\nUS 2.13', desktop_SearchOrganic: '38.72' };
    const save = await app.inject({ method: 'POST', url: path, headers: { cookie }, payload: body });
    expect(save.statusCode).toBe(303);
    const after = await app.inject({ method: 'GET', url: save.headers.location!, headers: { cookie } });
    expect(after.body).toContain('測試資料已儲存');
    expect(after.body).toContain('value="482.4k"');
    const files = await readdir(directory);
    expect(files.length).toBe(1);
    expect(JSON.parse(await readFile(join(directory, files[0]), 'utf8'))['202610']).toEqual(body);
    const other = await app.inject({ method: 'GET', url: path });
    expect(other.body).not.toContain('value="482.4k"');
    const invalid = await app.inject({ method: 'POST', url: path, headers: { cookie }, payload: { ...body, taiwan: '80' } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.body).toContain('不一致');
    expect(JSON.parse(await readFile(join(directory, files[0]), 'utf8'))['202610']).toEqual(body);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
