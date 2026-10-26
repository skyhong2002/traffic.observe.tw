import { describe, expect, it } from 'vitest';
import { parseSimilarSites, requestSimilarSites, taiwanClue } from '../src/similarsites.ts';

const page = (similar: unknown) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { siteData: { SimilarSites: similar } } } })}</script></html>`;

describe('similarsites.com page', () => {
  it('reads the similar sites with grade, category, visits and rank, dropping itself, repeats and bad rows', () => {
    const edges = parseSimilarSites(
      page([
        {
          Site: 'chinatimes.com',
          Description: ' 中時 ',
          Category: 'News_and_Media',
          TopCountryRank: 40,
          TotalVisits: 25264673.7,
          SimilarityRank: 1,
          Grade: 0.89,
        },
        { Site: 'x.tw', Grade: 0.8 },
        { Site: 'chinatimes.com', Grade: 0.7 },
        { Site: 'nograde.com' },
        { Site: 'http://bad host', Grade: 0.5 },
        { Site: 'udn.com', Grade: 0.88 },
      ]),
      'x.tw',
    );
    expect(edges).toEqual([
      {
        similar: 'chinatimes.com',
        rank: 1,
        grade: 0.89,
        category: 'News_and_Media',
        topCountryRank: 40,
        totalVisits: 25264674,
        description: '中時',
      },
      { similar: 'udn.com', rank: 2, grade: 0.88, category: null, topCountryRank: null, totalVisits: null, description: null },
    ]);
  });

  it('returns null when the page has no such data', () => {
    expect(parseSimilarSites('<html>nothing</html>', 'x.tw')).toBeNull();
    expect(parseSimilarSites(page('nope'), 'x.tw')).toBeNull();
    expect(parseSimilarSites('<script id="__NEXT_DATA__">{broken</script>', 'x.tw')).toBeNull();
  });

  it('tells a missing page from a refusal and a network failure', async () => {
    const answer =
      (status: number, body = '') =>
      async () =>
        new Response(body, { status });
    expect(await requestSimilarSites('x.tw', answer(404))).toEqual({ status: 'not-found' });
    expect(await requestSimilarSites('x.tw', answer(403))).toEqual({ status: 'failed', httpStatus: 403 });
    expect(await requestSimilarSites('x.tw', async () => Promise.reject(Error('down')))).toEqual({ status: 'failed', httpStatus: null });
    const ok = await requestSimilarSites('x.tw', answer(200, page([{ Site: 'a.com', Grade: 0.5 }])));
    expect(ok.status).toBe('ok');
    await expect(requestSimilarSites('not a domain', answer(200))).rejects.toThrow('Invalid domain');
  });
});

describe('Taiwan clues without Similarweb', () => {
  it('takes .tw domains and Traditional Chinese blurbs, not English or Simplified ones', () => {
    expect(taiwanClue('mimihan.tw')).toBe('tw');
    expect(taiwanClue('koc.com.tw', [null])).toBe('tw');
    expect(taiwanClue('vocus.cc', ['華人最大的內容創作平台，這裡有各種文章與專欄'])).toBe('zh-hant');
    expect(taiwanClue('gamersky.com', ['游民星空是国内单机游戏门户网站，提供特色的游戏资讯'])).toBeNull();
    expect(taiwanClue('twitch.tv', ['Twitch is an interactive livestreaming service'])).toBeNull();
    expect(taiwanClue('mixed.com', ['這是一個网站'])).toBeNull();
    expect(taiwanClue('none.com')).toBeNull();
    // Any one of a site's blurbs may carry the clue.
    expect(taiwanClue('x.com', ['English', '關於我們，提供會員服務'])).toBe('zh-hant');
  });
});
