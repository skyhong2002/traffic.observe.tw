import { TAG_LIMIT, type TagItem } from './crowd.ts';
import { type manualCandidates, proUrl } from './manual.ts';
import { type ranking, shiftMonth } from './metrics.ts';
import type { RadarPeriod } from './radar.ts';
import type { WatchRow } from './requests.ts';
import type { TrafficChannel, TrafficProfile } from './similarweb.ts';
import type { QueueEntry, serviceStatus } from './status.ts';
import { STYLE_HREF, TABLES_HREF } from './style.ts';
import type { TopicOverview } from './topics.ts';

// Server-rendered pages in the report's design (style.css). Every page has the
// same shape: the site header, a page head (title, one-line description, page
// actions), an optional toolbar of filters, then sections of sortable tables
// (tables.js). No client framework.

export const html = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const monthLabel = (m: string) => `${m.slice(0, 4)}/${m.slice(4)}`;
const monthLong = (m: string) => `${m.slice(0, 4)} 年 ${Number(m.slice(4))} 月`;
const pct = (n: number | null, digits = 1) => (n === null ? '' : `${(n * 100).toFixed(digits)}%`);
/** Up/down carry ▲▼ as well as color. */
const signed = (n: number | null) =>
  n === null ? '' : `<span class="delta ${n < 0 ? 'down' : 'up'}">${n < 0 ? '▼' : '▲'}${pct(Math.abs(n))}</span>`;
/** A cell whose sort value differs from what it shows (tables.js sorts by data-v). */
const sortCell = (cls: string, value: number | string | null, shown: string) =>
  `<td class="${cls}"${value === null ? '' : ` data-v="${html(value)}"`}>${shown}</td>`;
/**
 * Visits at four significant digits: a whole number under a thousand, then k
 * below a million, m below ten billion and b beyond (437, 12.34k, 757.3m,
 * 4031m, 12.34b). Takes millions, as visits are stored.
 */
export function visitParts(millions: number): [string, string] {
  const n = millions * 1e6;
  const [v, unit] = n >= 1e10 ? [n / 1e9, 'b'] : n >= 1e6 ? [millions, 'm'] : n >= 1e3 ? [n / 1e3, 'k'] : [n, ''];
  if (!unit) return [String(Math.round(v)), ''];
  const r = Number(v.toPrecision(4));
  return [r.toFixed(r >= 1000 ? 0 : 3 - Math.floor(Math.log10(r))), unit];
}
/** Visits with a muted unit, for tables and cards; empty when unknown. */
export const vol = (millions: number | null) => {
  if (millions === null) return '';
  const [v, unit] = visitParts(millions);
  return unit ? `${v}<span class="unit">${unit}</span>` : v;
};
/** Visits as plain text, for titles, tooltips and form values. */
export const volText = (millions: number | null) => (millions === null ? '' : visitParts(millions).join(''));
/** A visits cell, sorted by the number rather than its text. */
const volCell = (millions: number | null, empty = '') => sortCell('num', millions, vol(millions) || empty);
const tw = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, dateStyle: 'short', timeStyle: 'short' }) : '';
const twDate = (iso: string) => new Date(iso).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });

export type Nav = 'report' | 'table' | 'topics' | 'status' | 'watch' | 'sites' | null;
/** The header holds the main pages; the ranking's two views are tabs above its title (sectionTabs). */
const NAV: Array<[string, string, Nav[]]> = [
  ['/', '流量排行', ['report', 'table']],
  ['/tag/', '標籤概況', ['topics']],
  ['/status/', '抓取狀態', ['status']],
  ['/watch/', '追蹤網域', ['watch']],
];
const SECTIONS: Array<[string, Array<[Exclude<Nav, null>, string, string]>]> = [
  [
    '流量排行',
    [
      ['report', '/', '流量總覽'],
      ['table', '/table/', '完整數據'],
    ],
  ],
];
const pills = (label: string, links: Array<[string, string, boolean]>) =>
  `<nav class="subnav" aria-label="${label}">${links
    .map(([href, text, on]) => `<a href="${href}"${on ? ' aria-current="page"' : ''}>${text}</a>`)
    .join('')}</nav>`;
/** The pages of the section `nav` belongs to, as pills; empty for a page outside the sections. */
export const sectionTabs = (nav: Nav) => {
  const section = SECTIONS.find(([, pages]) => pages.some(([key]) => key === nav));
  return section
    ? pills(
        section[0],
        section[1].map(([key, href, text]) => [href, text, key === nav]),
      )
    : '';
};
const FOOTER_NAV: Array<[string, Array<[Nav, string, string]>]> = [
  [
    '資料與狀態',
    [
      ['status', '/status/', '抓取狀態'],
      ['watch', '/watch/', '追蹤網域'],
      [null, '/api/', 'API'],
    ],
  ],
  ['管理', [['sites', '/sites/', '網站與標籤管理']]],
];
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1B5RsSVZSrjKSUFDFZ-2VVlU3-tpTN49J1YzLGOohalM/edit';
export interface Masthead {
  title: string;
  /** One line on what the page is for (HTML). */
  dek?: string;
  /** Links beside the title, such as edit or download. */
  actions?: string;
  /** Filters under the title, in one row. */
  toolbar?: string;
  /** Pills above the title for the sub-pages; the page's section (sectionTabs) when left out. */
  tabs?: string;
}

export type SiteTab = 'overview' | 'edit' | 'manual';
/** The pages of one site an editor moves between: its data, its name and tags, and months entered by hand. */
export const siteTabs = (domain: string, current: SiteTab) =>
  pills(
    '網站頁面',
    (
      [
        ['overview', '', '流量資料'],
        ['edit', 'edit/', '名稱與標籤'],
        ['manual', 'manual/', 'Pro 補登'],
      ] as const
    ).map(([key, path, label]) => [`/site/${html(domain)}/${path}`, label, key === current]),
  );

const BRAND = '<span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>流量觀察';
const navLink = (nav: Nav, [key, href, label]: [Nav, string, string]) =>
  `<a href="${href}"${key && key === nav ? ' class="on" aria-current="page"' : ''}>${label}</a>`;
/** The note under every page title, pointing at the method note above the footer. */
export const METHOD_LINK = '<a class="method-link" href="#method">本頁的資料來源與計算方式 <span aria-hidden="true">ⓘ</span></a>';

export function siteHeader(nav: Nav) {
  return `<a class="skip-link" href="#main">跳至主要內容</a><header class="site"><div class="wrap site-inner"><a class="brand" href="/">${BRAND}</a><nav class="site-nav" aria-label="主要導覽">${NAV.map(
    ([href, label, keys]) => `<a href="${href}"${nav && keys.includes(nav) ? ' class="on" aria-current="true"' : ''}>${label}</a>`,
  ).join('')}</nav><div class="site-tools"><span class="who"><!--who--></span></div></div></header>`;
}

export function siteFooter(nav: Nav = null) {
  return `<div class="wrap"><details class="method" id="method"><summary>資料來源與計算方式</summary>
<p>流量是 Similarweb 對整個網域的每月造訪估算，數字後的 k、m、b 分別代表千、百萬、十億次（四位有效數字）；不是 page views 或不重複讀者。搜尋S＝造訪 × 自然搜尋占比（不含付費搜尋），AI＝造訪 × GenAI 導流占比，與 GeneHong「<a href="${SHEET_URL}">Similar Web</a>」試算表的算法相同。</p>
<p>Similarweb 沒有的月份以試算表數字補上並標「表」，人工調整（如「/5」）的列不採用。Similarweb 回傳 0 代表那個月沒有估算（小網站，或它不單獨計算的子網域如 tw.news.yahoo.com），視同沒有資料，不當成 0 次造訪。搜尋與 AI 占比只提供抓取時最新一個月，缺少的月份不推算；試算表中的 Ahrefs 搜尋數字與 A/S 比值不在本站資料範圍內。</p>
<p>Cloudflare Radar 是依 1.1.1.1 DNS 查詢的全球熱門排名：前 100 名才有名次，其餘只有「前 N 名」級距，不能換算成造訪量。</p>
</details></div>
<footer class="site-footer"><div class="wrap"><div class="footer-main"><div class="footer-about"><a class="brand" href="/">${BRAND}</a><p>台灣網站每月的 Similarweb 造訪估算、搜尋與 AI 導流，以及 Cloudflare Radar 排名。</p></div><nav class="footer-nav" aria-label="其他頁面">${FOOTER_NAV.map(
    ([title, links]) => `<div><h2>${title}</h2>${links.map((n) => navLink(nav, n)).join('')}</div>`,
  ).join(
    '',
  )}<div><h2>資料來源</h2><a href="${SHEET_URL}" rel="noopener">GeneHong 試算表 ↗</a><a href="https://radar.cloudflare.com/" rel="noopener">Cloudflare Radar ↗</a></div></nav></div><div class="footer-bottom"><span>流量觀察 · 數字為估算值，僅供比較參考</span><a href="#">回到頂端 ↑</a></div></div></footer>`;
}

const TIP_SCRIPT = `<script>
(() => {
  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.append(tip);
  const show = (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return tip.classList.remove('show');
    tip.textContent = el.dataset.tip;
    tip.classList.add('show');
    tip.style.left = Math.max(8, Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)) + 'px';
    tip.style.top = Math.max(8, e.clientY - tip.offsetHeight - 10) + 'px';
  };
  document.addEventListener('pointermove', show);
  document.addEventListener('pointerdown', show);
  document.addEventListener('scroll', () => tip.classList.remove('show'), { passive: true });
})();
</script>`;

/** Lets the stylesheet collapse long chip rows only when the script that expands them will run. */
export const JS_FLAG = "<script>document.documentElement.classList.add('js')</script>";

export function layout(title: string, head: Masthead, body: string, { nav = null, tips = false }: { nav?: Nav; tips?: boolean } = {}) {
  return `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(title)}｜流量觀察</title><link rel="stylesheet" href="${STYLE_HREF}">${JS_FLAG}<script src="${TABLES_HREF}" defer></script></head><body>
${siteHeader(nav)}
<main class="wrap" id="main">${head.tabs ?? sectionTabs(nav)}<div class="page-head"><div><h1>${html(head.title)}</h1><p class="dek">${head.dek ? `${head.dek.replace(/。$/, '')}<span class="sep" aria-hidden="true">·</span>` : ''}${METHOD_LINK}</p></div>${
    head.actions ? `<div class="page-actions">${head.actions}</div>` : ''
  }</div>${head.toolbar ? `<div class="toolbar">${head.toolbar}</div>` : ''}
${body}</main>
${siteFooter(nav)}
${tips ? TIP_SCRIPT : ''}</body></html>`;
}

const section = (title: string, inner: string, extra = '') => `<section class="block"${extra}><h2>${title}</h2>${inner}</section>`;

/** Every server-rendered table sorts by its headers in the browser (tables.js). */
const table = (head: string, rows: string, empty: string, cols: number, id = '') =>
  `<div class="scroll"><table data-sortable${id ? ` id="${id}"` : ''}><thead><tr>${head}</tr></thead><tbody>${
    rows || `<tr><td colspan="${cols}" class="l empty">${empty}</td></tr>`
  }</tbody></table></div>`;
export interface Chip {
  /** Where a click leads: the next state of this chip. */
  href: string;
  text: string;
  count?: number;
  on: boolean;
  /** Left out of the list (tags only); shown in red with a minus sign. */
  excluded?: boolean;
  /** What the next click does, as a tooltip. */
  hint?: string;
}
/**
 * One row of filter chips like tag.observe.tw/media/: 「全部…」 first, then each
 * value with its count. Past `visible` values the rest fold behind 「更多」
 * (tables.js), unless a chosen or excluded one is among them.
 */
export function chipRow(label: string, all: Omit<Chip, 'count'>, items: Chip[], visible = 15, note = '') {
  const chip = (c: Chip | Omit<Chip, 'count'>, extra = false) =>
    `<a class="chip-filter${extra ? ' extra' : ''}${c.excluded ? ' excluded' : ''}" href="${c.href}"${c.on ? ' aria-current="true"' : ''}${
      c.hint ? ` title="${c.hint}"` : ''
    }>${c.excluded ? '−' : ''}${c.text}${'count' in c && c.count !== undefined ? ` <span>${c.count.toLocaleString('en-US')}</span>` : ''}</a>`;
  const hidden = items.length - visible;
  const open = items.slice(visible).some((c) => c.on || c.excluded);
  return `<nav class="chip-row${open ? ' open' : ''}" aria-label="${label}">${chip(all)}${items.map((c, i) => chip(c, i >= visible)).join('')}${
    hidden > 0
      ? `<button type="button" class="chip-more" data-chip-more data-more="更多（+${hidden}）" data-less="收合">${open ? '收合' : `更多（+${hidden}）`}</button>`
      : ''
  }${note ? `<span class="chip-note">${note}</span>` : ''}</nav>`;
}
/** A two- or three-way switch of plain links (works without JavaScript): [text, href, on, tooltip]. */
export const toggle = (label: string, options: Array<[string, string, boolean, string]>) =>
  `<nav class="seg" aria-label="${label}"><span>${label}</span>${options
    .map(([text, href, on, hint]) => `<a href="${html(href)}" title="${html(hint)}"${on ? ' aria-current="true"' : ''}>${text}</a>`)
    .join('')}</nav>`;
/** What one click on a tag chip does: off → only this tag → leave it out → off. */
export const TAG_CHIP_NOTE = '按一下只看該標籤，再按一下排除，第三下取消';

/** A search box that hides the rows of one table that do not match. */
const tableSearch = (target: string, label: string) =>
  `<label class="search-field"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input type="search" data-table-filter="${target}" aria-label="${label}" placeholder="${label}" autocomplete="off"></label>`;
const tagLinks = (topics: string[], href: (t: string) => string) =>
  `<span class="tags" title="${html(topics.join('、'))}">${topics.map((t) => `<a class="tag" href="${href(t)}">${html(t)}</a>`).join('')}</span>`;
/** Name and domain on one line; the domain is left out when it is the name. */
/** The site's icon (/icon/), or the first letter of its name where it has none. */
export const favicon = (domain: string, name: string) =>
  `<span class="favicon" data-letter="${html([...name.trim()][0]?.toUpperCase() ?? '')}" aria-hidden="true"><img src="/icon/${html(domain)}" alt="" width="16" height="16" loading="lazy" onerror="this.remove()"></span>`;
const siteCell = (domain: string, name: string, extra = '') =>
  `<td class="l" data-v="${html(name)}"><span class="site-identity">${favicon(domain, name)}<a class="site-name" href="/site/${html(domain)}/" title="${html(name)} · ${html(domain)}">${html(name)}</a>${
    domain !== name ? `<span class="site-domain table-lead-extra">${html(domain)}</span>` : ''
  }${extra}</span></td>`;

export function rankingPage(
  month: string,
  months: string[],
  topics: Array<{ topic: string; sites: number }>,
  topic: string | null,
  list: ReturnType<typeof ranking>,
  source: string | null = null,
  sources: Array<{ requester: string; domains: number }> = [],
  exclude: string[] = [],
  { from = null, show = 'share', unit = 'share' }: { from?: string | null; show?: 'share' | 'change'; unit?: 'share' | 'count' } = {},
) {
  // Choosing a value reloads the page; the button is there for browsers without JavaScript.
  const select = (name: string, label: string, options: string) =>
    `<label class="select-field"><span>${label}</span><select name="${name}" onchange="this.form.submit()">${options}</select></label>`;
  // Month and search sit in one row; tags and sources are chip rows of plain links, keeping the other choices.
  const tableHref = (q: {
    topic?: string | null;
    source?: string | null;
    exclude?: string[];
    unit?: 'share' | 'count';
    show?: 'share' | 'change';
  }) => {
    const p = new URLSearchParams({ month });
    if (from) p.set('from', from);
    if ((q.show ?? show) === 'change') p.set('show', 'change');
    if ((q.unit ?? unit) === 'count') p.set('unit', 'count');
    const t = q.topic === undefined ? topic : q.topic;
    const src = q.source === undefined ? source : q.source;
    const out = q.exclude ?? exclude;
    if (t) p.set('topic', t);
    // Always written, even empty: without it the page falls back to leaving out 非台灣.
    p.set('exclude', out.join(','));
    if (src) p.set('source', src);
    return `/table/?${p}`;
  };
  // A tag chip's next state: off → only this tag → leave it out → off.
  const nextTag = (t: string) =>
    t === topic
      ? { href: tableHref({ topic: null, exclude: [...exclude, t] }), hint: '再按一次改為排除' }
      : exclude.includes(t)
        ? { href: tableHref({ exclude: exclude.filter((x) => x !== t) }), hint: '已排除，再按一次取消' }
        : { href: tableHref({ topic: t, exclude: exclude.filter((x) => x !== t) }), hint: '只看這個標籤' };
  const filters = `<form class="toolbar-form" method="get" action="/table/">${tableSearch('ranking', '搜尋網站名稱或網域')}${select(
    'month',
    '月份',
    months.map((m) => `<option value="${m}"${m === month ? ' selected' : ''}>${monthLong(m)}</option>`).join(''),
  )}${
    from
      ? `${select(
          'from',
          '比較',
          months
            .filter((m) => m < month)
            .map((m) => `<option value="${m}"${m === from ? ' selected' : ''}>${monthLong(m)}</option>`)
            .join(''),
        )}`
      : ''
  }${toggle('數值', [
    ['%', tableHref({ unit: 'share' }), unit === 'share', '各來源占造訪的比例'],
    ['次數', tableHref({ unit: 'count' }), unit === 'count', '造訪量 × 占比換算的造訪次數'],
  ])}${
    from
      ? toggle('顯示', [
          ['當月', tableHref({ show: 'share' }), show === 'share', '這個月份的數值'],
          ['差距', tableHref({ show: 'change' }), show === 'change', '與比較月份相差多少'],
        ])
      : ''
  }${show === 'change' ? '<input type="hidden" name="show" value="change">' : ''}${unit === 'count' ? '<input type="hidden" name="unit" value="count">' : ''}${topic ? `<input type="hidden" name="topic" value="${html(topic)}">` : ''}<input type="hidden" name="exclude" value="${html(exclude.join(','))}">${source ? `<input type="hidden" name="source" value="${html(source)}">` : ''}<noscript><button type="submit">套用</button></noscript></form>`;
  const chips = `${chipRow(
    '追蹤來源',
    { href: html(tableHref({ source: null })), text: '全部來源', on: !source },
    sources.map((s) => ({
      // The chosen source links back to all sources, so clicking it again clears it.
      href: html(tableHref({ source: s.requester === source ? null : s.requester })),
      text: html(SOURCE_LABEL[s.requester] ?? s.requester),
      count: s.domains,
      on: s.requester === source,
      hint: s.requester === source ? '再按一次取消' : undefined,
    })),
  )}${chipRow(
    '網站標籤',
    { href: html(tableHref({ topic: null, exclude: [] })), text: '全部標籤', on: !topic && !exclude.length },
    topics.map((t) => {
      const next = nextTag(t.topic);
      return {
        href: html(next.href),
        hint: next.hint,
        text: html(t.topic),
        count: t.sites,
        on: t.topic === topic,
        excluded: exclude.includes(t.topic),
      };
    }),
    15,
    TAG_CHIP_NOTE,
  )}`;
  // Every share column at the end, sortable: 搜尋占比 and AI 占比 fall back to the sheet like the rankings,
  // the other channels are Similarweb's only. In 「差距」 mode each shows (and sorts by) the change from `from`.
  type Row = (typeof list)[number];
  const shareCols: Array<{
    head: string;
    title: string;
    digits: number;
    now: (s: Row) => number | null;
    before: (s: Row) => number | null;
  }> = [
    { head: '搜尋', title: '自然搜尋（不含搜尋廣告）', digits: 1, now: (s) => s.searchShare, before: (s) => s.prevSearchShare },
    { head: 'AI', title: 'AI 工具導流', digits: 2, now: (s) => s.aiShare, before: (s) => s.prevAiShare },
    { head: '台灣', title: '台灣訪客', digits: 1, now: (s) => s.taiwanShare, before: (s) => s.prevTaiwanShare ?? null },
    ...TABLE_CHANNELS.map(([key, head]) => {
      const [, , title] = CHANNELS.find(([k]) => k === key) as (typeof CHANNELS)[number];
      return {
        head,
        title,
        digits: 1,
        // A channel Similarweb left out of a profile it did send is 0; without a profile it is unknown.
        now: (s: Row) => (s.channels ? (s.channels[key] ?? 0) : null),
        before: (s: Row) => (s.prevChannels ? (s.prevChannels[key] ?? 0) : null),
      };
    }),
  ];
  // % shows the share; 次數 the visits it stands for (visits × share). 差距 shows either's change from `from`.
  const shareCell = (s: Row, c: (typeof shareCols)[number]) => {
    const now = c.now(s);
    const before = c.before(s);
    if (unit === 'count') {
      const visits = now !== null && s.visits !== null ? s.visits * now : null;
      if (show === 'share') return volCell(visits);
      const earlier = before !== null && s.prevVisits !== null ? s.prevVisits * before : null;
      const change = visits !== null && earlier !== null ? visits - earlier : null;
      return sortCell(
        'num',
        change,
        change === null ? '' : `<span class="shift">${change < 0 ? '▼' : change > 0 ? '▲' : ''}${vol(Math.abs(change))}</span>`,
      );
    }
    if (show === 'share') return sortCell('num', now, pct(now, now !== null && now > 0 && now < 0.0095 ? 2 : c.digits));
    const change = now !== null && before !== null ? now - before : null;
    // Bare numbers keep the columns narrow; the note below says they are percentage points.
    return sortCell('num', change, points(change, ''));
  };
  const rowsHtml = list
    .map(
      (s) =>
        `<tr><td class="rank">${s.rank ?? '—'}</td>${siteCell(
          s.domain,
          s.name,
          s.visitsSource === 'sheet'
            ? '<span class="tag table-lead-extra" title="Similarweb 沒有這個月份，用試算表數字">表</span>'
            : s.visitsSource === 'manual'
              ? '<span class="tag table-lead-extra" title="Similarweb 免費資料沒有估算，用從 Similarweb 平台（Pro）手動補登的數字">Pro</span>'
              : '',
        )}${sortCell(
          'l',
          s.topics.join('、'),
          tagLinks(s.topics, (t) => `/#topic=${encodeURIComponent(t)}`),
        )}
${volCell(s.visits)}${sortCell('num', s.growth, signed(s.growth))}<td class="num">${s.prevRank ?? ''}</td>
${shareCols.map((c) => shareCell(s, c)).join('')}</tr>`,
    )
    .join('');
  const prevHead = from && from !== shiftMonth(month, -1) ? '比較月' : '上月';
  const csv = `/api/v1/rankings.csv?month=${month}${from ? `&from=${from}` : ''}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}${
    exclude.length ? `&exclude=${encodeURIComponent(exclude.join(','))}` : ''
  }${source ? `&source=${encodeURIComponent(source)}` : ''}`;
  const sourceNote = source
    ? `${html(SOURCE_LABEL[source] ?? source)}・<a href="/watch/${source === 'manual' ? '' : `?list=${encodeURIComponent(source)}#list`}">查看追蹤清單</a>`
    : '';
  return layout(
    month ? `${monthLabel(month)} ${topic ?? '全部'}・完整數據` : '完整數據',
    {
      title: '完整數據',
      dek: '單一月份所有網站的流量與導流數字',
      actions: month ? `<a href="${csv}">下載 CSV</a>` : '',
      toolbar: month ? filters : '',
    },
    `${month ? `<div class="chip-rows">${chips}</div>` : ''}<section class="block"><p class="results-line" data-table-count="ranking" data-total="${list.length}">${html(topic ?? '全部網站')}${exclude.length ? `・排除 ${html(exclude.join('、'))}` : ''}・${list.length} 個網站${sourceNote ? `・${sourceNote}` : ''}</p>
${table(
  `<th class="rank" aria-sort="ascending" title="名次">#</th><th class="l">網站</th><th class="l">標籤</th><th class="num">流量</th><th class="num">成長</th><th class="num" title="比較月份的名次">${prevHead}</th>${shareCols
    .map((c) => `<th class="num" title="${html(c.title)}">${c.head}${unit === 'share' ? ' %' : ''}${show === 'change' ? ' ±' : ''}</th>`)
    .join('')}`,
  rowsHtml,
  '這個月份沒有資料。',
  6 + shareCols.length,
  'ranking',
)}
<p class="note table-note">流量與「次數」是每月造訪次數，k、m、b 分別是千、百萬、十億。成長與「${prevHead}」名次都與${from ? ` ${monthLong(from)} ` : '前一個月'}比較。流量之後各欄是導流來源（台灣是台灣訪客）：「%」是占全部造訪的比例，「次數」是流量 × 比例換算的造訪次數（搜尋次數即試算表的「搜尋S」）${show === 'change' ? `；目前顯示與 ${from ? monthLong(from) : ''} 的差距，${unit === 'share' ? '▲1.2 表示多 1.2 個百分點' : '▲ 為增加的造訪次數'}` : ''}。直接、社群等來源只有 Similarweb 有，搜尋、AI、台灣在 Similarweb 沒有的月份用試算表；Similarweb 每月只給最新一個月的組成。點表頭可排序。</p></section>`,
    { nav: 'table' },
  );
}

/**
 * 0–1 by rank among the values, curved so that only the top few come out
 * large; equal values share a size and null stays at 0.
 */
const rankScale = (values: Array<number | null>) => {
  const known = [...new Set(values.filter((v): v is number => v !== null && v > 0))].sort((a, b) => a - b);
  return (v: number | null) => (v === null || v <= 0 || known.length < 2 ? (v ? 1 : 0) : (known.indexOf(v) / (known.length - 1)) ** 2.2);
};
const statCard = (label: string, value: string, sub = '') =>
  `<div><span>${label}</span><b>${value || '—'}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
const CLOUD_SCRIPT = `<script>
(() => {
  const cloud = document.querySelector('.cloud');
  document.querySelectorAll('[data-cloud]').forEach((button) => button.addEventListener('click', () => {
    cloud.dataset.by = button.dataset.cloud;
    document.querySelectorAll('[data-cloud]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  }));
})();
</script>`;

export function topicsPage(data: TopicOverview, topic?: string) {
  const selected = data.topics.find((t) => t.topic === topic);
  const members = selected ? data.sites.filter((s) => s.topics.includes(selected.topic)) : [];
  const period = data.months.length
    ? `${monthLong(data.months[0])} 至 ${monthLong(data.months.at(-1) as string)}，共 ${data.months.length} 個有流量資料的月份`
    : '尚無流量資料';
  const topicHref = (t: string) => `/tag/?topic=${encodeURIComponent(t)}`;
  const method = section(
    '標籤如何計算',
    '<p class="note">以網站目前的標籤彙整全部歷史流量。每個標籤內，同一網域只計為一個網站，尚無流量資料的網站也列入。累計造訪量加總各網站所有已知月份；各站資料月數可能不同，缺少的月份不補零。搜尋與 AI 占比分別以有該項資料的網站月份加權計算。多標籤網站會計入各個標籤，標籤之間的流量不可直接相加。資料月數不同的網站可用「月平均」比較。標籤雲依累計造訪量或網站數的排名決定字級；「前 5 大網站占比」是這 5 個網站的累計造訪量占標籤總量的比例。</p>',
  );
  if (selected) {
    const known = members.filter((s) => s.visits !== null).map((s) => s.visits as number);
    const total = known.reduce((a, b) => a + b, 0);
    const topShare = (n: number) => (total > 0 ? known.slice(0, n).reduce((a, b) => a + b, 0) / total : null);
    // Members are sorted by cumulative visits, so the first one is the largest.
    const leader = members.find((s) => s.visits !== null);
    const together = new Map<string, number>();
    for (const s of members) for (const t of s.topics) if (t !== selected.topic) together.set(t, (together.get(t) ?? 0) + 1);
    const pairs = [...together].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-TW')).slice(0, 16);
    const memberRows = members
      .map(
        (s) =>
          `<tr>${siteCell(s.domain, s.name)}${sortCell(
            'l',
            s.topics.join('、'),
            tagLinks(s.topics, topicHref),
          )}<td class="num">${s.months}</td>${volCell(s.visits, '—')}${volCell(s.visits !== null && s.months ? s.visits / s.months : null, '—')}<td class="num">${total > 0 && s.visits !== null ? pct(s.visits / total) : '—'}</td><td class="num">${pct(s.searchShare, 2) || '—'}</td><td class="num">${pct(s.aiShare, 2) || '—'}</td></tr>`,
      )
      .join('');
    return layout(
      `${selected.topic}・標籤概況`,
      {
        title: selected.topic,
        dek: `這個標籤的所有網站與累計流量（${period}）`,
        actions: `<a href="/tag/">← 全部標籤</a><a href="/#topic=${encodeURIComponent(selected.topic)}">本月排行</a>`,
      },
      `<div class="stats">${statCard('網站數', String(selected.sites), `${selected.sitesWithData} 個有流量資料`)}${statCard('累計造訪', vol(selected.visits), '加總所有已知月份')}${statCard('流量最大的網站', leader ? `<a href="/site/${html(leader.domain)}/" title="${html(leader.name)}">${html(leader.name)}</a>` : '', leader && topShare(1) !== null ? `占 ${pct(topShare(1))}` : '')}${statCard('前 5 大網站占比', pct(topShare(5)), known.length > 5 ? `其餘 ${known.length - 5} 個網站占 ${pct(1 - (topShare(5) as number))}` : '')}${statCard('搜尋占比', pct(selected.searchShare, 1))}${statCard('AI 占比', pct(selected.aiShare, 2))}</div>
${
  pairs.length
    ? section(
        '常一起出現的標籤',
        `<p class="note">這個標籤的網站同時掛著哪些標籤；數字是網站數。</p><div class="chips">${pairs
          .map(([t, n]) => `<a href="${topicHref(t)}">${html(t)}<small>${n}</small></a>`)
          .join('')}</div>`,
      )
    : ''
}
<section class="block"><h2>網站清單</h2><div class="toolbar">${tableSearch('members', '搜尋網站名稱或網域')}</div><p class="results-line" data-table-count="members" data-total="${selected.sites}">${selected.sites} 個網站・累計造訪量 ${volText(selected.visits) || '—'}</p>${table(
        '<th class="l">網站</th><th class="l">標籤</th><th class="num">有資料月數</th><th class="num" aria-sort="descending">累計造訪量</th><th class="num" title="累計造訪量除以有資料月數；資料月數不同的網站用這欄比較">月平均</th><th class="num">占標籤流量</th><th class="num">搜尋占比</th><th class="num">AI 占比</th>',
        memberRows,
        '尚無網站。',
        8,
        'members',
      )}</section>${method}`,
      { nav: 'topics' },
    );
  }

  // The three largest sites of each tag; data.sites is sorted by cumulative visits.
  const leaders = new Map<string, Array<(typeof data.sites)[number]>>();
  for (const s of data.sites) {
    if (s.visits === null) continue;
    for (const t of s.topics) {
      const list = leaders.get(t) ?? [];
      if (list.length < 3) leaders.set(t, [...list, s]);
    }
  }
  const tagged = data.sites.filter((s) => s.topics.length);
  const byVisits = rankScale(data.topics.map((t) => t.visits));
  const bySites = rankScale(data.topics.map((t) => t.sites));
  const cloud = [...data.topics]
    .sort((a, b) => a.topic.localeCompare(b.topic, 'zh-TW'))
    .map(
      (t) =>
        `<a href="${topicHref(t.topic)}" style="--v:${byVisits(t.visits).toFixed(3)};--s:${bySites(t.sites).toFixed(3)}" title="${html(t.topic)}：${t.sites} 個網站，累計 ${volText(t.visits) || '—'}">${html(t.topic)}<small>${t.sites}</small></a>`,
    )
    .join('');
  const rowsHtml = data.topics
    .map((t) => {
      const top = leaders.get(t.topic) ?? [];
      return `<tr><td class="l"><a class="site-name" href="${topicHref(t.topic)}">${html(t.topic)}</a></td><td class="num">${t.sites}</td><td class="num">${t.sitesWithData}</td>${volCell(t.visits, '—')}${volCell(t.visits !== null && t.sitesWithData ? t.visits / t.sitesWithData : null, '—')}<td class="num">${pct(t.searchShare, 2) || '—'}</td><td class="num">${pct(t.aiShare, 2) || '—'}</td><td class="l"><span class="leaders">${top
        .map((s) => `<a href="/site/${html(s.domain)}/" title="${html(s.domain)}・累計 ${volText(s.visits)}">${html(s.name)}</a>`)
        .join('、')}</span></td></tr>`;
    })
    .join('');
  return layout(
    '標籤概況',
    {
      title: '標籤概況',
      dek: '每個標籤的網站數與累計流量，點標籤看網站清單',
    },
    `<div class="stats">${statCard('標籤', String(data.topics.length))}${statCard('有標籤的網站', tagged.length.toLocaleString('en-US'), `共 ${data.sites.length.toLocaleString('en-US')} 個網站`)}${statCard('每站平均標籤', tagged.length ? (tagged.reduce((a, s) => a + s.topics.length, 0) / tagged.length).toFixed(1) : '', '一個網站可掛多個標籤')}${statCard('統計月份', String(data.months.length), data.months.length ? `${monthLabel(data.months[0])}–${monthLabel(data.months.at(-1) as string)}` : '尚無流量資料')}</div>
<section class="block"><header><h2>標籤雲</h2><span class="seg" role="group" aria-label="字的大小依據"><button type="button" data-cloud="visits" aria-pressed="true">累計造訪</button><button type="button" data-cloud="sites" aria-pressed="false">網站數</button></span></header>
<p class="note">字愈大、顏色愈亮，排名愈前面；右上的小數字是網站數。</p><div class="cloud" data-by="visits">${cloud}</div></section>
<section class="block"><h2>全部標籤</h2><div class="toolbar">${tableSearch('topics', '搜尋標籤')}</div><p class="results-line" data-table-count="topics" data-total="${data.topics.length}">${data.topics.length} 個標籤</p>${table(
      '<th class="l">標籤</th><th class="num">網站數</th><th class="num">有流量資料</th><th class="num" aria-sort="descending">累計造訪量</th><th class="num" title="累計造訪量除以有流量資料的網站數">每站平均</th><th class="num">搜尋占比</th><th class="num">AI 占比</th><th class="l" data-nosort>流量最大的網站</th>',
      rowsHtml,
      '尚無標籤。',
      8,
      'topics',
    )}</section>${method}${CLOUD_SCRIPT}`,
    { nav: 'topics' },
  );
}

export interface SitePage {
  domain: string;
  name: string;
  topics: string[];
  /** Every tag with where it came from and its votes (crowd.ts); topics are the visible ones. */
  tags: TagItem[];
  labels: Array<{ month: string; group: string | null; topics: string | null; name: string; visits: number | null; adjusted: boolean }>;
  months: Array<{
    month: string;
    similarweb: number | null;
    sheet: number | null;
    searchShare: number | null;
    aiShare: number | null;
    taiwanShare: number | null;
    /** Similarweb answered for this month but had no estimate (0 visits). */
    noEstimate?: boolean;
    /** Millions, entered by hand from Similarweb's platform. */
    manual?: number | null;
  }>;
  /** The newest month Similarweb profiled with an estimate (similarweb.ts TrafficProfile), or null. */
  profile: TrafficProfile | null;
  /** Every month Similarweb profiled with an estimate, oldest first. */
  profiles: TrafficProfile[];
  /** Similarweb's category for the domain, from the last fetch. */
  category: string | null;
  similarSites: string[];
  watchers: Array<{ requester: string; kind: string; requestedAt: string }>;
  radar: RadarPeriod[];
  state: {
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;
    failures: number;
    lastError: string | null;
  } | null;
}

/** Every calendar month from first to last, so missing months show as gaps. */
const calendar = (first: string, last: string) => {
  const out: string[] = [];
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(4));
  for (let at = first; at <= last; at = `${y}${String(m).padStart(2, '0')}`) {
    out.push(at);
    m++;
    if (m > 12) {
      y++;
      m = 1;
    }
  }
  return out;
};
const niceMax = (v: number) => {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((f) => f * p >= v) ?? 10) * p;
};

/**
 * One measure over calendar months as inline SVG: zero-based y axis, a 2px
 * line broken wherever a month is missing (never interpolated), a dot per
 * month (hollow when the number came from the sheet) and a hover tooltip.
 * Drawn twice, at the width it is shown on a desktop and on a phone (CSS
 * shows one), so tick labels stay at their real size instead of scaling.
 */
export function lineChart(
  points: Array<{ month: string; value: number | null; sheet?: boolean }>,
  { label, fmt, height = 220, wide = 960 }: { label: string; fmt: (v: number) => string; height?: number; wide?: number },
) {
  const known = points.filter((p) => p.value !== null);
  if (!known.length) return '<p class="empty">沒有資料。</p>';
  const months = calendar(known[0].month, known.at(-1)?.month as string);
  const byMonth = new Map(points.map((p) => [p.month, p]));
  const max = niceMax(Math.max(...known.map((p) => p.value as number)) * 1.05);
  const draw = (W: number, H: number) => {
    const L = 48;
    const R = 16;
    const T = 10;
    const B = 26;
    const x = (i: number) => (months.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (months.length - 1));
    const y = (v: number) => T + (H - T - B) * (1 - v / max);
    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((f) => {
        const v = max * f;
        return `<line class="${f ? 'gridline' : 'baseline'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
      })
      .join('');
    // About one month label per 80px; the last month always, and never crowded by the one before it.
    const step = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor((W - L - R) / 80))));
    const ticks = months
      .map((m, i) => {
        const last = i === months.length - 1;
        if (!last && (i % step !== 0 || months.length - 1 - i < step * 0.6)) return '';
        return `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : last ? 'end' : 'middle'}">${m.slice(2, 4)}/${m.slice(4)}</text>`;
      })
      .join('');
    const segments: string[][] = [];
    let run: string[] = [];
    months.forEach((m, i) => {
      const p = byMonth.get(m);
      if (p?.value == null) {
        if (run.length) segments.push(run);
        run = [];
      } else run.push(`${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
    });
    if (run.length) segments.push(run);
    const lines = segments.map((seg) => `<path class="line" d="M${seg.join('L')}"/>`).join('');
    const half = months.length > 1 ? (W - L - R) / (months.length - 1) / 2 : (W - L - R) / 2;
    const marks = months
      .map((m, i) => {
        const p = byMonth.get(m);
        const tip = `${monthLong(m)}：${p?.value == null ? '沒有資料' : `${fmt(p.value)}${p.sheet ? '（試算表）' : ''}`}`;
        // Where months sit closer than 18px (phones), only months without a neighbour keep a dot, so the line stays readable.
        const alone = byMonth.get(months[i - 1])?.value == null && byMonth.get(months[i + 1])?.value == null;
        const dot =
          p?.value == null || (half * 2 < 18 && !alone)
            ? ''
            : `<circle class="dot${p.sheet ? ' sheet' : ''}" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4"/>`;
        return `${dot}<rect class="hit" x="${(x(i) - half).toFixed(1)}" y="${T}" width="${(half * 2).toFixed(1)}" height="${H - T - B}" data-tip="${html(tip)}"/>`;
      })
      .join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${html(label)}">${grid}${ticks}${lines}${marks}</svg>`;
  };
  return `<div class="chart-wide">${draw(wide, height)}</div><div class="chart-narrow">${draw(340, Math.round(height * 0.85))}</div>`;
}

const DUE_LABEL: Record<string, string> = {
  new: '新網域，還沒抓過',
  refresh: '到了更新週期',
  'catch-up': '還缺上個月的資料',
  lookup: '單次查詢',
};
const KIND_LABEL: Record<string, string> = { watch: '定期追蹤', traffic: '單次查詢（流量）', similar_sites: '單次查詢（相似網站）' };

// Similarweb's channels and categories in plain words. Categories missing here read as Similarweb writes them.
const CHANNELS: Array<[TrafficChannel, string, string]> = [
  ['Direct', '直接造訪', '輸入網址、書籤或 App 開啟'],
  ['SearchOrganic', '自然搜尋', 'Google 等搜尋結果，不含廣告'],
  ['SearchPaid', '搜尋廣告', '搜尋結果上的付費廣告'],
  ['SocialOrganic', '社群', 'Facebook、Threads、LINE 等貼文連結'],
  ['SocialPaid', '社群廣告', '社群平台上的付費廣告'],
  ['Referrals', '其他網站連入', '從其他網站的連結點進來'],
  ['Mail', '電子郵件', '電子報與郵件中的連結'],
  ['DisplayAds', '展示型廣告', '橫幅等網頁廣告'],
  ['GenAi', 'AI 工具', 'ChatGPT、Perplexity 等 AI 助理的連結'],
  ['Affiliate', '聯盟行銷', '導購與分潤連結'],
];
/** The channels the full table adds after 搜尋占比 and AI 占比 (which cover SearchOrganic and GenAi), with short heads. */
const TABLE_CHANNELS: Array<[TrafficChannel, string]> = [
  ['Direct', '直接'],
  ['SocialOrganic', '社群'],
  ['SocialPaid', '社群廣告'],
  ['Referrals', '其他網站'],
  ['Mail', '郵件'],
  ['DisplayAds', '展示廣告'],
  ['SearchPaid', '搜尋廣告'],
  ['Affiliate', '聯盟'],
];
const CATEGORY: Record<string, string> = {
  News_and_Media: '新聞與媒體',
  Computers_Electronics_and_Technology: '電腦、電子與科技',
  Programming_and_Developer_Software: '程式與開發工具',
  Social_Networks_and_Online_Communities: '社群網路與論壇',
  Consumer_Electronics: '消費電子',
  Graphics_Multimedia_and_Web_Design: '設計與多媒體',
  Computer_Hardware: '電腦硬體',
  Food_and_Drink: '餐飲',
  Restaurants_and_Delivery: '餐廳與外送',
  Cooking_and_Recipes: '料理與食譜',
  Finance: '金融',
  Investing: '投資',
  Financial_Planning_and_Management: '理財',
  Lifestyle: '生活風格',
  Fashion_and_Apparel: '時尚服飾',
  Beauty_and_Cosmetics: '美妝',
  Travel_and_Tourism: '旅遊',
  Tourist_Attractions: '景點',
  Accommodation_and_Hotels: '住宿',
  'E-commerce_and_Shopping': '電商購物',
  Coupons_and_Rebates: '優惠與回饋',
  Marketplace: '購物平台',
  Business_and_Consumer_Services: '商業與消費服務',
  Real_Estate: '房地產',
  Law_and_Government: '法律與政府',
  Government: '政府',
  Arts_and_Entertainment: '藝術與娛樂',
  TV_Movies_and_Streaming: '影視與串流',
  Animation_and_Comics: '動畫與漫畫',
  Music: '音樂',
  Games: '遊戲',
  Video_Games_Consoles_and_Accessories: '電玩',
  Health: '健康',
  Jobs_and_Career: '求職與職涯',
  Jobs_and_Employment: '求職',
  Community_and_Society: '社區與社會',
  Faith_and_Beliefs: '宗教信仰',
  Pets_and_Animals: '寵物與動物',
  Pets: '寵物',
  Vehicles: '汽機車',
  Sports: '運動',
  Science_and_Education: '科學與教育',
  Education: '教育',
  Hobbies_and_Leisure: '嗜好與休閒',
  Home_and_Garden: '居家與園藝',
  Gambling: '博弈',
  Adult: '成人',
};
/** "Finance/Investing" → 金融 › 投資; a repeated level ("Health/Health") is shown once. */
export const categoryLabel = (raw: string) =>
  [...new Set(raw.split('/'))].map((part) => CATEGORY[part] ?? part.replace(/_/g, ' ')).join(' › ');
const REGION = new Intl.DisplayNames(['zh-TW'], { type: 'region' });
const REGION_SHORT: Record<string, string> = { HK: '香港', MO: '澳門', CN: '中國' };
const regionName = (code: string) => REGION_SHORT[code] ?? REGION.of(code) ?? code;
const duration = (seconds: number) => {
  const s = Math.round(seconds);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
};
/** One row per share: name and what it means, a bar, the percentage and, given visits, the visits it stands for. */
const shareRows = (items: Array<{ label: string; hint?: string; share: number }>, visits: number | null) =>
  `<ul class="share-list">${items
    .map(
      (i) =>
        `<li${i.share ? '' : ' class="zero"'}><span class="share-name">${html(i.label)}${i.hint ? `<small>${html(i.hint)}</small>` : ''}</span><span class="share-bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, i.share * 100)).toFixed(1)}%"></i></span><b>${pct(i.share, i.share && i.share < 0.0095 ? 2 : 1)}</b>${visits === null ? '' : `<small class="share-visits">${i.share ? `約 ${volText(visits * i.share)}` : ''}</small>`}</li>`,
    )
    .join('')}</ul>`;

/** Everything Similarweb said about the newest profiled month: ranks, engagement, every channel, the top countries. */
export function similarwebSection(site: Pick<SitePage, 'domain' | 'profile' | 'category' | 'similarSites' | 'months'>) {
  const p = site.profile;
  if (!p) return '';
  const visits = site.months.find((m) => m.month === p.month)?.similarweb ?? null;
  const card = (label: string, value: string, sub = '') =>
    `<div><span>${label}</span><b>${value || '—'}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const rankText = (n: number | null | undefined) => (n ? `#${n.toLocaleString('en-US')}` : '');
  const category = p.categoryRank?.category ?? site.category;
  const cards = `<div class="stats">${card('全球排名', rankText(p.globalRank), '在全世界所有網站中')}${card(
    p.countryRank ? `${html(regionName(p.countryRank.code))}排名` : '國家排名',
    rankText(p.countryRank?.rank),
    p.countryRank ? `在${html(regionName(p.countryRank.code))}所有網站中` : '',
  )}${card('類別排名', rankText(p.categoryRank?.rank), category ? html(categoryLabel(category)) : '')}${card(
    '平均停留',
    p.timeOnSite ? duration(p.timeOnSite) : '',
    '每次造訪',
  )}${card('每次造訪頁數', p.pagesPerVisit ? p.pagesPerVisit.toFixed(2) : '', '平均看幾頁')}${card(
    '跳出率',
    p.bounceRate === null ? '' : pct(p.bounceRate),
    '只看一頁就離開',
  )}</div>`;
  const channels = CHANNELS.map(([key, label, hint]) => ({ label, hint, share: p.channels[key] ?? 0 })).sort((a, b) => b.share - a.share);
  const countryTotal = p.countries.reduce((a, c) => a + c.share, 0);
  const countries = [
    ...p.countries.map((c) => ({ label: regionName(c.code), share: c.share })),
    ...(countryTotal < 0.999 ? [{ label: '其他國家', share: 1 - countryTotal }] : []),
  ];
  const similar = site.similarSites.length
    ? `<h3>相似網站</h3><p class="tags">${site.similarSites.map((d) => `<a class="tag" href="/site/${html(d)}/">${html(d)}</a>`).join('')}</p>`
    : '';
  return section(
    `流量組成 <small>Similarweb・${monthLong(p.month)}</small>`,
    `<p class="note">Similarweb 每次只提供最新一個月的組成，所以這裡只有 ${monthLong(p.month)}${visits === null ? '' : `（當月造訪 ${volText(visits)}）`}。各項是占全部造訪的比例，「約」是依比例換算的造訪次數。</p>${cards}
<div class="charts"><div class="chart-box"><h3>訪客從哪裡來</h3>${shareRows(channels, visits)}</div><div class="chart-box"><h3>訪客在哪個國家</h3>${shareRows(countries, visits)}</div></div>${similar}
<details class="method-note"><summary>這些數字怎麼來的</summary><ul class="body">
<li>來源是 Similarweb 免費資料（瀏覽器擴充功能用的端點），由本站每月抓取一次並保存；Similarweb 的數字是估算，小網站誤差較大。</li>
<li>排名：全球與國家排名依 Similarweb 估算的造訪量；類別排名只和同一類別（${category ? html(categoryLabel(category)) : 'Similarweb 的分類'}）的網站比較。</li>
<li>平均停留、每次造訪頁數、跳出率都是所有造訪的平均；跳出率是只看一頁就離開的造訪比例。</li>
<li>導流來源的「自然搜尋」不含搜尋廣告；「AI 工具」是從 ChatGPT 等 AI 助理點進來的造訪。排行上的搜尋占比、AI 占比用的就是這兩項。</li>
<li>國家只列前 5 名，「其他國家」是其餘合計。</li>
</ul></details>`,
  );
}

/**
 * A change in share as percentage points, with ▲▼. Neutral ink: a source gaining share is neither good nor bad,
 * so the status colors stay out of it. Under 0.005 points reads as 持平.
 */
const points = (change: number | null, unit = ' 個百分點') =>
  change === null
    ? ''
    : Math.abs(change) < 0.00005
      ? '<span class="shift">持平</span>'
      : `<span class="shift">${change < 0 ? '▼' : '▲'}${Math.abs(change * 100).toFixed(Math.abs(change) < 0.001 ? 2 : 1)}${unit}</span>`;
/**
 * One small line chart per traffic channel (small multiples rather than ten colors on one chart). Each has its
 * own scale from 0, so a small channel's movement shows; the head gives the latest share and the change from
 * the month before. Channels are ordered by their latest share, largest first.
 */
export function channelTiles(months: Array<{ month: string; shares: Partial<Record<TrafficChannel, number>> }>) {
  if (!months.length) return '<p class="note muted">還沒有 Similarweb 的導流來源資料。</p>';
  const last = months.at(-1) as (typeof months)[number];
  const prev = months.at(-2);
  const tiles = CHANNELS.map(([key, label, hint]) => ({ key, label, hint, now: last.shares[key] ?? 0 }))
    .sort((a, b) => b.now - a.now)
    .map(({ key, label, hint, now }) => {
      const before = prev ? (prev.shares[key] ?? 0) : null;
      const chart = lineChart(
        months.map((m) => ({ month: m.month, value: m.shares[key] ?? 0 })),
        { label: `${label}占比`, fmt: (v) => `${(v * 100).toFixed(!v ? 0 : v < 0.01 ? 2 : v < 0.1 ? 1 : 0)}%`, height: 150, wide: 420 },
      );
      return `<div class="chart-box channel-tile${now ? '' : ' zero'}"><h3>${html(label)} <b>${pct(now, now && now < 0.0095 ? 2 : 1)}</b>${before === null ? '' : points(now - before)}</h3><p class="note">${html(hint)}</p>${chart}</div>`;
    })
    .join('');
  return `<div class="channel-tiles">${tiles}</div>`;
}
const monthsNote = (n: number, first: string) =>
  n < 2
    ? `目前只有 ${monthLong(first)} 一個月；Similarweb 每月只給最新一個月，之後每個月抓到就會連成折線。`
    : `${monthLong(first)} 起共 ${n} 個月。`;

const TAG_SOURCE: Record<TagItem['source'], string> = {
  editor: '編輯',
  sheet: '試算表',
  ai: 'AI 初判',
  community: '讀者',
  admin: '管理員',
};
export const TAG_MESSAGES: Record<string, string> = {
  done: '已更新標籤。',
  invalid_tag: `標籤需含文字或數字，最多 ${TAG_LIMIT} 字，不能有逗號、頓號或斜線。`,
  invalid_vote: '投票只能是同意、不同意或收回。',
  invalid_action: '管理動作只能是指定顯示、隱藏或解除覆寫。',
  not_admin: '只有管理員可以覆寫標籤。',
  rate_limited: '操作太頻繁，請一分鐘後再試。',
  unknown_tag: '這個網站沒有這個標籤。',
  reserved_tag: '政治傾向不是標籤，由 tag.observe.tw 另外處理。',
};
/** Who is looking at a site page, for its tag block. */
export interface TagViewer {
  loginEnabled: boolean;
  signedIn: boolean;
  admin: boolean;
  /** This viewer's votes: tag → 1 or -1. */
  votes: Record<string, number>;
  /** A key of TAG_MESSAGES after a vote or an edit. */
  message?: string;
}
/** The tag block: every tag with its source and votes; signed-in readers vote and add, admins override one tag. */
export function tagPanel(domain: string, tags: TagItem[], viewer: TagViewer) {
  const action = `/site/${html(domain)}/tags/`;
  const form = (kind: string, tag: string, buttons: string) =>
    `<form class="inline" method="post" action="${action}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="tag" value="${html(tag)}">${buttons}</form>`;
  const button = (value: string | number, label: string, pressed?: boolean) =>
    `<button type="submit" class="quiet" name="value" value="${value}"${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}>${label}</button>`;
  const items = tags
    .map((t) => {
      const mine = viewer.votes[t.tag] ?? 0;
      // Admins override instead of voting (crowd.ts), so they get the override buttons only.
      const votes =
        viewer.signedIn && !viewer.admin
          ? form(
              'vote',
              t.tag,
              `${button(mine === 1 ? 0 : 1, mine === 1 ? '已同意（收回）' : '同意', mine === 1)}${button(mine === -1 ? 0 : -1, mine === -1 ? '已不同意（收回）' : '不同意', mine === -1)}`,
            )
          : '';
      const admin = viewer.admin
        ? form(
            'admin',
            t.tag,
            `${t.adminOverride === 'set' ? '' : button('set', '指定顯示')}${t.adminOverride === 'hide' ? '' : button('hide', '隱藏')}${t.adminOverride ? button('release', '解除覆寫') : ''}`,
          )
        : '';
      return `<li><a class="chip-filter${t.visible ? '' : ' muted-chip'}" href="/#topic=${encodeURIComponent(t.tag)}&hl=${encodeURIComponent(domain)}">${html(t.tag)}</a><span class="note">${TAG_SOURCE[t.source]}${t.visible ? '' : '・未顯示'}${t.adminOverride ? '（管理員覆寫）' : ''}・同意 ${t.agrees}・不同意 ${t.disagrees}</span><span class="tag-vote-actions">${votes}${admin}</span></li>`;
    })
    .join('');
  const add = viewer.signedIn
    ? `<form class="tag-propose" method="post" action="${action}"><input type="hidden" name="kind" value="propose"><input name="tag" aria-label="新增標籤" placeholder="新增標籤，例如：咖啡" maxlength="${TAG_LIMIT * 2}" autocomplete="off" required><button type="submit" class="quiet">新增</button></form>`
    : viewer.loginEnabled
      ? `<p class="note"><a href="/auth/google?next=${encodeURIComponent(`/site/${domain}/#tags`)}">用 Google 帳號登入</a>後可以同意、不同意或新增標籤。</p>`
      : '';
  const message = viewer.message ? TAG_MESSAGES[viewer.message] : '';
  return section(
    '標籤',
    `${message ? `<p class="flash" role="${viewer.message === 'done' ? 'status' : 'alert'}">${html(message)}</p>` : ''}<p class="note">編輯清單的標籤一律顯示；AI 初判在不同意比同意多 2 票時隱藏；讀者新增的標籤立即顯示，不同意追上同意時隱藏。管理員不投票，直接指定單一標籤顯示或隱藏，優先於所有規則。</p>${
      items ? `<ul class="tag-votes">${items}</ul>` : '<p class="note muted">還沒有標籤。</p>'
    }${add}`,
    ' id="tags"',
  );
}

export function sitePage(site: SitePage, canEdit = false, viewer?: TagViewer) {
  const ordered = [...site.months].sort((a, b) => a.month.localeCompare(b.month));
  const visitsAt = (m: SitePage['months'][number]) => m.similarweb ?? m.manual ?? m.sheet;
  const originOf = (m: SitePage['months'][number]) =>
    m.similarweb !== null ? '' : m.manual != null ? '・Similarweb 平台（手動補登）' : '・試算表';
  const hasManual = site.months.some((m) => m.manual != null);
  const noEstimate = site.months.some((m) => m.noEstimate);
  const latest = [...ordered].reverse().find((m) => visitsAt(m) !== null);
  const latestShare = (key: 'searchShare' | 'aiShare' | 'taiwanShare') => [...ordered].reverse().find((m) => m[key] !== null);
  const radarNow = site.radar.at(-1);
  const stat = (label: string, value: string, sub = '') =>
    `<div><span>${label}</span><b>${value || '—'}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const shareStat = (label: string, key: 'searchShare' | 'aiShare' | 'taiwanShare', digits = 1) => {
    const m = latestShare(key);
    return stat(label, m ? pct(m[key], digits) : '', m ? monthLabel(m.month) : '');
  };
  const stats = `<div class="stats">${stat('最新造訪量', latest ? vol(visitsAt(latest)) : '', latest ? `${monthLabel(latest.month)}${originOf(latest)}` : '')}${shareStat('搜尋占比', 'searchShare')}${shareStat('AI 占比', 'aiShare', 2)}${shareStat('台灣占比', 'taiwanShare')}${stat('Radar 最新', radarNow ? radarLabel(radarNow) : '', radarNow ? twDate(radarNow.dateEnd) : '')}</div>`;

  const visitsChart = lineChart(
    ordered.map((m) => ({ month: m.month, value: visitsAt(m), sheet: m.similarweb === null && visitsAt(m) !== null })),
    { label: '每月造訪', fmt: volText },
  );
  const shareChart = (key: 'searchShare' | 'aiShare', digits: number, label: string) =>
    lineChart(
      ordered.map((m) => ({ month: m.month, value: m[key] })),
      { label, fmt: (v) => `${(v * 100).toFixed(digits)}%`, height: 190, wide: 440 },
    );
  const monthRows = [...ordered]
    .reverse()
    .map(
      (m) =>
        `<tr><td class="l" data-v="${m.month}">${monthLabel(m.month)}</td>${sortCell('num', m.similarweb, m.noEstimate ? '<span class="muted" title="Similarweb 回傳 0，表示這個月沒有估算">無估算</span>' : vol(m.similarweb))}${hasManual ? volCell(m.manual ?? null) : ''}${volCell(m.sheet)}<td class="num">${pct(m.searchShare)}</td><td class="num">${pct(m.aiShare, 2)}</td><td class="num">${pct(m.taiwanShare)}</td></tr>`,
    )
    .join('');
  const labelRows = [...site.labels]
    .reverse()
    .map(
      (l) =>
        `<tr><td class="l" data-v="${l.month}">${monthLabel(l.month)}</td><td class="l">${html(l.name)}</td><td class="l">${html(l.group)}</td><td class="l">${html(l.topics)}</td><td class="num"${l.visits === null ? '' : ` data-v="${l.visits}"`}>${vol(l.visits)}${l.adjusted ? '<span class="tag">人工調整</span>' : ''}</td></tr>`,
    )
    .join('');
  const radarRows = [...site.radar]
    .reverse()
    .map(
      (r) =>
        `<tr>${sortCell('l', r.dateEnd, twDate(r.dateEnd))}${sortCell('l', radarSort(r), radarLabel(r))}${sortCell('l', r.fetchedAt, tw(r.fetchedAt))}</tr>`,
    )
    .join('');
  const topics = site.topics;
  const s = site.state;
  const fetchState = s
    ? `最近成功抓取 ${tw(s.lastSuccessAt) || '—'}；最近嘗試 ${tw(s.lastAttemptAt) || '—'}${s.nextAttemptAt ? `；下次最早 ${tw(s.nextAttemptAt)}` : ''}${s.failures ? `；連續失敗 ${s.failures} 次（${html(s.lastError)}）` : ''}。`
    : '尚未向 Similarweb 抓取。';
  const watchers = site.watchers.length
    ? site.watchers.map((w) => `${requesterLabel(w.requester)}・${KIND_LABEL[w.kind] ?? html(w.kind)}`).join('、')
    : '沒有服務追蹤這個網域。';
  return layout(
    site.name,
    {
      title: site.name,
      dek: `${favicon(site.domain, site.name)}<a href="https://${html(site.domain)}/" rel="noopener">${html(site.domain)} ↗</a>${topics.length ? tagLinks(topics, (topic) => `/#topic=${encodeURIComponent(topic)}&hl=${encodeURIComponent(site.domain)}`) : ''}`,
      actions: `${canEdit ? '' : `<a href="/auth/google?next=${encodeURIComponent(`/site/${site.domain}/`)}">登入編輯</a>`}<a href="/api/v1/sites/${html(site.domain)}">JSON</a>`,
      tabs: canEdit ? siteTabs(site.domain, 'overview') : '',
    },
    `${stats}
${viewer ? tagPanel(site.domain, site.tags, viewer) : ''}
${section(
  '每月造訪',
  `<p class="note">Similarweb 每月造訪估算；空心點是試算表或從 Similarweb 平台手動補登的月份，斷開處是沒有資料的月份。</p><div class="chart-box">${visitsChart}</div>`,
)}
${similarwebSection(site)}
${site.profiles.length ? section('導流來源走勢', `<p class="note">各來源占這個網站造訪的比例；各圖刻度不同，從 0 開始。${monthsNote(site.profiles.length, site.profiles[0].month)}</p>${channelTiles(site.profiles.map((p) => ({ month: p.month, shares: p.channels })))}`) : ''}
${section(
  '導流占比',
  `<p class="note">兩張圖各自的刻度：自然搜尋與 GenAI 導流占全部造訪的比例。Similarweb 只給最新一個月的占比，所以點常常不連續。</p>
<div class="charts"><div class="chart-box"><h3>搜尋占比</h3>${shareChart('searchShare', 0, '搜尋占比')}</div><div class="chart-box"><h3>AI 占比</h3>${shareChart('aiShare', 2, 'AI 占比')}</div></div>`,
)}
${section(
  '逐月數字',
  `${
    noEstimate
      ? `<p class="note">Similarweb 的免費資料沒有這個網站的造訪量估算（回傳 0），付費平台上可能有：<a href="${html(proUrl(site.domain))}" rel="noopener">在 Similarweb 平台查看 ↗</a>${canEdit ? `・<a href="/site/${html(site.domain)}/manual/">補登數字</a>` : ''}。</p>`
      : ''
  }${table(
    `<th class="l" aria-sort="descending">月份</th><th class="num">Similarweb</th>${hasManual ? '<th class="num" title="從 Similarweb 平台（Pro）手動補登">Pro 補登</th>' : ''}<th class="num">試算表</th><th class="num">搜尋占比</th><th class="num">AI 占比</th><th class="num">台灣占比</th>`,
    monthRows,
    '沒有月份資料。',
    hasManual ? 7 : 6,
  )}`,
)}
${
  radarRows
    ? section(
        'Cloudflare Radar 全球排名',
        `<p class="note">依 1.1.1.1 DNS 查詢的熱門程度；前 100 名才有名次，其餘只有級距。不能換算成造訪量。</p>${table('<th class="l" aria-sort="descending">資料日期</th><th class="l">排名</th><th class="l">抓取時間</th>', radarRows, '', 3)}`,
      )
    : ''
}
${
  labelRows
    ? section(
        '試算表紀錄',
        table(
          '<th class="l" aria-sort="descending">月份</th><th class="l">名稱</th><th class="l">標籤 A</th><th class="l">標籤 B</th><th class="num">流量</th>',
          labelRows,
          '',
          5,
        ),
      )
    : ''
}
${section('追蹤與抓取', `<p class="body">${watchers}</p><p class="note">${fetchState}</p>`)}`,
    { tips: true },
  );
}

export function notFoundPage(raw: string) {
  return layout(
    '找不到網站',
    { title: '沒有這個網站的資料', dek: `${html(raw)} 不在任何追蹤清單裡，也沒有抓到過資料。` },
    section('接下來', '<p class="body"><a href="/">回流量總覽</a>，或到<a href="/watch/">追蹤網域</a>登入後把它加進來。</p>'),
  );
}

export function statusPage(status: Awaited<ReturnType<typeof serviceStatus>>, manual: Awaited<ReturnType<typeof manualCandidates>> = []) {
  const manualRows = manual
    .map(
      (c) =>
        `<tr>${siteCell(c.domain, c.domain)}${sortCell('num', c.sheet?.visits ?? null, c.sheet ? `${vol(c.sheet.visits)} <span class="muted">${monthLabel(c.sheet.month)}</span>` : '—')}${sortCell('l', c.manual?.month ?? null, c.manual ? `${monthLabel(c.manual.month)}・${volText(c.manual.visits)}` : '<span class="muted">還沒有</span>')}<td class="l"><span class="links-inline"><a href="${html(proUrl(c.domain))}" rel="noopener">Similarweb 平台 ↗</a><a href="/site/${html(c.domain)}/manual/">補登</a></span></td></tr>`,
    )
    .join('');
  const manualSection = manualRows
    ? section(
        '需要從 Similarweb 平台補登',
        `<p class="note">這些網站在 Similarweb 免費資料裡沒有估算（最近一次抓取每個月都回傳 0），但試算表曾記錄到百萬次以上的造訪，付費平台上通常查得到。登入編輯後，每月打開平台頁面把數字補登進來；免費帳號只看得到最近一個月。</p>${table(
          '<th class="l">網域</th><th class="num">試算表最新</th><th class="l" aria-sort="descending">最新補登</th><th class="l" data-nosort>操作</th>',
          manualRows,
          '',
          4,
        )}`,
        ' id="manual"',
      )
    : '';
  const runs = status.runs
    .map(
      (r) =>
        `<tr>${sortCell('l', r.startedAt, tw(r.startedAt))}<td class="num">${r.budget}</td><td class="num">${r.sent}</td><td class="num">${r.ok}</td><td class="num">${r.failed}</td><td class="l">${r.refused ? '<span class="down">▼ 被拒</span> ' : ''}${html(r.note)}</td></tr>`,
    )
    .join('');
  const sent24 = Object.values(status.last24h).reduce((a, b) => a + b, 0);
  // The sheet's domains count as 手動 here too, so its rows merge into that one.
  const watchers = [
    ...status.watchers
      .reduce((m, w) => {
        const key = `${sourceOf(w.requester)}|${w.kind}`;
        return m.set(key, { ...w, requester: sourceOf(w.requester), domains: (m.get(key)?.domains ?? 0) + w.domains });
      }, new Map<string, (typeof status.watchers)[number]>())
      .values(),
  ];
  const priority = [...new Set(status.priority.map(sourceOf))];
  const q = status.queue;
  const queueRows = q.map(
    (e) =>
      `<tr${status.budget && e.position <= status.budget ? ' class="hl"' : ''}><td class="rank">${e.position}</td>${siteCell(e.domain, e.domain)}<td class="l">${e.requester ? requesterLabel(e.requester) : ''}</td><td class="l">${DUE_LABEL[e.reason] ?? html(e.reason)}</td>${sortCell('l', e.lastSuccessAt, e.lastSuccessAt ? twDate(e.lastSuccessAt) : '<span class="muted">從未</span>')}${sortCell('l', e.expectedAt, e.expectedAt ? tw(e.expectedAt) : '<span class="muted">不會送出</span>')}</tr>`,
  );
  const queueHead =
    '<th class="rank" aria-sort="ascending" title="抓取順序">#</th><th class="l">網域</th><th class="l">來源</th><th class="l">原因</th><th class="l">上次成功</th><th class="l">預計抓取</th>';
  const queueNote = q.length
    ? `<p class="note">共 ${q.length} 個網域等候抓取。${
        status.budget ? `下一輪預計 ${tw(q[0].expectedAt)}，最多 ${status.budget} 個（底色標示）。` : '目前暫停送出，以下為等候順序。'
      }排程之後到期的網域會依同樣規則接在後面。</p>`
    : '<p class="note">目前沒有到期的網域。</p>';
  const stats = `<div class="stats"><div><span>每輪上限</span><b>${status.budget}</b><small>${status.budget ? '每小時一輪，間隔 3 秒' : '0：目前不送出任何請求'}</small></div>
<div><span>追蹤網域</span><b>${status.watched}</b></div><div><span>目前到期</span><b>${status.due}</b><small><a href="#queue">看排程</a></small></div>
<div><span>近 24 小時請求</span><b>${sent24}</b><small>${
    Object.entries(status.last24h)
      .map(([k, v]) => `${html(k)} ${v}`)
      .join('・') || '沒有請求'
  }</small></div></div>`;
  return layout(
    '抓取狀態',
    {
      title: '抓取狀態',
      dek: 'Similarweb 的更新進度與接下來的抓取排程。',
      actions: '<a href="/api/v1/status">JSON</a>',
    },
    `${status.coolingDownUntil ? `<p class="flash"><span class="down">▼</span> 被拒後暫停至 ${tw(status.coolingDownUntil)}</p>` : ''}${stats}
${section(
  status.budget ? '下一輪抓取' : '等候抓取',
  `${queueNote}${table(queueHead, queueRows.join(''), '目前沒有到期的網域。', 6)}`,
  ' id="queue"',
)}
${manualSection}
${section(
  '排程方式與追蹤來源',
  `<p class="note">優先序：${priority.map(requesterLabel).join(' → ')}。每小時一輪；預計時間假設中途沒有被 Similarweb 擋，也沒有新網域插隊。</p>${table(
    '<th class="l">來源</th><th class="l">類型</th><th class="num">網域</th>',
    watchers
      .map(
        (w) =>
          `<tr><td class="l">${requesterLabel(w.requester)}</td><td class="l">${KIND_LABEL[w.kind] ?? html(w.kind)}</td><td class="num">${w.domains}</td></tr>`,
      )
      .join(''),
    '沒有追蹤者。',
    3,
  )}`,
)}
${section(
  '最近批次',
  table(
    '<th class="l" aria-sort="descending">開始</th><th class="num">上限</th><th class="num">送出</th><th class="num">成功</th><th class="num">失敗</th><th class="l">備註</th>',
    runs,
    '尚未執行。',
    6,
  ),
)}`,
    { nav: 'status' },
  );
}

/** The header's sign-in slot (layout leaves <!--who--> for it). */
export function whoSlot(user: { email: string } | null, loginEnabled: boolean, path: string) {
  if (user)
    return `<small>${html(user.email)}</small> <form method="post" action="/auth/logout"><button type="submit" class="quiet">登出</button></form>`;
  return loginEnabled ? `<a href="/auth/google?next=${encodeURIComponent(path)}">登入</a>` : '';
}

const LOGIN_ERRORS: Record<string, string> = {
  not_editor: '這個 Google 帳號可以投票，但沒有編輯權限。需要權限請聯絡管理者。',
  cancelled: '登入已取消。',
  state: '登入逾時或在另一個分頁開始，請再試一次。',
  failed: 'Google 登入失敗，請稍後再試。',
  invalid: 'Google 回傳的資料不正確，請再試一次。',
};
export function loginPage(error: string | undefined, enabled: boolean) {
  const message = error ? (LOGIN_ERRORS[error] ?? '登入失敗。') : null;
  return layout(
    '登入',
    { title: '登入', dek: '登入後可以對網站標籤投票或新增標籤，編輯另可管理網域與標籤；瀏覽資料不需登入。' },
    `${message ? `<p class="flash">${html(message)}</p>` : ''}${section(
      '用 Google 帳號登入',
      enabled
        ? '<p class="body">任何 Google 帳號都可以登入投票；只有名單上的編輯可以管理網域、名稱與標籤清單。</p><p><a href="/auth/google?next=/">用 Google 帳號登入</a></p>'
        : '<p class="body muted">登入尚未設定。</p>',
    )}`,
  );
}

const REQUESTER_LABEL: Record<string, string> = {
  manual: '手動',
  tag: '媒體（tag）',
  blog: '部落格（blog）',
  // The sheet's list is hand-curated too; it is not shown on its own.
  sheet: '手動',
};
/** The source a requester belongs to on the pages: the sheet and /watch/ are both 「手動」. */
export const sourceOf = (requester: string) => (requester === 'sheet' ? 'manual' : requester);
export const SOURCE_LABEL: Record<string, string> = { tag: '媒體（tag）', blog: '部落格（blog）', manual: '手動' };
const requesterLabel = (r: string) => html(REQUESTER_LABEL[r] ?? r);

export function watchPage({
  editor,
  loginEnabled,
  manual,
  others,
  flash,
  list = null,
  queue = new Map(),
}: {
  editor: { email: string } | null;
  loginEnabled: boolean;
  manual: WatchRow[];
  others: Array<{ requester: string; domains: number }>;
  flash: string | null;
  /** Another requester's standing list, shown read-only. */
  list?: { requester: string; rows: WatchRow[] } | null;
  /** Where each due domain stands in the fetch queue. */
  queue?: Map<string, QueueEntry>;
}) {
  const queued = (w: WatchRow) => {
    const e = queue.get(w.domain);
    return e
      ? `<span class="muted" title="${html(DUE_LABEL[e.reason] ?? e.reason)}">排第 ${e.position} 位${e.expectedAt ? `・預計 ${tw(e.expectedAt)}` : ''}</span>`
      : null;
  };
  const state = (w: WatchRow) =>
    w.lastSuccessAt
      ? `<span class="up">${tw(w.lastSuccessAt.toISOString())}</span>`
      : w.lastResponseAt
        ? `<span class="muted" title="Similarweb 有回應但沒有造訪量估算，小網站常見">Similarweb 沒有估算</span>`
        : w.failures
          ? `<span class="down" title="${html(w.lastError)}">▼ 失敗 ${w.failures} 次</span>`
          : w.lastAttemptAt
            ? '抓取中'
            : (queued(w) ?? '<span class="muted">排隊中</span>');
  const rowHtml = (
    w: WatchRow,
    removable: boolean,
  ) => `<tr><td class="l" data-v="${html(w.domain)}"><span class="site-identity"><a class="site-name" href="/site/${html(w.domain)}/">${html(w.domain)}</a>${
    w.note && w.note !== w.domain ? `<span class="site-domain table-lead-extra">${html(w.note)}</span>` : ''
  }</span></td>
${sortCell('num', w.latestVisits, w.latestMonth ? `${vol(w.latestVisits === null ? null : w.latestVisits / 1e6)} <span class="muted">${monthLabel(w.latestMonth)}</span>` : '')}
${sortCell('num', w.refreshDays, `每 ${w.refreshDays ?? ''} 天`)}${sortCell('l', w.lastSuccessAt?.toISOString() ?? null, state(w))}${sortCell('l', w.requestedAt.toISOString(), `<span class="site-identity"><span class="radar">${html(w.addedBy)}</span><span class="site-domain">${tw(w.requestedAt.toISOString())}</span></span>`)}
<td>${removable ? `<form class="inline" method="post" action="/watch/remove" onsubmit="return confirm('停止追蹤 ${html(w.domain)}？')"><input type="hidden" name="domain" value="${html(w.domain)}"><button type="submit" class="quiet">移除</button></form>` : ''}</td></tr>`;
  const head =
    '<th class="l">網域</th><th class="num">最新造訪量</th><th class="num">週期</th><th class="l">最近成功</th><th class="l">加入</th><th data-nosort><span class="sr-only">操作</span></th>';
  const services = others.filter((o) => o.requester !== 'sheet');
  const form = editor
    ? `<form class="form" method="post" action="/watch/"><label>網域或網址，一行一個（最多 200 個）
<textarea name="domains" rows="5" required placeholder="example.com.tw&#10;https://news.example.com/"></textarea></label>
<div class="row"><label>多久更新一次 <select name="refreshDays"><option value="7">每 7 天</option><option value="30">每 30 天</option></select></label>
<label>備註 <input name="note" maxlength="255" size="28" placeholder="為什麼要追蹤（選填）"></label>
<button type="submit" class="primary">加入追蹤</button></div></form>`
    : `<p class="flash">${loginEnabled ? `<a href="/auth/google?next=/watch/">登入</a>後可以加入或移除網域。` : '登入尚未設定。'}</p>`;
  const listSection = list
    ? (() => {
        const got = list.rows.filter((w) => w.latestMonth).length;
        const none = list.rows.filter((w) => !w.latestMonth && (w.lastResponseAt || w.failures)).length;
        return `<section class="block" id="list"><h2>${requesterLabel(list.requester)}<small>${list.rows.length} 個網域</small></h2>
<p class="note">有流量數字 ${got}、Similarweb 沒有估算或失敗 ${none}、排隊中 ${list.rows.length - got - none}。</p>${table(head, list.rows.map((w) => rowHtml(w, false)).join(''), '清單是空的。', 6)}</section>`;
      })()
    : '';
  return layout(
    '追蹤網域',
    {
      title: '追蹤網域',
      dek: '加入網站並定期更新流量資料',
    },
    `${flash ? `<p class="flash">${html(flash)}</p>` : ''}${form}
<section class="block"><h2>手動追蹤<small>${manual.length} 個</small></h2>${table(head, manual.map((w) => rowHtml(w, !!editor)).join(''), '還沒有手動加入的網域。', 6)}</section>
${section(
  '更新方式與其他來源',
  `<p class="body">Similarweb 每小時依排程抓取，之後依設定的週期更新；Cloudflare Radar 每天更新。Similarweb 只提供最新一個月的搜尋與 AI 占比，開始追蹤後才會逐月保存。</p><p class="body">其他來源：${services.map((o) => `<a href="/watch/?list=${encodeURIComponent(o.requester)}#list">${requesterLabel(o.requester)} ${o.domains} 個</a>`).join('、') || '沒有'}。這些清單由各服務自己維護。</p>`,
)}
${listSection}`,
    { nav: 'watch' },
  );
}

/** Orders exact places before buckets and buckets before "not in the top N". */
const radarSort = (r: Pick<RadarPeriod, 'rank' | 'bucket' | 'bucketLowerBound'>) =>
  r.rank ?? r.bucket ?? (r.bucketLowerBound === null ? null : r.bucketLowerBound * 10);

/** "第 12 名", "前 20,000 名" or "未入前 200,000 名"; never a guessed place. */
export const radarLabel = (r: Pick<RadarPeriod, 'rank' | 'bucket' | 'bucketLowerBound'>) =>
  r.rank !== null
    ? `第 ${r.rank} 名`
    : r.bucket !== null
      ? `前 ${r.bucket.toLocaleString('en-US')} 名`
      : r.bucketLowerBound !== null
        ? `未入前 ${r.bucketLowerBound.toLocaleString('en-US')} 名`
        : '';
