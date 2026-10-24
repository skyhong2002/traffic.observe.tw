import type { FastifyInstance } from 'fastify';
import { publicDomain } from './similarweb.ts';

// What search engines may index: the public report, its plain-HTML companions
// (listed in the sitemap) and each site's page. Everything else — the fetch log,
// /watch/, sign-in, editing, the APIs, errors and unknown routes — is sent with
// noindex. Who may open what does not change here.

const ENTRIES: Record<string, string> = {
  '/': '台灣網站每月造訪量排行：Similarweb 估算的月造訪量、自然搜尋與 AI 導流占比，可依標籤與來源篩選、比較任兩個月份。',
  '/table/': '台灣網站每月造訪量完整排行表，含自然搜尋、AI 導流與名次變化，可依月份、標籤與來源篩選並下載 CSV。',
  '/tag/': '依網站目前的標籤彙整所有月份的累計造訪量、網站數與自然搜尋、AI 導流占比，查看各標籤的完整網站清單。',
  '/sources/': '台灣網站的訪客從哪裡來：直接造訪、自然搜尋、社群、AI 工具等十種導流來源的每月占比走勢，以及變動最大的網站。',
};
const SITE = '/site/:domain/';
const FILES = new Set(['/robots.txt', '/sitemap.xml']);

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function registerSeo(
  app: FastifyInstance,
  origin = new URL(process.env.TRAFFIC_PUBLIC_ORIGIN || 'https://traffic.observe.tw').origin,
) {
  app.get('/robots.txt', async (_request, reply) =>
    reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(`User-agent: *\nDisallow: /internal/\nDisallow: /auth/\n\nSitemap: ${origin}/sitemap.xml\n`),
  );
  app.get('/sitemap.xml', async (_request, reply) =>
    reply
      .type('application/xml; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Object.keys(ENTRIES)
          .map((path) => `<url><loc>${origin}${path}</loc></url>\n`)
          .join('')}</urlset>\n`,
      ),
  );

  app.addHook('onSend', async (request, reply, payload) => {
    const route = request.routeOptions.url;
    if (route && FILES.has(route)) return payload;
    const domain = route === SITE ? publicDomain((request.params as { domain?: string }).domain) : null;
    const path = reply.statusCode !== 200 ? null : route && route in ENTRIES ? route : domain ? `/site/${domain}/` : null;
    const html = typeof payload === 'string' && payload.includes('</head>');
    if (!path) {
      reply.header('x-robots-tag', 'noindex');
      return html ? payload.replace('</head>', '<meta name="robots" content="noindex">\n</head>') : payload;
    }
    if (!html) return payload;
    const description = route && ENTRIES[route];
    return payload.replace(
      '</head>',
      `${description ? `<meta name="description" content="${attr(description)}">\n` : ''}<link rel="canonical" href="${attr(origin + path)}">\n</head>`,
    );
  });
}
