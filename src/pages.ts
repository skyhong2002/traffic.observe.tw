import type { ranking, topicSummary } from './metrics.ts';
import { UNLABELLED } from './metrics.ts';
import type { serviceStatus } from './status.ts';

// Server-rendered pages: no client framework, every table sortable by link.

export const html = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const monthLabel = (m: string) => `${m.slice(0, 4)}/${m.slice(4)}`;
const num = (n: number | null, digits = 3) => (n === null ? '' : n.toFixed(digits));
const pct = (n: number | null, digits = 1) => (n === null ? '' : `${(n * 100).toFixed(digits)}%`);
const signed = (n: number | null) => (n === null ? '' : `<span class="${n < 0 ? 'down' : 'up'}">${pct(n)}</span>`);
const tw = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, dateStyle: 'short', timeStyle: 'short' }) : '';

const CSS = `
:root{color-scheme:dark;--bg:#111418;--fg:#e6e8eb;--muted:#9aa3ad;--line:#2a3038;--accent:#f0a64a;--up:#6cc58a;--down:#ef7a7a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,"Noto Sans TC",sans-serif}
header{display:flex;gap:1.2rem;align-items:baseline;padding:.8rem 1.2rem;border-bottom:1px solid var(--line);flex-wrap:wrap}
header strong{font-size:1.1rem}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
main{padding:1rem 1.2rem;max-width:1200px}h1{font-size:1.3rem;margin:.2rem 0 .8rem}.muted,small{color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:.35rem;margin:.6rem 0}.chips a{border:1px solid var(--line);border-radius:999px;padding:.1rem .65rem;color:var(--fg)}
.chips a.on{border-color:var(--accent);color:var(--accent)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:.3rem .55rem;border-bottom:1px solid var(--line);white-space:nowrap;text-align:right}
th{color:var(--muted);font-weight:500;position:sticky;top:0;background:var(--bg)}td.l,th.l{text-align:left}
.up{color:var(--up)}.down{color:var(--down)}.tag{font-size:.75rem;border:1px solid var(--line);border-radius:4px;padding:0 .3rem;color:var(--muted);margin-left:.3rem}
form{display:inline}select{background:var(--bg);color:var(--fg);border:1px solid var(--line);padding:.15rem .3rem}
footer{padding:1.5rem 1.2rem;color:var(--muted);font-size:.85rem;max-width:1200px}`;

export function layout(title: string, body: string) {
  return `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(title)}｜流量觀察</title><style>${CSS}</style></head><body>
<header><strong><a href="/">流量觀察</a></strong><a href="/">月排行</a><a href="/topics/">分類概況</a><a href="/status/">抓取狀態</a><a href="/api/v1/">API</a></header>
<main>${body}</main>
<footer>數字是 Similarweb 對整個網域的月造訪估算（百萬次），不是 page views 或不重複讀者。搜尋S＝造訪 × 自然搜尋占比，AI＝造訪 × GenAI 導流占比，與 GeneHong「Similar Web」試算表算法相同；Similarweb 沒有的月份與網域以試算表數字補上並標「表」，人工調整（如「/5」）的列不採用。</footer>
</body></html>`;
}

const monthPicker = (months: string[], month: string, extra: Record<string, string | null>) =>
  `<form method="get">${Object.entries(extra)
    .filter(([, v]) => v)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${html(v)}">`)
    .join('')}<select name="month" onchange="this.form.submit()">${months
    .map((m) => `<option value="${m}"${m === month ? ' selected' : ''}>${monthLabel(m)}</option>`)
    .join('')}</select></form>`;

export function rankingPage(
  month: string,
  months: string[],
  topics: Array<{ topic: string; sites: number }>,
  topic: string | null,
  list: ReturnType<typeof ranking>,
) {
  const q = (t: string | null) => `/?month=${month}${t ? `&topic=${encodeURIComponent(t)}` : ''}`;
  const chips = [`<a href="${q(null)}"${topic ? '' : ' class="on"'}>全部</a>`]
    .concat(
      topics.map((t) => `<a href="${q(t.topic)}"${t.topic === topic ? ' class="on"' : ''}>${html(t.topic)} <small>${t.sites}</small></a>`),
    )
    .join('');
  const rowsHtml = list
    .map(
      (s) => `<tr><td>${s.rank}</td><td class="l"><a href="/site/${html(s.domain)}/">${html(s.name)}</a>${
        s.visitsSource === 'sheet' ? '<span class="tag" title="Similarweb 沒有這個月份，用試算表數字">表</span>' : ''
      }<br><small>${html(s.domain)}</small></td><td class="l"><small>${html([s.group, ...s.topics].filter(Boolean).join('・'))}</small></td>
<td>${num(s.visits)}</td><td>${signed(s.growth)}</td><td>${s.prevRank ?? ''}</td><td>${num(s.searchVisits)}</td><td>${num(s.aiVisits)}</td>
<td>${pct(s.searchShare)}</td><td>${pct(s.aiShare, 2)}</td><td>${pct(s.taiwanShare)}</td></tr>`,
    )
    .join('');
  return layout(
    `${monthLabel(month)} ${topic ?? '全部'}`,
    `<h1>${monthLabel(month)} 月排行 ${monthPicker(months, month, { topic })}</h1>
<div class="chips">${chips}</div>
<p class="muted">${topic ?? '全部'}：${list.length} 個網站。<a href="/api/v1/rankings.csv?month=${month}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}">下載 CSV</a></p>
<div class="scroll"><table><thead><tr><th>名次</th><th class="l">網站名</th><th class="l">分類</th><th>流量</th><th>成長</th><th>上月</th><th>搜尋S</th><th>AI</th><th>搜尋占比</th><th>AI占比</th><th>台灣</th></tr></thead>
<tbody>${rowsHtml || '<tr><td colspan="11" class="l muted">這個月份沒有資料。</td></tr>'}</tbody></table></div>`,
  );
}

export function topicsPage(month: string, months: string[], summary: ReturnType<typeof topicSummary>) {
  const prev = months[months.indexOf(month) + 1];
  const rowsHtml = summary
    .map(
      (t) => `<tr><td class="l"><a href="/?month=${month}&topic=${encodeURIComponent(t.topic)}">${html(t.topic)}</a>${
        t.topic === UNLABELLED ? '<small> 試算表未分類</small>' : ''
      }</td><td>${t.sites}</td><td>${num(t.visits, 2)}</td><td>${signed(t.visitsGrowth)}</td><td>${pct(t.searchShare, 2)}</td>
<td>${pct(t.aiShare, 2)}</td><td>${signed(t.aiGrowth)}</td><td>${signed(t.searchGrowth)}</td></tr>`,
    )
    .join('');
  return layout(
    `${monthLabel(month)} 分類概況`,
    `<h1>${monthLabel(month)} 網站概況${prev ? `（跟 ${monthLabel(prev)} 比較）` : ''} ${monthPicker(months, month, {})}</h1>
<p class="muted">成長只計兩個月都有數字的網站；占比以造訪量加權。一個網站有多個分類時每個分類都計入。</p>
<div class="scroll"><table><thead><tr><th class="l">分類</th><th>網站</th><th>流量</th><th>流量成長</th><th>搜尋占比</th><th>AI占比</th><th>AI成長</th><th>搜尋成長</th></tr></thead>
<tbody>${rowsHtml}</tbody></table></div>`,
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
  state: {
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;
    failures: number;
    lastError: string | null;
  } | null;
}

export function sitePage(site: SitePage) {
  const monthRows = [...site.months]
    .reverse()
    .map(
      (m) =>
        `<tr><td class="l">${monthLabel(m.month)}</td><td>${num(m.similarweb)}</td><td>${num(m.sheet)}</td><td>${pct(m.searchShare)}</td><td>${pct(m.aiShare, 2)}</td><td>${pct(m.taiwanShare)}</td></tr>`,
    )
    .join('');
  const labelRows = [...site.labels]
    .reverse()
    .map(
      (l) =>
        `<tr><td class="l">${monthLabel(l.month)}</td><td class="l">${html(l.name)}</td><td class="l">${html(l.group)}</td><td class="l">${html(l.topics)}</td><td>${num(l.visits)}${l.adjusted ? '<span class="tag">人工調整</span>' : ''}</td></tr>`,
    )
    .join('');
  const s = site.state;
  return layout(
    site.name,
    `<h1>${html(site.name)} <small>${html(site.domain)}</small></h1>
<p class="muted">${s ? `最近成功抓取 ${tw(s.lastSuccessAt) || '—'}；最近嘗試 ${tw(s.lastAttemptAt) || '—'}${s.nextAttemptAt ? `；下次最早 ${tw(s.nextAttemptAt)}` : ''}${s.failures ? `；連續失敗 ${s.failures} 次（${html(s.lastError)}）` : ''}` : '尚未抓取。'}
${site.watchers.length ? `<br>追蹤者：${site.watchers.map((w) => `${html(w.requester)}（${w.kind === 'watch' ? '定期' : html(w.kind)}）`).join('、')}` : ''}</p>
<h2>每月造訪（百萬）</h2><div class="scroll"><table><thead><tr><th class="l">月份</th><th>Similarweb</th><th>試算表</th><th>搜尋占比</th><th>AI占比</th><th>台灣</th></tr></thead><tbody>${monthRows}</tbody></table></div>
${labelRows ? `<h2>試算表紀錄</h2><div class="scroll"><table><thead><tr><th class="l">月份</th><th class="l">名稱</th><th class="l">群組</th><th class="l">分類</th><th>流量</th></tr></thead><tbody>${labelRows}</tbody></table></div>` : ''}`,
  );
}

export function statusPage(status: Awaited<ReturnType<typeof serviceStatus>>) {
  const runs = status.runs
    .map(
      (r) =>
        `<tr><td class="l">${tw(r.startedAt)}</td><td>${r.budget}</td><td>${r.sent}</td><td>${r.ok}</td><td>${r.failed}</td><td class="l">${r.refused ? '<span class="down">被拒</span> ' : ''}${html(r.note)}</td></tr>`,
    )
    .join('');
  return layout(
    '抓取狀態',
    `<h1>抓取狀態</h1>
<p>每輪上限 ${status.budget} 筆${status.budget ? '' : '（<span class="down">0：目前不送出任何請求</span>）'}，優先序 ${status.priority.map(html).join(' → ')}。
追蹤 ${status.watched} 個網域，目前到期 ${status.due} 個。${status.coolingDownUntil ? `<br><span class="down">被拒後暫停至 ${tw(status.coolingDownUntil)}</span>` : ''}</p>
<p class="muted">近 24 小時：${
      Object.entries(status.last24h)
        .map(([k, v]) => `${html(k)} ${v}`)
        .join('、') || '沒有請求'
    }</p>
<h2>追蹤者</h2><table><thead><tr><th class="l">服務</th><th class="l">類型</th><th>網域</th></tr></thead><tbody>${status.watchers
      .map(
        (w) =>
          `<tr><td class="l">${html(w.requester)}</td><td class="l">${w.kind === 'watch' ? '定期' : html(w.kind)}</td><td>${w.domains}</td></tr>`,
      )
      .join('')}</tbody></table>
<h2>最近批次</h2><div class="scroll"><table><thead><tr><th class="l">開始</th><th>上限</th><th>送出</th><th>成功</th><th>失敗</th><th class="l">備註</th></tr></thead><tbody>${
      runs || '<tr><td colspan="6" class="l muted">尚未執行。</td></tr>'
    }</tbody></table></div>`,
  );
}
