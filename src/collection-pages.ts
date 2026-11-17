import { type Collection, type CollectionEntry, FIELD_LABELS, PRIORITY_LABELS } from './collection.ts';
import { cruxLabel } from './crux.ts';
import type { FetchPolicy } from './fetch-policy.ts';
import { CHANNELS, favicon, html, layout, section, table, tw } from './pages.ts';

const STATUS: Record<string, string> = {
  complete: '已完成',
  pending: '待抓',
  retry: '待重試',
  'retry-wait': '等待重試',
  'manual-needed': '需要補登',
};
const SOURCES = [
  ['all', '全部來源'],
  ['automatic', '含自動資料'],
  ['manual', '含人工補登'],
  ['community', '含可信社群'],
  ['none', '尚無當月資料'],
];
export const validCollectionSource = (value = '') => (SOURCES.some(([key]) => value === key) ? value : 'all');
const SORTS = [
  ['updated-desc', '更新時間：新到舊'],
  ['updated-asc', '更新時間：舊到新'],
  ['request-desc', '抓取時間：新到舊'],
  ['request-asc', '抓取時間：舊到新'],
  ['priority', '收集優先順序'],
  ['crux', 'Chrome 台灣熱門度：高到低'],
];
export const validCollectionSort = (value = '') => (SORTS.some(([key]) => value === key) ? value : 'updated-desc');
const updatedAt = (e: CollectionEntry) =>
  [e.automaticVisitsAt, e.automaticProfileAt, e.manualUpdatedAt, e.communityProvenance?.fetchedAt].filter(Boolean).sort().at(-1) ?? null;
/** Display ordering only: never change the worker's priority queue. Missing timestamps always go last. */
export function sortCollectionEntries(entries: CollectionEntry[], sort = 'updated-desc') {
  const selected = validCollectionSort(sort);
  return [...entries].sort((a, b) => {
    if (selected === 'priority') return 0;
    if (selected === 'crux') return (a.cruxRank ?? 1e12) - (b.cruxRank ?? 1e12);
    const left = selected.startsWith('request-') ? a.lastRequestAt : updatedAt(a);
    const right = selected.startsWith('request-') ? b.lastRequestAt : updatedAt(b);
    if (!left || !right) return Number(!left) - Number(!right);
    return (selected.endsWith('-asc') ? 1 : -1) * left.localeCompare(right);
  });
}
const matchesSource = (e: CollectionEntry, source: string) =>
  source === 'manual'
    ? e.hasManual
    : source === 'automatic'
      ? e.hasAutomatic
      : source === 'community'
        ? !!e.hasCommunity
        : source === 'none'
          ? !e.hasManual && !e.hasAutomatic && !e.hasCommunity
          : true;
const fieldLabel = (key: string) =>
  key.startsWith('channels.')
    ? `渠道：${CHANNELS.find(([channel]) => key === `channels.${channel}`)?.[1] ?? key.slice(9)}`
    : (FIELD_LABELS[key] ?? key);
const stamp = (iso: string | null) =>
  iso
    ? `<time datetime="${html(iso)}" title="${html(tw(iso))}（台北時間）">${html(new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }))}</time>`
    : '時間未記錄';

const glyph = (kind: string) => {
  const paths: Record<string, string> = {
    automatic: '<path d="M3 7a6 6 0 0 1 10-3l2 2M15 2v4h-4M15 11a6 6 0 0 1-10 3l-2-2M3 16v-4h4"/>',
    manual: '<path d="m3 12 9-9 3 3-9 9-4 1 1-4ZM10 5l3 3"/>',
    mixed: '<path d="M3 4h7M3 8h5M3 12h3m2 1 6-6 2 2-6 6-3 1 1-3Z"/>',
    complete: '<circle cx="9" cy="9" r="7"/><path d="m5 9 3 3 5-6"/>',
    pending: '<circle cx="9" cy="9" r="7"/><path d="M9 5v4l3 2"/>',
  };
  return `<svg class="collection-glyph" width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind] ?? paths.pending}</svg>`;
};
function sourceCell(e: CollectionEntry) {
  if (!e.hasManual && !e.hasAutomatic && !e.hasCommunity) return '<span class="collection-muted" title="尚無當月資料">—</span>';
  const labels = [e.hasAutomatic ? '自動抓取' : '', e.hasManual ? '人工補登' : '', e.hasCommunity ? '可信社群' : ''].filter(Boolean);
  const kind = labels.length > 1 ? 'mixed' : e.hasManual ? 'manual' : 'automatic';
  const label = e.hasAutomatic && e.hasManual ? `自動＋人工${e.hasCommunity ? '＋可信社群' : ''}` : labels.join('＋');
  const details = [
    e.automaticVisitsAt ? `<div>自動流量：${stamp(e.automaticVisitsAt)}</div>` : '',
    e.automaticProfileAt ? `<div>自動組成：${stamp(e.automaticProfileAt)}</div>` : '',
    e.manualUpdatedAt ? `<div>人工補登：${stamp(e.manualUpdatedAt)}</div>` : '',
    e.communityProvenance
      ? `<div>可信社群 ${html(e.communityProvenance.sourceNode)}：${stamp(e.communityProvenance.fetchedAt)} <a href="/api/v1/contributors/${html(e.domain)}?month=${e.month}">來源</a></div>`
      : '',
  ].join('');
  return `<details class="collection-source"><summary><span class="collection-source-label ${e.hasManual ? 'has-manual' : ''}">${glyph(kind)}${label}</span></summary>${details || '<div>更新時間未記錄。</div>'}</details>`;
}

function requestCell(e: CollectionEntry) {
  if (!e.lastRequestAt) return '<span class="collection-muted" title="無本月送出紀錄">—</span>';
  const outcome =
    (
      { ok: '已存資料', refused: '上游拒絕', 'old-month': '僅舊月份', error: '失敗', 'no-data': '無可用資料', pending: '處理中' } as Record<
        string,
        string
      >
    )[e.lastRequestOutcome ?? ''] ??
    e.lastRequestOutcome ??
    '結果未記錄';
  return `<details class="collection-request"><summary>${stamp(e.lastRequestAt)}<span class="collection-http ${e.lastRequestOutcome === 'refused' || e.lastRequestOutcome === 'error' ? 'is-error' : ''}" title="${html(outcome)}">${e.lastRequestHttpStatus ?? '…'}</span></summary><div>${html(outcome)}${e.lastRequestHttpStatus ? ` · HTTP ${e.lastRequestHttpStatus}` : ''}</div></details>`;
}

function missingCell(e: CollectionEntry) {
  if (e.complete) return `<span class="collection-status is-complete">${glyph('complete')}已完成</span>`;
  return `<details class="collection-missing"><summary><span class="collection-status">${glyph('pending')}${STATUS[e.status]}</span><span class="collection-missing-count">缺 ${e.missing.length} 項</span></summary><ul>${e.missing.map((key) => `<li>${html(fieldLabel(key))}</li>`).join('')}</ul></details>`;
}

function schedulingNote(policy?: FetchPolicy) {
  if (!policy) return '';
  const reason =
    (
      {
        'provider-cooldown': '上游拒絕後冷卻中',
        'hourly-limit': '本機每小時節流',
        'weekly-limit': '本機每週節流',
        'request-spacing': '等待請求間隔',
        'waiting-for-month': '等待新月份',
        'recovery-probe-limit': '等待恢復驗證名額',
        disabled: '自動抓取已停用',
      } as Record<string, string>
    )[policy.reason ?? ''] ?? (policy.recovery ? '低速恢復驗證中' : '自動收集中');
  return `<details class="collection-schedule"><summary><strong>Similarweb：${reason}</strong>${policy.resumeAt ? ` · 全站最早可送出 ${stamp(policy.resumeAt)}` : ''}<span class="collection-rate">每小時最多 ${policy.hourly.limit} 站</span></summary><p>全站共用本機上限、至少間隔 ${policy.minIntervalSeconds} 秒；逐站依收集優先順序安排。此處時間不是每站預約時間。</p></details>`;
}

export function collectionPage(
  collection: Collection,
  months: string[],
  editor: boolean,
  filter = 'all',
  priority = 0,
  page = 1,
  saved = '',
  source = 'all',
  policy?: FetchPolicy,
  sort = 'updated-desc',
) {
  const { month, summary } = collection;
  source = validCollectionSource(source);
  sort = validCollectionSort(sort);
  const filtered = sortCollectionEntries(
    collection.entries.filter(
      (e) =>
        (filter === 'all' || (filter === 'missing' ? !e.complete : e.status === filter)) &&
        (!priority || e.priority === priority) &&
        matchesSource(e, source),
    ),
    sort,
  );
  const count = 100;
  const totalPages = Math.max(1, Math.ceil(filtered.length / count));
  const at = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const query = (p: number, order = sort) =>
    `/status/collection/?${new URLSearchParams({ month, state: filter, priority: String(priority), source, sort: order, page: String(p) })}`;
  const timeHeader = (key: string, label: string) => {
    const active = sort.startsWith(`${key}-`);
    const ascending = sort === `${key}-asc`;
    return `<th class="l"${active ? ` aria-sort="${ascending ? 'ascending' : 'descending'}"` : ''}><a class="collection-sort${active ? ' active' : ''}" href="${html(query(1, `${key}-${active && !ascending ? 'asc' : 'desc'}`))}">${label}<span aria-hidden="true">${active ? (ascending ? '↑' : '↓') : '↕'}</span></a></th>`;
  };
  const pagination = (label: string) =>
    `<nav class="pagination" aria-label="${label}"><span>符合條件 ${filtered.length} 個${filtered.length ? `，顯示 ${(at - 1) * count + 1}–${Math.min(at * count, filtered.length)} 個` : ''} · 第 ${at} / ${totalPages} 頁</span><span class="links-inline">${at > 1 ? `<a rel="prev" href="${query(at - 1)}">上一頁</a>` : ''}${at < totalPages ? `<a rel="next" href="${query(at + 1)}">下一頁</a>` : ''}</span></nav>`;
  const rows = filtered
    .slice((at - 1) * count, at * count)
    .map((e) => {
      const edit = editor
        ? `<details class="collection-edit"><summary title="調整優先級">${html(e.priorityLabel)}</summary><form class="priority-form" method="post" action="/status/collection/priority"><input type="hidden" name="domain" value="${html(e.domain)}"><input type="hidden" name="month" value="${month}"><input type="hidden" name="state" value="${html(filter)}"><input type="hidden" name="filterPriority" value="${priority}"><input type="hidden" name="source" value="${source}"><input type="hidden" name="sort" value="${sort}"><input type="hidden" name="page" value="${at}"><select name="priority" aria-label="${html(e.domain)} 優先級">${PRIORITY_LABELS.map((label, i) => `<option value="${i}"${e.priorityOverride === i ? ' selected' : ''}>${label}</option>`).join('')}</select><button type="submit" aria-label="${html(e.domain)} 儲存優先級">儲存</button></form></details>`
        : html(e.priorityLabel);
      const next = e.complete
        ? '<span class="collection-muted">—</span>'
        : e.status === 'manual-needed'
          ? '<span class="collection-muted">—</span>'
          : e.nextAttemptAt
            ? stamp(e.nextAttemptAt)
            : '待排程安排';
      return `<tr><td class="l"><div class="collection-site" title="${html(`${e.name} · ${e.domain}`)}">${favicon(e.domain, e.name)}<a href="/site/${html(e.domain)}/" title="${html(`${e.name} · ${e.domain}`)}">${html(e.name)}</a></div></td><td class="l">${e.cruxRank ? cruxLabel(e.cruxRank) : '<span class="collection-muted">—</span>'}</td><td class="l">${sourceCell(e)}</td><td class="l">${updatedAt(e) ? stamp(updatedAt(e)) : '<span class="collection-muted">—</span>'}</td><td class="l">${requestCell(e)}</td><td class="l">${missingCell(e)}</td><td class="l">${edit}</td><td class="l">${next}</td><td class="l"><a class="collection-action" href="/site/${html(e.domain)}/manual/?month=${month}" aria-label="${e.hasManual ? '編輯補登' : '補登'}">${glyph('manual')}${e.hasManual ? '編輯' : '補登'}</a></td></tr>`;
    })
    .join('');
  const orderControl = `<label class="select-field"><span>排序</span><select name="sort">${SORTS.map(([value, label]) => `<option value="${value}"${sort === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
  const controls = `<form class="toolbar-form" method="get"><label class="select-field"><span>月份</span><select name="month">${months.map((m) => `<option value="${m}"${m === month ? ' selected' : ''}>${m.slice(0, 4)}/${m.slice(4)}</option>`).join('')}</select></label><label class="select-field"><span>狀態</span><select name="state">${[['missing', '尚未完成'], ['all', '全部'], ...Object.entries(STATUS)].map(([value, label]) => `<option value="${value}"${filter === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label class="select-field"><span>來源</span><select name="source">${SOURCES.map(([value, label]) => `<option value="${value}"${source === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label class="select-field"><span>優先級</span><select name="priority">${['全部', ...PRIORITY_LABELS.slice(1)].map((label, i) => `<option value="${i}"${priority === i ? ' selected' : ''}>${label}</option>`).join('')}</select></label>${orderControl}<button type="submit">查看</button></form>`;
  const sources = `<nav class="collection-source-counts" aria-label="當月資料來源">${[
    ['all', '全部'],
    ['automatic', '含自動資料'],
    ['manual', '含人工補登'],
    ['community', '含可信社群'],
    ['none', '尚無當月資料'],
  ]
    .map(
      ([value, label]) =>
        `<a href="/status/collection/?month=${month}&state=all&source=${value}&sort=${sort}">${label} <strong>${collection.entries.filter((e) => matchesSource(e, value)).length}</strong></a>`,
    )
    .join('')}</nav>`;
  const priorities = `<details class="collection-overview"><summary>重要網域進度：${summary.priorities.map((p) => `${p.label} ${p.complete} / ${p.total}`).join(' · ')}</summary>${table('<th class="l">優先級</th><th class="num">完整</th><th class="num">追蹤</th>', summary.priorities.map((p) => `<tr><td class="l" data-v="${p.priority}">${p.label}</td><td class="num">${p.complete}</td><td class="num">${p.total}</td></tr>`).join(''), '', 3, 'collection-summary', { pin: false })}</details>`;
  const method = `<h3>資料來源與時間</h3><p>自動抓取與人工補登皆為 Similarweb 資料。來源依所選月份的已存紀錄判定；含人工補登也包含自動與人工都有資料的網域，兩類數字不可相加。點開來源可分別查看自動流量、自動組成與人工更新時間。最近送出只列明確記有目標月份的請求，包含拒絕；無紀錄不等於從未抓過。預設依最新更新時間由新到舊排列，取當月自動流量、自動組成與人工補登的最近更新；最近抓取則只看實際請求時間，失敗不算資料更新。未記錄時間的網域排在最後。畫面排序不影響抓取優先順序。所有時間為台北時間。</p><h3>完整資料與收集順序</h3><p>完整需有正數造訪量、Direct／Search Organic／Social Organic／Referrals／Display Ads／AI 六個渠道的明確值、國家占比及跳出率／每次頁數／停留時間；搜尋廣告、社群廣告、電子郵件、聯盟行銷常在小網站沒有可測值，因此不列為缺漏。未知不當作零。自動資料與人工補登可合併滿足不同欄位，原始資料各自保留。</p><p>平台若顯示 &lt;0.1%，渠道欄位請留白表示未知；若要保存界線值，可在平台詳細分布填寫 &lt;0.1%，不把它誤記成確切的 0。</p><p>核心名單依上月台灣流量取前 ${collection.settings.coreDomains} 個；編輯可指定必抓或調整優先級。同級先擴大覆蓋，每五個可送名額保留一個重試；每次重試至少間隔 ${collection.settings.retryHours} 小時，最多計入 ${collection.settings.maxAttempts} 次後列為需補登。</p><p>只收到舊月份的回應不耗目標月份重試次數，尚未發布時依每日探查間隔等候。舊月份缺漏不刪除，端點已不再提供的組成列為需補登。最早可重試僅反映逐站等待，仍受全域冷卻及限速約束；不是預約時間。實際送出結果請看<a href="/status/">資料更新狀態</a>。</p>`;
  return layout(
    '月份收集',
    {
      title: `${month.slice(0, 4)}/${month.slice(4)} ${source === 'none' ? '尚未有資料的網站' : '收集進度'}`,
      dek: '查看 Similarweb 當月資料來源、抓取紀錄與缺漏；重要網域優先收集。',
      actions: `<a href="/status/">資料更新狀態</a><a href="/api/v1/collection?month=${month}">JSON</a>`,
      toolbar: controls,
    },
    `${saved ? `<p class="flash" role="status">已儲存 ${html(saved)} 的優先級。</p>` : ''}<p class="results-line">追蹤 ${summary.total} 個，完整 ${summary.complete} 個；已有造訪量 ${summary.withVisits} 個，其中 ${summary.partial} 個仍缺其他欄位。需人工補登 ${summary.manualNeeded} 個。</p>${sources}${priorities}${schedulingNote(policy)}
    ${section('逐站收集狀況', `<p class="note">${source === 'none' ? '只列出所選月份沒有自動資料、也沒有人工補登的網站；已有部分資料的網站不列入。' : filter === 'missing' ? '目前只顯示尚未完成的網域。' : ''}台北時間；點時間欄標題可切換排序，點來源或缺漏可看明細。</p>${pagination('逐站缺漏上方分頁')}${table(`<th class="l">網站</th><th class="l"${sort === 'crux' ? ' aria-sort="ascending"' : ''}><a class="collection-sort${sort === 'crux' ? ' active' : ''}" href="${html(query(1, 'crux'))}" title="Chrome UX Report 最新一期的台灣級距">Chrome 台灣<span aria-hidden="true">${sort === 'crux' ? '↑' : '↕'}</span></a></th><th class="l">資料來源</th>${timeHeader('updated', '最新更新')}${timeHeader('request', '最近抓取')}<th class="l">狀態／缺漏</th><th class="l">優先級</th><th class="l">最早可重試</th><th class="l">操作</th>`, rows, '沒有符合條件的網域。', 9, 'collection-entries', { sortable: false, className: 'collection-table' })}${filtered.length > count ? pagination('逐站缺漏下方分頁') : ''}`)}
    ${editor ? `<details class="collection-tools"><summary>管理月份清單</summary><form class="month-form" method="post" action="/status/collection/month"><label>月份 <input name="month" pattern="20[0-9]{2}(0[1-9]|1[0-2])" inputmode="numeric" minlength="6" maxlength="6" size="8" placeholder="YYYYMM" required></label><button type="submit">建立</button></form><p class="note">輸入過去的月份，例如 202610。</p></details>` : ''}`,
    { nav: source === 'none' ? 'missing' : 'status', method },
  );
}
