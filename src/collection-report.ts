import type { Collection } from './collection.ts';
import type { Pool } from './db.ts';
import { type ManagedSite, managedSites } from './metadata.ts';
import { monthView, type SiteMonth } from './metrics.ts';
import { chipRow, favicon, html, layout, SOURCE_LABEL, section, sourceOf, table } from './pages.ts';
import { limitRows, trafficNumber } from './traffic-access.ts';

export interface CollectionReportQuery {
  month?: string;
  saved?: string;
  from?: string;
  topic?: string;
  exclude?: string;
  watchSource?: string;
  q?: string;
  needs?: string;
  sort?: string;
  source?: string;
  state?: string;
  priority?: string;
  page?: string;
  view?: string;
}
const SORTS = [
  ['prevVisits', '比較月造訪量'],
  ['prevTaiwanVisits', '比較月台灣造訪量'],
  ['prevSearchVisits', '比較月搜尋S'],
  ['prevAiVisits', '比較月 AI'],
  ['visits', '當月造訪量'],
  ['taiwanVisits', '當月台灣造訪量'],
  ['searchVisits', '當月搜尋S'],
  ['aiVisits', '當月 AI'],
  ['taiwanSearchVisits', '當月台灣搜尋'],
  ['taiwanAiVisits', '當月台灣 AI'],
  ['taiwanShare', '當月台灣占比'],
  ['growth', '台灣造訪區間變化'],
  ['topicText', '標籤'],
  ['name', '網站名稱'],
] as const;
const split = (value = '') => [
  ...new Set(
    value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
  ),
];
const label = (month: string) => `${month.slice(0, 4)}/${month.slice(4)}`;

export function prepareCollectionReport(collection: Collection, current: SiteMonth[], previous: SiteMonth[], metadata: ManagedSite[]) {
  const sites = new Map(metadata.map((site) => [site.domain, site]));
  const now = new Map(current.map((site) => [site.domain, site]));
  const before = new Map(previous.map((site) => [site.domain, site]));
  return collection.entries.map((entry) => {
    const site = sites.get(entry.domain);
    const currentRow = now.get(entry.domain);
    const prev = before.get(entry.domain);
    const missing = [
      !currentRow || currentRow.visits === null ? '造訪量' : '',
      !currentRow || currentRow.searchShare === null ? '搜尋S' : '',
      !currentRow || currentRow.aiShare === null ? 'AI' : '',
      !currentRow || currentRow.taiwanShareUsed === null ? '台灣占比' : '',
    ].filter(Boolean);
    const metric = (row: SiteMonth | undefined, key: 'searchShare' | 'aiShare') =>
      row?.visits != null && row[key] != null ? row.visits * row[key] : null;
    const taiwan = currentRow?.visits != null && currentRow.taiwanShareUsed != null ? currentRow.visits * currentRow.taiwanShareUsed : null;
    const prevTaiwan = prev?.visits != null && prev.taiwanShareUsed != null ? prev.visits * prev.taiwanShareUsed : null;
    return {
      ...entry,
      topicText: (currentRow?.topics ?? site?.topics ?? prev?.topics ?? []).join('、'),
      taiwanShare: currentRow?.taiwanShareUsed ?? null,
      taiwanSearchVisits: taiwan !== null && currentRow?.searchShare != null ? taiwan * currentRow.searchShare : null,
      taiwanAiVisits: taiwan !== null && currentRow?.aiShare != null ? taiwan * currentRow.aiShare : null,
      growth: taiwan !== null && prevTaiwan !== null && prevTaiwan > 0 ? taiwan / prevTaiwan - 1 : null,
      name: currentRow?.name ?? site?.name ?? prev?.name ?? entry.name,
      topics: currentRow?.topics ?? site?.topics ?? prev?.topics ?? [],
      watchSources: [...new Set(entry.sources.map(sourceOf))],
      missing,
      visits: currentRow?.visits ?? null,
      searchVisits: metric(currentRow, 'searchShare'),
      aiVisits: metric(currentRow, 'aiShare'),
      taiwanVisits:
        currentRow?.visits != null && currentRow.taiwanShareUsed != null ? currentRow.visits * currentRow.taiwanShareUsed : null,
      prevVisits: prev?.visits ?? null,
      prevSearchVisits: metric(prev, 'searchShare'),
      prevAiVisits: metric(prev, 'aiShare'),
      prevTaiwanVisits: prev?.visits != null && prev.taiwanShareUsed != null ? prev.visits * prev.taiwanShareUsed : null,
    };
  });
}
export async function loadCollectionReport(pool: Pool, collection: Collection, from: string) {
  const [current, previous, metadata] = await Promise.all([monthView(pool, collection.month), monthView(pool, from), managedSites(pool)]);
  return { entries: prepareCollectionReport(collection, current, previous, metadata), current, previous };
}
export type CollectionReport = Awaited<ReturnType<typeof loadCollectionReport>>;

export function collectionReportPage(
  collection: Collection,
  months: string[],
  from: string,
  data: CollectionReport,
  query: CollectionReportQuery,
) {
  const month = collection.month;
  const wanted = split(query.topic);
  const excluded = split(query.exclude ?? '非台灣').filter((tag) => !wanted.includes(tag));
  const watchSource = query.watchSource ?? '';
  const q = (query.q ?? '').trim().toLocaleLowerCase();
  const source = ['none', 'all', 'automatic', 'manual'].includes(query.source ?? '') ? query.source! : 'none';
  const needs = ['report', 'all', 'visits'].includes(query.needs ?? '') ? query.needs! : 'all';
  const sort = SORTS.flatMap(([key]) => [`${key}-desc`, `${key}-asc`]).includes(query.sort ?? '') ? query.sort! : 'prevVisits-desc';
  const params = new URLSearchParams({
    month,
    from,
    view: 'report',
    source,
    needs,
    sort,
    topic: wanted.join(','),
    exclude: excluded.join(','),
    watchSource,
    q: query.q ?? '',
  });
  if (query.state) params.set('state', query.state);
  if (query.priority) params.set('priority', query.priority);
  const href = (changes: Record<string, string | number> = {}) => {
    const next = new URLSearchParams(params);
    next.set('page', '1');
    for (const [key, value] of Object.entries(changes)) next.set(key, String(value));
    return `/status/collection/?${next}`;
  };
  const inSource = data.entries.filter((entry) => !watchSource || entry.watchSources.includes(watchSource));
  const topics = new Map<string, number>();
  for (const entry of inSource) for (const tag of entry.topics) topics.set(tag, (topics.get(tag) ?? 0) + 1);
  // Include every tag, including tags without missing sites, to keep the report scope discoverable.
  const scoped = inSource.filter(
    (entry) =>
      wanted.every((tag) => entry.topics.includes(tag)) &&
      !excluded.some((tag) => entry.topics.includes(tag)) &&
      (!q || `${entry.name} ${entry.domain}`.toLocaleLowerCase().includes(q)),
  );
  const matches = scoped.filter(
    (entry) =>
      (source === 'all' ||
        (source === 'none' ? !entry.hasAutomatic && !entry.hasManual : source === 'manual' ? entry.hasManual : entry.hasAutomatic)) &&
      (needs === 'all' || (needs === 'visits' ? entry.visits === null : entry.missing.length > 0)) &&
      (!query.state || query.state === 'all' || (query.state === 'missing' ? !entry.complete : entry.status === query.state)) &&
      (!Number(query.priority) || entry.priority === Number(query.priority)),
  );
  const [key, direction] = sort.split('-') as [(typeof SORTS)[number][0], string];
  matches.sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (left === null || right === null) return Number(left === null) - Number(right === null);
    const order = typeof left === 'string' && typeof right === 'string' ? left.localeCompare(right, 'zh-TW') : Number(left) - Number(right);
    return (direction === 'asc' ? 1 : -1) * order || a.domain.localeCompare(b.domain);
  });
  const visible = limitRows(matches);
  const pages = Math.max(1, Math.ceil(visible.length / 100));
  const page = Math.max(1, Math.min(pages, Math.floor(Number(query.page)) || 1));
  const sources = [...new Set(data.entries.flatMap((entry) => entry.watchSources))];
  const chips =
    chipRow(
      '追蹤來源',
      { href: html(href({ watchSource: '' })), text: '全部來源', on: !watchSource },
      sources.map((value) => ({
        href: html(href({ watchSource: watchSource === value ? '' : value })),
        text: html(SOURCE_LABEL[value] ?? value),
        count: data.entries.filter((entry) => entry.watchSources.includes(value)).length,
        on: watchSource === value,
      })),
    ) +
    chipRow(
      '網站標籤',
      { href: html(href({ topic: '', exclude: '' })), text: '全部標籤', on: !wanted.length && !excluded.length },
      [...topics]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag, count]) => {
          const on = wanted.includes(tag);
          const out = excluded.includes(tag);
          return {
            href: html(
              href({
                topic: (on ? wanted.filter((t) => t !== tag) : out ? wanted : [...wanted, tag]).join(','),
                exclude: (on ? [...excluded, tag] : excluded.filter((t) => t !== tag)).join(','),
              }),
            ),
            text: html(tag),
            count,
            on,
            excluded: out,
          };
        }),
      15,
      '按一下選取標籤（可多選，需同時符合），再按一下排除，第三下取消',
    );
  const select = (name: string, text: string, options: Array<[string, string]>, selected: string) =>
    `<label class="select-field"><span>${text}</span><select name="${name}">${options.map(([value, caption]) => `<option value="${html(value)}"${value === selected ? ' selected' : ''}>${html(caption)}</option>`).join('')}</select></label>`;
  const keep = [...params]
    .filter(([name]) => !['month', 'from', 'source', 'needs', 'sort', 'q', 'page'].includes(name))
    .map(([name, value]) => `<input type="hidden" name="${html(name)}" value="${html(value)}">`)
    .join('');
  const form = `<form class="toolbar-form" method="get">${keep}<label class="search-field"><input type="search" name="q" value="${html(query.q ?? '')}" placeholder="搜尋網站名稱或網域" aria-label="搜尋網站名稱或網域"></label>${select(
    'month',
    '報表月份',
    months.map((m) => [m, label(m)]),
    month,
  )}${select(
    'from',
    '比較月份',
    months.filter((m) => m < month).map((m) => [m, label(m)]),
    from,
  )}${select(
    'source',
    '當月資料',
    [
      ['none', '尚無自動或人工資料'],
      ['all', '全部'],
      ['automatic', '含自動資料'],
      ['manual', '含人工補登'],
    ],
    source,
  )}${select(
    'needs',
    '報表欄位',
    [
      ['all', '全部狀況'],
      ['report', '報表仍缺資料'],
      ['visits', '缺造訪量'],
    ],
    needs,
  )}${select(
    'sort',
    '排序',
    SORTS.flatMap(([value, text]) => [
      [`${value}-desc`, `${text}：高到低`],
      [`${value}-asc`, `${text}：低到高`],
    ]),
    sort,
  )}<button type="submit">查看</button></form>`;
  const numeric = (value: number | null) => (value === null ? '<span class="muted">—</span>' : html(trafficNumber(value, 4)));
  const numberHeader = (value: string, text: string) =>
    `<th class="num"${key === value ? ` aria-sort="${direction === 'asc' ? 'ascending' : 'descending'}"` : ''}><a href="${html(href({ sort: `${value}-${key === value && direction === 'desc' ? 'asc' : 'desc'}` }))}">${text} ↕</a></th>`;
  const rows = visible
    .slice((page - 1) * 100, page * 100)
    .map(
      (entry) =>
        `<tr><td class="l">${favicon(entry.domain, entry.name)}<a href="/site/${html(entry.domain)}/">${html(entry.name)}</a><small class="muted"> ${html(entry.domain)}</small></td><td class="l"><span class="tags">${entry.topics.map((tag) => `<a class="tag" href="${html(href({ topic: tag, exclude: excluded.filter((t) => t !== tag).join(',') }))}">${html(tag)}</a>`).join('')}</span></td><td class="l">${entry.missing.length ? `缺：${entry.missing.join('、')}` : '報表欄位已齊'}<small class="muted">${entry.hasManual ? ' · 已有人工補登' : !entry.hasAutomatic ? ' · 尚無自動或人工資料' : ' · 已有自動資料'}</small></td>${['visits', 'searchVisits', 'aiVisits', 'prevVisits', 'prevSearchVisits', 'prevAiVisits'].map((metric) => `<td class="num">${numeric(entry[metric as 'visits'])}</td>`).join('')}<td class="l"><a href="/site/${html(entry.domain)}/manual/?month=${month}">${entry.hasManual ? '編輯補登' : '補登'}</a></td></tr>`,
    )
    .join('');
  const csvParams = new URLSearchParams({
    month,
    from,
    topic: wanted.join(','),
    exclude: excluded.join(','),
    source: watchSource,
    q: query.q ?? '',
  });
  const reportHash = new URLSearchParams({
    to: month,
    from,
    topic: wanted.join(','),
    exclude: excluded.join(','),
    source: watchSource,
    q: query.q ?? '',
  });
  const pager = `<nav class="pagination" aria-label="報表待補清單分頁"><span>符合條件 ${matches.length} 個 · 第 ${page} / ${pages} 頁</span><span>${page > 1 ? `<a href="${html(href({ page: page - 1 }))}">上一頁</a>` : ''} ${page < pages ? `<a href="${html(href({ page: page + 1 }))}">下一頁</a>` : ''}</span></nav>`;
  return layout(
    '報表待補資料',
    {
      title: `${label(month)} 報表待補資料`,
      dek: '依報表標籤與來源找出待補網站，參考比較月流量決定補登順序。',
      toolbar: form,
      actions: `<a href="/api/v1/rankings.csv?${html(csvParams.toString())}">下載報表 CSV（含比較月）</a><a href="/#${html(reportHash.toString())}">查看此範圍的流量報表</a>`,
    },
    ` ${query.saved ? `<p class="flash" role="status">已儲存 ${html(query.saved)} 的優先級。</p>` : ''}<div class="chip-rows">${chips}</div><p class="results-line">此範圍追蹤 ${scoped.length} 個網站，${scoped.filter((entry) => entry.missing.length).length} 個仍缺報表欄位。<a href="${html(href({ source: 'all', needs: 'report', state: 'all' }))}">查看所有報表缺資料的網站（含部分資料）</a></p><p class="note">數值單位：百萬次。當月與比較月都顯示造訪量、自然搜尋S、AI 導流；未知顯示「—」，不當作零。標籤數量以追蹤名單計算，包含當月尚無流量的網站。已有試算表資料時可能足以產出報表，但仍沒有當月自動或人工資料。</p>${section('報表待補清單', pager + table(`<th class="l">網站</th><th class="l">標籤</th><th class="l">報表缺漏</th>${numberHeader('visits', `${label(month)} 造訪`)}${numberHeader('searchVisits', '搜尋S')}${numberHeader('aiVisits', 'AI')}${numberHeader('prevVisits', `${label(from)} 造訪`)}${numberHeader('prevSearchVisits', '比較月搜尋S')}${numberHeader('prevAiVisits', '比較月 AI')}<th class="l">操作</th>`, rows, '沒有符合條件的網站。', 10, 'report-collection', { sortable: false }) + pager)}<p class="note"><a href="${html(href({ view: 'collection', sort: 'updated-desc' }))}">查看收集排程、完整欄位缺漏與優先級</a></p>`,
    {
      nav: 'missing',
      method:
        '<p>標籤與追蹤來源套用於整份待製作報表；報表缺資料指造訪量、自然搜尋S、AI 或台灣占比仍未知，與需要十個渠道及互動資料的完整收集標準不同。明確的零值不算缺漏。</p><p>下載的 CSV 包含所選標籤、來源與搜尋範圍的整份報表，不限目前顯示的缺漏清單；同一列附當月與比較月數值，只有比較月資料的網站也保留。名次與比較月名次依台灣造訪量排列，造訪量排名、搜尋排行與 AI 排行則分別依各自的全站數值排列。各月排名先在所選標籤與來源範圍內計算，再套用名稱搜尋；缺值留白，所有造訪次數以百萬為單位。</p>',
    },
  );
}
