/** Private UI trial: no environment file, production database, or production writes. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { registerBrand } from '../src/brand.ts';
import { type ManualMonth, parseManualChannels, parseManualDetails, parseShare, parseVisits } from '../src/manual.ts';
import { ManualInputError } from '../src/manual-input.ts';
import { registerManualOcr } from '../src/manual-ocr.ts';
import { manualPage } from '../src/metadata-pages.ts';
import { STYLE, TABLES_SCRIPT } from '../src/style.ts';

const choices = ['202611', '202610', '202609', '202608', '202607'];
const site = { domain: 's3.com.tw', name: '小三美日' };
const path = '/site/s3.com.tw/manual/';
type Saved = Record<string, Record<string, string>>;
function entry(month: string, values: Record<string, string>): ManualMonth {
  const channels = parseManualChannels(values);
  const searchShare = parseShare(values.search, '自然搜尋', 'search');
  const aiShare = parseShare(values.ai, 'Gen AI', 'ai');
  if (Object.values(channels).reduce((a, b) => a + b, 0) + (searchShare || 0) + (aiShare || 0) > 1.001)
    throw new ManualInputError('全裝置流量來源合計不能超過 100%。', 'search');
  return {
    domain: site.domain,
    month,
    visits: parseVisits(values.visits),
    searchShare,
    aiShare,
    taiwanShare: parseShare(values.taiwan, '台灣占比', 'taiwan'),
    channels,
    details: parseManualDetails(values),
    updatedBy: '測試者',
    updatedAt: new Date().toISOString(),
  };
}
export async function createManualPreview(storage: string) {
  await mkdir(storage, { recursive: true });
  const app = Fastify({ bodyLimit: 100_000 });
  registerManualOcr(app);
  registerBrand(app);
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/manual-ocr/')) return;
    reply.header('cache-control', 'no-store');
    if (!request.headers.cookie?.match(/(?:^|;\s*)manual_trial=([a-f0-9-]{36})(?:;|$)/))
      reply.header('set-cookie', 'manual_trial=' + randomUUID() + '; HttpOnly; SameSite=Lax; Path=/');
  });
  const file = (cookie = '') => {
    const id = cookie.match(/(?:^|;\s*)manual_trial=([a-f0-9-]{36})(?:;|$)/)?.[1];
    if (!id) return null;
    return resolve(storage, id + '.json');
  };
  const load = async (cookie?: string): Promise<Saved> => {
    const target = file(cookie);
    if (!target) return {};
    try {
      return JSON.parse(await readFile(target, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  };
  const render = (saved: Saved, options: Parameters<typeof manualPage>[1] = { months: [], choices, free: [] }) => {
    const html = manualPage(site, { ...options, months: Object.entries(saved).map(([month, values]) => entry(month, values)) });
    return html.replace(
      '<section class="block manual-workspace">',
      '<p class="callout">測試版 · 儲存僅保存在這個測試站，不影響正式資料。</p><section class="block manual-workspace">',
    );
  };
  app.get('/', (_, reply) => reply.redirect(path));
  app.get('/style.css', (_, reply) => reply.type('text/css').send(STYLE));
  app.get('/tables.js', (_, reply) => reply.type('text/javascript').send(TABLES_SCRIPT));
  app.get<{ Querystring: { done?: string } }>(path, async (request, reply) =>
    reply.type('text/html').send(
      render(await load(request.headers.cookie), {
        months: [],
        choices,
        free: [],
        selectedMonth: '202610',
        ...(choices.includes(request.query.done || '')
          ? { completedMonth: request.query.done, message: '測試資料已儲存；正式站未變更。' }
          : {}),
      }),
    ),
  );
  app.post<{ Body: Record<string, string> }>(path, async (request, reply) => {
    const target = file(request.headers.cookie);
    if (!target) return reply.code(400).send('請先開啟測試頁面，再儲存。');
    const saved = await load(request.headers.cookie);
    const values = request.body;
    try {
      if (!choices.includes(values.month)) throw new ManualInputError('請選擇有效月份。', 'month');
      if (values.action === 'delete') delete saved[values.month];
      else {
        entry(values.month, values);
        saved[values.month] = values;
      }
      const temporary = target + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
      await rename(temporary, target);
      return reply.code(303).redirect(path + '?done=' + values.month);
    } catch (error) {
      if (!(error instanceof ManualInputError)) throw error;
      return reply
        .code(422)
        .type('text/html')
        .send(
          render(saved, {
            months: [],
            choices,
            free: [],
            draft: values,
            error: error.message,
            errorFields: error.fields,
          }),
        );
    }
  });
  return app;
}
if (import.meta.main) {
  const app = await createManualPreview(resolve(process.env.MANUAL_PREVIEW_STORAGE || 'data/manual-simple-preview-20261115/saves'));
  await app.listen({ host: '127.0.0.1', port: Number(process.env.MANUAL_PREVIEW_PORT || 18156) });
  console.log('Private manual preview listening on ' + app.server.address());
}
