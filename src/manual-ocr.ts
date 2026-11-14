import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

const parser = new URL('./manual-ocr-parser.js', import.meta.url);
const importer = new URL('./manual-ocr-importer.js', import.meta.url);
const stylesheet = new URL('./manual-ocr.css', import.meta.url);
const version = createHash('sha256')
  .update(readFileSync(parser))
  .update(readFileSync(importer))
  .update(readFileSync(stylesheet))
  .update('tesseract7.0.0-eng1.0.0')
  .digest('hex')
  .slice(0, 12);
export const OCR_BASE = `/manual-ocr/${version}`;
export const OCR_IMPORTER = `${OCR_BASE}/importer.js`;
export const OCR_STYLE = `${OCR_BASE}/review.css`;

/** Only these pinned package assets are served. OCR never needs an external CDN. */
export function registerManualOcr(app: FastifyInstance) {
  const assets = new Map<string, { url: URL; type: string }>([
    ['review.css', { url: stylesheet, type: 'text/css; charset=utf-8' }],
    ['parser.js', { url: parser, type: 'text/javascript; charset=utf-8' }],
    ['importer.js', { url: importer, type: 'text/javascript; charset=utf-8' }],
    ['tesseract.min.js', { url: new URL('../node_modules/tesseract.js/dist/tesseract.min.js', import.meta.url), type: 'text/javascript' }],
    ['worker.min.js', { url: new URL('../node_modules/tesseract.js/dist/worker.min.js', import.meta.url), type: 'text/javascript' }],
    [
      'lang/eng.traineddata.gz',
      { url: new URL('../node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz', import.meta.url), type: 'application/gzip' },
    ],
  ]);
  for (const variant of ['', '-simd', '-relaxedsimd'])
    for (const extension of ['wasm.js', 'wasm']) {
      const file = `tesseract-core${variant}-lstm.${extension}`;
      assets.set(`core/${file}`, {
        url: new URL(`../node_modules/tesseract.js-core/${file}`, import.meta.url),
        type: extension === 'wasm' ? 'application/wasm' : 'text/javascript',
      });
    }
  app.get<{ Params: { version: string; '*': string } }>('/manual-ocr/:version/*', async (request, reply) => {
    const asset = request.params.version === version && assets.get(request.params['*']);
    if (!asset) return reply.code(404).send();
    return reply.type(asset.type).header('cache-control', 'public, max-age=31536000, immutable').send(createReadStream(asset.url));
  });
}
