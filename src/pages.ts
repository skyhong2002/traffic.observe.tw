import type { ranking, topicSummary } from './metrics.ts';
import { splitTopics, UNLABELLED } from './metrics.ts';
import type { RadarPeriod } from './radar.ts';
import type { WatchRow } from './requests.ts';
import type { QueueEntry, serviceStatus } from './status.ts';
import { STYLE_HREF } from './style.ts';

// Server-rendered pages in the report's design (style.css): the shared site
// header, a masthead, sections and tables. No client framework; the only
// script shows chart tooltips.

export const html = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const monthLabel = (m: string) => `${m.slice(0, 4)}/${m.slice(4)}`;
const monthLong = (m: string) => `${m.slice(0, 4)} 年 ${Number(m.slice(4))} 月`;
const num = (n: number | null, digits = 3) => (n === null ? '' : n.toFixed(digits));
const pct = (n: number | null, digits = 1) => (n === null ? '' : `${(n * 100).toFixed(digits)}%`);
/** Up/down carry ▲▼ as well as color. */
const signed = (n: number | null) =>
  n === null ? '' : `<span class="delta ${n < 0 ? 'down' : 'up'}">${n < 0 ? '▼' : '▲'}${pct(Math.abs(n))}</span>`;
const tw = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, dateStyle: 'short', timeStyle: 'short' }) : '';
const twDate = (iso: string) => new Date(iso).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });

export type Nav = 'report' | 'table' | 'topics' | 'status' | 'watch' | null;
const NAV: Array<[Exclude<Nav, null>, string, string]> = [
  ['report', '/', '月報'],
  ['table', '/table/', '表格'],
  ['topics', '/topics/', '分類概況'],
  ['status', '/status/', '抓取狀態'],
  ['watch', '/watch/', '追蹤網域'],
];
export interface Masthead {
  kicker: string;
  title: string;
  dek?: string;
  controls?: string;
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

export function layout(title: string, head: Masthead, body: string, { nav = null, tips = false }: { nav?: Nav; tips?: boolean } = {}) {
  const links = NAV.map(([key, href, label]) => `<a href="${href}"${key === nav ? ' class="on"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(title)}｜流量觀察</title><link rel="stylesheet" href="${STYLE_HREF}"></head><body>
<header class="site"><strong><a href="/">流量觀察</a></strong>${links}<a href="/api/v1/">API</a><span class="who"><!--who--></span></header>
<div class="masthead"><div class="wrap"><p class="kicker">${html(head.kicker)}</p><h1>${html(head.title)}</h1>${
    head.dek ? `<p class="dek">${head.dek}</p>` : ''
  }${head.controls ? `<div class="controls">${head.controls}</div>` : ''}</div></div>
${body}
<div class="wrap"><footer class="method">
<p>流量是 Similarweb 對整個網域的每月造訪估算（百萬次），不是 page views 或不重複讀者。搜尋S＝造訪 × 自然搜尋占比，AI＝造訪 × GenAI 導流占比，與 GeneHong「Similar Web」試算表的算法相同。Similarweb 沒有的月份以試算表數字補上並標「表」，人工調整（如「/5」）的列不採用。</p>
<p>Cloudflare Radar 是依 1.1.1.1 DNS 查詢的全球熱門排名：前 100 名才有名次，其餘只有「前 N 名」級距，不能換算成造訪量。</p>
</footer></div>
${tips ? TIP_SCRIPT : ''}</body></html>`;
}

const section = (title: string, inner: string, extra = '') => `<section class="block"${extra}><h2>${title}</h2>${inner}</section>`;
const table = (head: string, rows: string, empty: string, cols: number) =>
  `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody class="static">${
    rows || `<tr><td colspan="${cols}" class="l empty">${empty}</td></tr>`
  }</tbody></table></div>`;

const monthPicker = (months: string[], month: string, extra: Record<string, string | null>) =>
  `<form method="get"><label>月份 <select name="month" onchange="this.form.submit()">${months
    .map((m) => `<option value="${m}"${m === month ? ' selected' : ''}>${monthLong(m)}</option>`)
    .join('')}</select></label>${Object.entries(extra)
    .filter(([, v]) => v)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${html(v)}">`)
    .join('')}<noscript><button type="submit">看</button></noscript></form>`;

export function rankingPage(
  month: string,
  months: string[],
  topics: Array<{ topic: string; sites: number }>,
  topic: string | null,
  list: ReturnType<typeof ranking>,
  source: string | null = null,
  sources: Array<{ requester: string; domains: number }> = [],
  foreign = false,
  hidden = 0,
) {
  const q = (t: string | null, src = source, f = foreign) =>
    `/table/?month=${month}${t ? `&topic=${encodeURIComponent(t)}` : ''}${src ? `&source=${encodeURIComponent(src)}` : ''}${f ? '&foreign=1' : ''}`;
  const sourceChips = [`<span class="lbl">來源</span><a href="${q(topic, null)}"${source ? '' : ' class="on"'}>所有來源</a>`]
    .concat(
      sources.map(
        (o) =>
          `<a href="${q(topic, o.requester)}"${o.requester === source ? ' class="on"' : ''}>${html(SOURCE_LABEL[o.requester] ?? o.requester)}<small>${o.domains}</small></a>`,
      ),
    )
    .concat(
      `<span class="lbl">範圍</span><a href="${q(topic, source, !foreign)}"${foreign ? ' class="on"' : ''} aria-pressed="${foreign}" title="「非台灣」群組的網站照列但不排名次">含非台灣${foreign ? '' : `<small>${hidden}</small>`}</a>`,
    )
    .join('');
  const chips = [`<span class="lbl">分類</span><a href="${q(null)}"${topic ? '' : ' class="on"'}>全部</a>`]
    .concat(
      topics.map((t) => `<a href="${q(t.topic)}"${t.topic === topic ? ' class="on"' : ''}>${html(t.topic)}<small>${t.sites}</small></a>`),
    )
    .join('');
  const rowsHtml = list
    .map(
      (
        s,
      ) => `<tr><td class="rank"${s.rank === null ? ' title="「非台灣」群組不排名次"' : ''}>${s.rank ?? '—'}</td><td class="l"><a class="site-name" href="/site/${html(s.domain)}/">${html(s.name)}</a>${
        s.visitsSource === 'sheet' ? '<span class="tag" title="Similarweb 沒有這個月份，用試算表數字">表</span>' : ''
      }<span class="site-domain">${html(s.domain)}</span></td><td class="l"><span class="radar">${html([s.group, ...s.topics].filter(Boolean).join('・'))}</span></td>
<td class="num">${num(s.visits)}</td><td class="num">${signed(s.growth)}</td><td class="num">${s.prevRank ?? ''}</td><td class="num">${num(s.searchVisits)}</td><td class="num">${num(s.aiVisits)}</td>
<td class="num">${pct(s.searchShare)}</td><td class="num">${pct(s.aiShare, 2)}</td><td class="num">${pct(s.taiwanShare)}</td></tr>`,
    )
    .join('');
  const csv = `/api/v1/rankings.csv?month=${month}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}${source ? `&source=${encodeURIComponent(source)}` : ''}${foreign ? '&foreign=1' : ''}`;
  const sourceNote = source
    ? `${html(SOURCE_LABEL[source] ?? source)}追蹤的 ${sources.find((o) => o.requester === source)?.domains ?? 0} 個網域裡，這個月有數字的有 ${list.length} 個；其他還在排隊或 Similarweb 沒有估算，見<a href="/watch/${source === 'manual' ? '' : `?list=${encodeURIComponent(source)}#list`}">清單</a>。`
    : `這個月有數字的 ${list.length} 個網站。`;
  const foreignNote = hidden ? `另有 ${hidden} 個「非台灣」網站沒有列出，點上方「含非台灣」顯示。` : '';
  return layout(
    month ? `${monthLabel(month)} ${topic ?? '全部'}` : '表格',
    {
      kicker: '流量觀察・表格',
      title: month ? `${monthLong(month)}排行` : '月排行',
      dek: `依造訪量排序的完整表格，成長與上月名次都跟前一個月比；只列台灣網站並排名；「含非台灣」會加列「非台灣」群組，但不給名次。要比較任意兩個月或看排名軌跡，請用<a href="/${month ? `#to=${month}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}` : ''}">月報</a>。`,
      controls: month ? `${monthPicker(months, month, { topic, source, foreign: foreign ? '1' : null })}<a href="${csv}">下載 CSV</a>` : '',
    },
    `<div class="chips-bar"><div class="wrap"><nav class="chips sources" aria-label="來源">${sourceChips}</nav><nav class="chips" aria-label="分類">${chips}</nav></div></div>
<main class="wrap"><section class="topic"><header><h2>${html(topic ?? '全部網站')}</h2></header>
<p class="summary">${sourceNote}${foreignNote}</p>
${table(
  '<th>名次</th><th class="l">網站</th><th class="l">分類</th><th class="num">流量</th><th class="num">成長</th><th class="num">上月</th><th class="num">搜尋S</th><th class="num">AI</th><th class="num">搜尋占比</th><th class="num">AI 占比</th><th class="num">台灣</th>',
  rowsHtml,
  '這個月份沒有資料。',
  11,
)}</section></main>`,
    { nav: 'table' },
  );
}

export function topicsPage(month: string, months: string[], summary: ReturnType<typeof topicSummary>) {
  const prev = months[months.indexOf(month) + 1];
  const rowsHtml = summary
    .map(
      (t) => `<tr><td class="l"><a class="site-name" href="/#to=${month}&topic=${encodeURIComponent(t.topic)}">${html(t.topic)}</a>${
        t.topic === UNLABELLED ? '<span class="site-domain">試算表沒有分類的網站</span>' : ''
      }</td><td class="num">${t.sites}</td><td class="num">${num(t.visits, 2)}</td><td class="num">${signed(t.visitsGrowth)}</td><td class="num">${pct(t.searchShare, 2)}</td>
<td class="num">${pct(t.aiShare, 2)}</td><td class="num">${signed(t.aiGrowth)}</td><td class="num">${signed(t.searchGrowth)}</td></tr>`,
    )
    .join('');
  return layout(
    `${month ? monthLabel(month) : ''} 分類概況`,
    {
      kicker: '流量觀察・分類概況',
      title: month ? `${monthLong(month)}各分類概況` : '分類概況',
      dek: `${prev ? `跟 ${monthLong(prev)}比較。` : ''}成長只計兩個月都有數字的網站；占比以造訪量加權。一個網站有多個分類時每個分類都計入。點分類名稱看該分類的排名軌跡與全部網站。`,
      controls: month ? monthPicker(months, month, {}) : '',
    },
    `<main class="wrap">${section(
      '分類',
      table(
        '<th class="l">分類</th><th class="num">網站</th><th class="num">流量（百萬）</th><th class="num">流量成長</th><th class="num">搜尋占比</th><th class="num">AI 占比</th><th class="num">AI 成長</th><th class="num">搜尋成長</th>',
        rowsHtml,
        '這個月份沒有資料。',
        8,
      ),
    )}</main>`,
    { nav: 'topics' },
  );
}

export interface SitePage {
  domain: string;
  name: string;
  labels: Array<{ month: string; group: string | null; topics: string | null; name: string; visits: number | null; adjusted: boolean }>;
  months: Array<{
    month: string;
    similarweb: number | null;
    sheet: number | null;
    searchShare: number | null;
    aiShare: number | null;
    taiwanShare: number | null;
  }>;
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

export function sitePage(site: SitePage) {
  const ordered = [...site.months].sort((a, b) => a.month.localeCompare(b.month));
  const visitsAt = (m: SitePage['months'][number]) => m.similarweb ?? m.sheet;
  const latest = [...ordered].reverse().find((m) => visitsAt(m) !== null);
  const latestShare = (key: 'searchShare' | 'aiShare' | 'taiwanShare') => [...ordered].reverse().find((m) => m[key] !== null);
  const radarNow = site.radar.at(-1);
  const stat = (label: string, value: string, sub = '') =>
    `<div><span>${label}</span><b>${value || '—'}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const shareStat = (label: string, key: 'searchShare' | 'aiShare' | 'taiwanShare', digits = 1) => {
    const m = latestShare(key);
    return stat(label, m ? pct(m[key], digits) : '', m ? monthLabel(m.month) : '');
  };
  const stats = `<div class="stats">${stat('最新流量（百萬）', latest ? num(visitsAt(latest)) : '', latest ? `${monthLabel(latest.month)}${latest.similarweb === null ? '・試算表' : ''}` : '')}${shareStat('搜尋占比', 'searchShare')}${shareStat('AI 占比', 'aiShare', 2)}${shareStat('台灣占比', 'taiwanShare')}${stat('Radar 最新', radarNow ? radarLabel(radarNow) : '', radarNow ? twDate(radarNow.dateEnd) : '')}</div>`;

  const visitsChart = lineChart(
    ordered.map((m) => ({ month: m.month, value: visitsAt(m), sheet: m.similarweb === null && m.sheet !== null })),
    { label: '每月造訪（百萬）', fmt: (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) },
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
        `<tr><td class="l">${monthLabel(m.month)}</td><td class="num">${num(m.similarweb)}</td><td class="num">${num(m.sheet)}</td><td class="num">${pct(m.searchShare)}</td><td class="num">${pct(m.aiShare, 2)}</td><td class="num">${pct(m.taiwanShare)}</td></tr>`,
    )
    .join('');
  const labelRows = [...site.labels]
    .reverse()
    .map(
      (l) =>
        `<tr><td class="l">${monthLabel(l.month)}</td><td class="l">${html(l.name)}</td><td class="l">${html(l.group)}</td><td class="l">${html(l.topics)}</td><td class="num">${num(l.visits)}${l.adjusted ? '<span class="tag">人工調整</span>' : ''}</td></tr>`,
    )
    .join('');
  const radarRows = [...site.radar]
    .reverse()
    .map((r) => `<tr><td class="l">${twDate(r.dateEnd)}</td><td class="l">${radarLabel(r)}</td><td class="l">${tw(r.fetchedAt)}</td></tr>`)
    .join('');
  const label = site.labels.at(-1);
  const topic = splitTopics(label?.topics ?? null)[0];
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
      kicker: `流量觀察・網站${label?.group ? `・${label.group}` : ''}`,
      title: site.name,
      dek: `${html(site.domain)}${label?.topics ? `・${html(splitTopics(label.topics).join('、'))}` : ''}`,
      controls: `<span class="links">${
        topic ? `<a href="/#topic=${encodeURIComponent(topic)}&hl=${encodeURIComponent(site.domain)}">在月報中看（${html(topic)}）</a>` : ''
      }<a href="/api/v1/sites/${html(site.domain)}">JSON</a><a href="https://${html(site.domain)}/" rel="noopener">開啟網站</a></span>`,
    },
    `<main class="wrap">${stats}
${section(
  '每月造訪',
  `<p class="note">Similarweb 估算，百萬次；空心點是試算表補上的月份，斷開處是沒有資料的月份。</p><div class="chart-box">${visitsChart}</div>`,
)}
${section(
  '導流占比',
  `<p class="note">兩張圖各自的刻度：自然搜尋與 GenAI 導流占全部造訪的比例。Similarweb 只給最新一個月的占比，所以點常常不連續。</p>
<div class="charts"><div class="chart-box"><h3>搜尋占比</h3>${shareChart('searchShare', 0, '搜尋占比')}</div><div class="chart-box"><h3>AI 占比</h3>${shareChart('aiShare', 2, 'AI 占比')}</div></div>`,
)}
${section(
  '逐月數字',
  table(
    '<th class="l">月份</th><th class="num">Similarweb（百萬）</th><th class="num">試算表（百萬）</th><th class="num">搜尋占比</th><th class="num">AI 占比</th><th class="num">台灣占比</th>',
    monthRows,
    '沒有月份資料。',
    6,
  ),
)}
${
  radarRows
    ? section(
        'Cloudflare Radar 全球排名',
        `<p class="note">依 1.1.1.1 DNS 查詢的熱門程度；前 100 名才有名次，其餘只有級距。不能換算成造訪量。</p>${table('<th class="l">資料日期</th><th class="l">排名</th><th class="l">抓取時間</th>', radarRows, '', 3)}`,
      )
    : ''
}
${
  labelRows
    ? section(
        '試算表紀錄',
        table(
          '<th class="l">月份</th><th class="l">名稱</th><th class="l">群組</th><th class="l">分類</th><th class="num">流量</th>',
          labelRows,
          '',
          5,
        ),
      )
    : ''
}
${section('追蹤與抓取', `<p class="body">${watchers}</p><p class="note">${fetchState}</p>`)}
</main>`,
    { tips: true },
  );
}

export function notFoundPage(raw: string) {
  return layout(
    '找不到網站',
    { kicker: '流量觀察', title: '沒有這個網站的資料', dek: `${html(raw)} 不在任何追蹤清單裡，也沒有抓到過資料。` },
    `<main class="wrap">${section('接下來', '<p class="body"><a href="/">回月報</a>，或到<a href="/watch/">追蹤網域</a>登入後把它加進來。</p>')}</main>`,
  );
}

export function statusPage(status: Awaited<ReturnType<typeof serviceStatus>>) {
  const runs = status.runs
    .map(
      (r) =>
        `<tr><td class="l">${tw(r.startedAt)}</td><td class="num">${r.budget}</td><td class="num">${r.sent}</td><td class="num">${r.ok}</td><td class="num">${r.failed}</td><td class="l">${r.refused ? '<span class="down">▼ 被拒</span> ' : ''}${html(r.note)}</td></tr>`,
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
  const queueRows = q
    .map(
      (e) =>
        `<tr${status.budget && e.position <= status.budget ? ' class="hl"' : ''}><td class="rank">${e.position}</td><td class="l"><a class="site-name" href="/site/${html(e.domain)}/">${html(e.domain)}</a></td><td class="l">${e.requester ? requesterLabel(e.requester) : ''}</td><td class="l">${DUE_LABEL[e.reason] ?? html(e.reason)}</td><td class="l">${e.lastSuccessAt ? twDate(e.lastSuccessAt) : '<span class="muted">從未</span>'}</td><td class="l">${e.expectedAt ? tw(e.expectedAt) : '<span class="muted">不會送出</span>'}</td></tr>`,
    )
    .join('');
  const queueNote = q.length
    ? `<p class="note">共 ${q.length} 個網域等著抓，依這個順序送出${
        status.budget
          ? `，每小時一輪、一輪 ${status.budget} 個：最先的是 <b>${html(q[0].domain)}</b>（${tw(q[0].expectedAt)}），排最後的是 <b>${html(q.at(-1)?.domain)}</b>（約 ${tw(q.at(-1)?.expectedAt ?? null)}）。底色是下一輪會送出的。`
          : '；每輪上限是 0，目前不會送出。'
      }預計時間假設中途沒有被 Similarweb 擋、也沒有新加入的網域插隊。<a href="#queue-end">跳到最後</a></p>`
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
      kicker: '流量觀察・抓取狀態',
      title: 'Similarweb 抓取狀態',
      dek: `這台主機唯一對 Similarweb 發請求的排程。優先序：${priority.map(requesterLabel).join(' → ')}。下方「抓取排程」列出接下來每個網域的順序與預計時間。`,
    },
    `<main class="wrap">${status.coolingDownUntil ? `<p class="flash"><span class="down">▼</span> 被拒後暫停至 ${tw(status.coolingDownUntil)}</p>` : ''}${stats}
${section(
  `抓取排程<small>${q.length} 個網域</small>`,
  `${queueNote}${table(
    '<th>順序</th><th class="l">網域</th><th class="l">來源</th><th class="l">原因</th><th class="l">上次成功</th><th class="l">預計抓取</th>',
    queueRows,
    '目前沒有到期的網域。',
    6,
  )}<p class="note" id="queue-end">排程到此為止；之後到期的網域會依同樣規則接在後面。</p>`,
  ' id="queue"',
)}
${section(
  '追蹤者',
  table(
    '<th class="l">來源</th><th class="l">類型</th><th class="num">網域</th>',
    watchers
      .map(
        (w) =>
          `<tr><td class="l">${requesterLabel(w.requester)}</td><td class="l">${KIND_LABEL[w.kind] ?? html(w.kind)}</td><td class="num">${w.domains}</td></tr>`,
      )
      .join(''),
    '沒有追蹤者。',
    3,
  ),
)}
${section(
  '最近批次',
  table(
    '<th class="l">開始</th><th class="num">上限</th><th class="num">送出</th><th class="num">成功</th><th class="num">失敗</th><th class="l">備註</th>',
    runs,
    '尚未執行。',
    6,
  ),
)}</main>`,
    { nav: 'status' },
  );
}

/** The header's sign-in slot (layout leaves <!--who--> for it). */
export function whoSlot(editor: { email: string } | null, loginEnabled: boolean, path: string) {
  if (editor)
    return `<small>${html(editor.email)}</small> <form method="post" action="/auth/logout"><button type="submit" class="quiet">登出</button></form>`;
  return loginEnabled ? `<a href="/auth/google?next=${encodeURIComponent(path)}">登入</a>` : '';
}

const LOGIN_ERRORS: Record<string, string> = {
  not_editor: '這個 Google 帳號沒有編輯權限。需要權限請聯絡管理者。',
  cancelled: '登入已取消。',
  state: '登入逾時或在另一個分頁開始，請再試一次。',
  failed: 'Google 登入失敗，請稍後再試。',
  invalid: 'Google 回傳的資料不正確，請再試一次。',
};
export function loginPage(error: string | undefined, enabled: boolean) {
  const message = error ? (LOGIN_ERRORS[error] ?? '登入失敗。') : null;
  return layout(
    '登入',
    { kicker: '流量觀察・登入', title: '登入', dek: '登入只用來手動加入要追蹤的網域；排行與資料不需登入就能看。' },
    `<main class="wrap">${message ? `<p class="flash">${html(message)}</p>` : ''}${section(
      '用 Google 帳號登入',
      enabled
        ? '<p class="body">只有名單上的編輯可以登入。</p><p><a href="/auth/google?next=/watch/">用 Google 帳號登入</a></p>'
        : '<p class="body muted">登入尚未設定。</p>',
    )}</main>`,
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
  ) => `<tr><td class="l"><a class="site-name" href="/site/${html(w.domain)}/">${html(w.domain)}</a>${
    w.note ? `<span class="site-domain">${html(w.note)}</span>` : ''
  }</td>
<td class="num">${w.latestMonth ? `${num(w.latestVisits === null ? null : w.latestVisits / 1e6)} <span class="muted">${monthLabel(w.latestMonth)}</span>` : ''}</td>
<td class="num">每 ${w.refreshDays ?? ''} 天</td><td class="l">${state(w)}</td><td class="l"><span class="radar">${html(w.addedBy)}</span><span class="site-domain">${tw(w.requestedAt.toISOString())}</span></td>
<td>${removable ? `<form class="inline" method="post" action="/watch/remove" onsubmit="return confirm('停止追蹤 ${html(w.domain)}？')"><input type="hidden" name="domain" value="${html(w.domain)}"><button type="submit" class="quiet">移除</button></form>` : ''}</td></tr>`;
  const head =
    '<th class="l">網域</th><th class="num">最新流量（百萬）</th><th class="num">週期</th><th class="l">最近成功</th><th class="l">加入</th><th></th>';
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
      kicker: '流量觀察・追蹤網域',
      title: '追蹤網域',
      dek: '這裡加入的網域會排進 Similarweb 抓取（每小時一輪，最優先），之後依設定的週期更新；Cloudflare Radar 每天抓一次。Similarweb 只提供最新一個月的搜尋與 AI 占比，所以越早加入，留下的月份越多。接下來會抓哪些網域、順序和預計時間，見<a href="/status/#queue">抓取狀態的排程</a>。',
    },
    `<main class="wrap">${flash ? `<p class="flash">${html(flash)}</p>` : ''}${form}
<section class="block"><h2>手動追蹤<small>${manual.length} 個</small></h2>${table(head, manual.map((w) => rowHtml(w, !!editor)).join(''), '還沒有手動加入的網域。', 6)}</section>
${section(
  '其他來源',
  `<p class="body">${services.map((o) => `<a href="/watch/?list=${encodeURIComponent(o.requester)}#list">${requesterLabel(o.requester)} ${o.domains} 個</a>`).join('、') || '沒有'}。這些清單由各服務自己維護。</p>`,
)}
${listSection}</main>`,
    { nav: 'watch' },
  );
}

/** "第 12 名", "前 20,000 名" or "未入前 200,000 名"; never a guessed place. */
export const radarLabel = (r: Pick<RadarPeriod, 'rank' | 'bucket' | 'bucketLowerBound'>) =>
  r.rank !== null
    ? `第 ${r.rank} 名`
    : r.bucket !== null
      ? `前 ${r.bucket.toLocaleString('en-US')} 名`
      : r.bucketLowerBound !== null
        ? `未入前 ${r.bucketLowerBound.toLocaleString('en-US')} 名`
        : '';
