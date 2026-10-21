import type { ranking, topicSummary } from './metrics.ts';
import { UNLABELLED } from './metrics.ts';
import type { RadarPeriod } from './radar.ts';
import type { WatchRow } from './requests.ts';
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
input,textarea,button{font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:.25rem .45rem}
button{cursor:pointer;border-color:var(--accent);color:var(--accent)}textarea{width:100%;max-width:40rem}.who{margin-left:auto}
.flash{border-left:3px solid var(--accent);padding:.3rem .7rem;margin:.6rem 0}
footer{padding:1.5rem 1.2rem;color:var(--muted);font-size:.85rem;max-width:1200px}`;

export function layout(title: string, body: string) {
  return `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(title)}｜流量觀察</title><style>${CSS}</style></head><body>
<header><strong><a href="/">流量觀察</a></strong><a href="/">月排行</a><a href="/topics/">分類概況</a><a href="/status/">抓取狀態</a><a href="/watch/">追蹤網域</a><a href="/api/v1/">API</a><span class="who"><!--who--></span></header>
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
  source: string | null = null,
  sources: Array<{ requester: string; domains: number }> = [],
) {
  const q = (t: string | null, src = source) =>
    `/?month=${month}${t ? `&topic=${encodeURIComponent(t)}` : ''}${src ? `&source=${encodeURIComponent(src)}` : ''}`;
  const sourceChips = [`<a href="${q(topic, null)}"${source ? '' : ' class="on"'}>所有來源</a>`]
    .concat(
      sources.map(
        (o) =>
          `<a href="${q(topic, o.requester)}"${o.requester === source ? ' class="on"' : ''}>${html(REQUESTER_LABEL[o.requester] ?? o.requester)} <small>${o.domains}</small></a>`,
      ),
    )
    .join('');
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
<div class="chips">${sourceChips}</div>
<div class="chips">${chips}</div>
<p class="muted">${topic ?? '全部'}：這個月有數字的 ${list.length} 個網站${
      source
        ? `（${html(REQUESTER_LABEL[source] ?? source)} 追蹤的 ${sources.find((o) => o.requester === source)?.domains ?? 0} 個網域裡；其他還在排隊或 Similarweb 沒有估算，見<a href="/watch/?list=${encodeURIComponent(source)}">清單</a>）`
        : ''
    }。<a href="/api/v1/rankings.csv?month=${month}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}${source ? `&source=${encodeURIComponent(source)}` : ''}">下載 CSV</a></p>
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
  radar: RadarPeriod[];
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
  const radarRows = [...site.radar]
    .reverse()
    .map(
      (r) =>
        `<tr><td class="l">${tw(r.dateEnd).split(' ')[0]}</td><td class="l">${radarLabel(r)}</td><td class="l"><small>${tw(r.fetchedAt)}</small></td></tr>`,
    )
    .join('');
  const s = site.state;
  return layout(
    site.name,
    `<h1>${html(site.name)} <small>${html(site.domain)}</small></h1>
<p class="muted">${s ? `最近成功抓取 ${tw(s.lastSuccessAt) || '—'}；最近嘗試 ${tw(s.lastAttemptAt) || '—'}${s.nextAttemptAt ? `；下次最早 ${tw(s.nextAttemptAt)}` : ''}${s.failures ? `；連續失敗 ${s.failures} 次（${html(s.lastError)}）` : ''}` : '尚未抓取。'}
${site.watchers.length ? `<br>追蹤者：${site.watchers.map((w) => `${html(w.requester)}（${w.kind === 'watch' ? '定期' : html(w.kind)}）`).join('、')}` : ''}</p>
<h2>每月造訪（百萬）</h2><div class="scroll"><table><thead><tr><th class="l">月份</th><th>Similarweb</th><th>試算表</th><th>搜尋占比</th><th>AI占比</th><th>台灣</th></tr></thead><tbody>${monthRows}</tbody></table></div>
${radarRows ? `<h2>Cloudflare Radar 全球排名</h2><p class="muted">依 1.1.1.1 DNS 查詢的熱門程度；前 100 名才有名次，其餘只有級距。不能換算成造訪量。</p><div class="scroll"><table><thead><tr><th class="l">資料日期</th><th class="l">排名</th><th class="l">抓取</th></tr></thead><tbody>${radarRows}</tbody></table></div>` : ''}
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

/** The header's sign-in slot (layout leaves <!--who--> for it). */
export function whoSlot(editor: { email: string } | null, loginEnabled: boolean, path: string) {
  if (editor)
    return `<small>${html(editor.email)}</small> <form method="post" action="/auth/logout"><button type="submit">登出</button></form>`;
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
    `<h1>登入</h1>${message ? `<p class="flash">${html(message)}</p>` : ''}
<p>登入只用來手動加入要追蹤的網域；排行與資料不需登入就能看。</p>
${enabled ? '<p><a href="/auth/google?next=/watch/">用 Google 帳號登入</a></p>' : '<p class="muted">登入尚未設定。</p>'}`,
  );
}

const REQUESTER_LABEL: Record<string, string> = {
  manual: '手動',
  tag: '媒體（tag）',
  blog: '部落格（blog）',
  sheet: 'GeneHong 試算表',
};

export function watchPage({
  editor,
  loginEnabled,
  manual,
  others,
  flash,
  list = null,
}: {
  editor: { email: string } | null;
  loginEnabled: boolean;
  manual: WatchRow[];
  others: Array<{ requester: string; domains: number }>;
  flash: string | null;
  /** Another requester's standing list, shown read-only. */
  list?: { requester: string; rows: WatchRow[] } | null;
}) {
  const state = (w: WatchRow) =>
    w.lastSuccessAt
      ? `<span class="up">${tw(w.lastSuccessAt.toISOString())}</span>`
      : w.lastResponseAt
        ? `<span class="muted" title="Similarweb 有回應但沒有造訪量估算，小網站常見">Similarweb 沒有估算</span>`
        : w.failures
          ? `<span class="down" title="${html(w.lastError)}">失敗 ${w.failures} 次</span>`
          : w.lastAttemptAt
            ? '抓取中'
            : '排隊中';
  const rowHtml = (
    w: WatchRow,
    removable: boolean,
  ) => `<tr><td class="l"><a href="/site/${html(w.domain)}/">${html(w.domain)}</a>${w.note ? `<br><small>${html(w.note)}</small>` : ''}</td>
<td>${w.latestMonth ? `${num(w.latestVisits === null ? null : w.latestVisits / 1e6)} <small>${monthLabel(w.latestMonth)}</small>` : ''}</td>
<td>每 ${w.refreshDays ?? ''} 天</td><td class="l">${state(w)}</td><td class="l"><small>${html(w.addedBy)}<br>${tw(w.requestedAt.toISOString())}</small></td>
<td>${removable ? `<form method="post" action="/watch/remove" onsubmit="return confirm('停止追蹤 ${html(w.domain)}？')"><input type="hidden" name="domain" value="${html(w.domain)}"><button type="submit">移除</button></form>` : ''}</td></tr>`;
  const rowsHtml = manual.map((w) => rowHtml(w, !!editor)).join('');
  const form = editor
    ? `<form method="post" action="/watch/" style="display:block"><p><label>網域或網址，一行一個（最多 200 個）<br>
<textarea name="domains" rows="5" required placeholder="example.com.tw&#10;https://news.example.com/"></textarea></label></p>
<p><label>多久更新一次 <select name="refreshDays"><option value="7">每 7 天</option><option value="30">每 30 天</option></select></label>
<label>備註 <input name="note" maxlength="255" size="30" placeholder="為什麼要追蹤（選填）"></label>
<button type="submit">加入追蹤</button></p></form>`
    : `<p>${loginEnabled ? `<a href="/auth/google?next=/watch/">登入</a>後可以加入或移除網域。` : '登入尚未設定。'}</p>`;
  return layout(
    '追蹤網域',
    `<h1>追蹤網域</h1>${flash ? `<p class="flash">${html(flash)}</p>` : ''}
<p class="muted">這裡加入的網域會排進 Similarweb 抓取（每小時一輪，優先於 tag、blog、試算表），之後依設定的週期更新。Similarweb 只提供最新一個月的搜尋與 AI 占比，所以越早加入，留下的月份越多。</p>
${form}
<h2>手動追蹤 <small>${manual.length}</small></h2>
<div class="scroll"><table><thead><tr><th class="l">網域</th><th>最新流量（百萬）</th><th>週期</th><th class="l">最近成功</th><th class="l">加入</th><th></th></tr></thead>
<tbody>${rowsHtml || '<tr><td colspan="6" class="l muted">還沒有手動加入的網域。</td></tr>'}</tbody></table></div>
<h2>其他來源</h2><p class="muted">${others.map((o) => `<a href="/watch/?list=${encodeURIComponent(o.requester)}">${html(REQUESTER_LABEL[o.requester] ?? o.requester)} ${o.domains} 個</a>`).join('、') || '沒有'}。這些清單由各服務自己維護。</p>
${
  list
    ? (
        () => {
          const got = list.rows.filter((w) => w.latestMonth).length;
          const none = list.rows.filter((w) => !w.latestMonth && (w.lastResponseAt || w.failures)).length;
          return `<h2 id="list">${html(REQUESTER_LABEL[list.requester] ?? list.requester)} <small>${list.rows.length} 個網域：有流量數字 ${got}、Similarweb 沒有估算或失敗 ${none}、排隊中 ${list.rows.length - got - none}</small></h2>
<div class="scroll"><table><thead><tr><th class="l">網域</th><th>最新流量（百萬）</th><th>週期</th><th class="l">最近成功</th><th class="l">加入</th><th></th></tr></thead>
<tbody>${list.rows.map((w) => rowHtml(w, false)).join('')}</tbody></table></div>`;
        }
      )()
    : ''
}`,
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
