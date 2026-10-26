import { chipRow, favicon, html, layout, methodPart, SOURCE_LABEL, section, siteCell, sortCell, table, tw, twDate } from './pages.ts';
import { CATEGORIES, CATEGORY_LABEL, PRODUCTS, type TechCategory, type TechErrorCode, type TechStatus } from './tech.ts';
import type { TechRecord } from './tech-scan.ts';

// /tech/ (every known site's technologies), /tech/<domain>/ (one domain, any domain) and the site page's 網站技術
// block. The overview is computed once here for the page and /api/v1/tech alike.

export const STATUS_LABEL: Record<TechStatus, string> = { detected: '偵測到', unknown: '未辨識', failed: '無法讀取', blocked: '被阻擋' };
export const ERROR_LABEL: Record<TechErrorCode, string> = {
  robots: 'robots.txt 不允許',
  waf: '防火牆或驗證頁',
  'rate-limit': '請求過多（429）',
  'http-error': 'HTTP 錯誤',
  'not-html': '首頁不是網頁',
  timeout: '逾時',
  network: '連不上',
  address: '網域指向非公開位址',
};
const EVIDENCE_LABEL: Record<string, string> = {
  'URL rule': '網址',
  'page markup rule': '頁面標記',
  'inline script rule': '內嵌 script',
  'script URL rule': '載入的 script',
  'meta tag rule': 'meta 標籤',
  'response header rule': '回應標頭',
};

const techMethod = (
  count: number,
) => `<p>每個網域的首頁一個月抓一次（網站雷達自己抓，和一般瀏覽器一樣讀首頁），比對 <a href="https://github.com/enthec/webappanalyzer" rel="noopener">Wappalyzer 社群版規則</a>裡本站列出的 ${count} 項技術：網址、HTML、script、meta、回應標頭與頁面元素。需要執行 JavaScript、讀 cookie 或另外發請求的規則不採用，所以只靠前端程式載入的技術可能看不到。</p>
<p>一頁只能證明它帶了什麼，不能證明網站沒用什麼：「未辨識」表示首頁沒有清單內任何技術的痕跡，不是沒有技術。版本只來自網頁明寫的 <code>meta generator</code>，互相矛盾時標「不明」；CDN 與主機只是提示，信心最多 40%。抓取失敗時保留上一次成功的結果。部落格原本在 blog.observe.tw 由文章頁偵測的結果已併入，等本站自己抓過後取代。</p>`;

export interface TechSite {
  domain: string;
  name: string;
  status: TechStatus | null;
  errorCode: TechErrorCode | null;
  observedAt: string | null;
  lastAttemptAt: string | null;
  origin: string | null;
  detections: Array<{ id: string; name: string; category: TechCategory; version: string }>;
}
export interface TechOverview {
  generatedAt: string;
  coverage: { sites: number; checked: number; withSnapshot: number; detected: number; unknown: number; failed: number; blocked: number };
  technologies: Array<{ id: string; name: string; category: TechCategory; sites: number }>;
  sites: TechSite[];
  filters: { source: string | null; category: TechCategory | null; technology: string | null; status: TechStatus | 'unchecked' | null };
  sources: Array<{ source: string; sites: number }>;
}

/** Counts over the chosen source's sites; the site list is narrowed further by category, technology and status. */
export function techOverview(
  domains: string[],
  names: Map<string, string>,
  records: Map<string, TechRecord>,
  lists: Map<string, Set<string>>,
  query: { source?: unknown; category?: unknown; technology?: unknown; status?: unknown },
  now = new Date(),
): TechOverview {
  const source = typeof query.source === 'string' && lists.has(query.source) ? query.source : null;
  const cohort = source ? domains.filter((d) => lists.get(source)?.has(d)) : domains;
  const sites: TechSite[] = cohort.map((domain) => {
    const r = records.get(domain);
    return {
      domain,
      name: names.get(domain) ?? domain,
      status: r?.status ?? null,
      errorCode: r?.errorCode ?? null,
      observedAt: r?.observedAt ?? null,
      lastAttemptAt: r?.lastAttemptAt ?? null,
      origin: r?.origin ?? null,
      detections: (r?.detections ?? []).map((d) => ({ id: d.id, name: d.name, category: d.category, version: d.version })),
    };
  });
  const counts = new Map<string, TechOverview['technologies'][number]>();
  for (const s of sites)
    for (const d of s.detections) {
      const c = counts.get(d.id) ?? counts.set(d.id, { id: d.id, name: d.name, category: d.category, sites: 0 }).get(d.id);
      if (c) c.sites++;
    }
  const technologies = [...counts.values()].sort((a, b) => b.sites - a.sites || a.name.localeCompare(b.name));
  const category = CATEGORIES.includes(query.category as TechCategory) ? (query.category as TechCategory) : null;
  const technology =
    typeof query.technology === 'string' && (counts.has(query.technology) || PRODUCTS.has(query.technology)) ? query.technology : null;
  const status = ['detected', 'unknown', 'failed', 'blocked', 'unchecked'].includes(query.status as string)
    ? (query.status as TechOverview['filters']['status'])
    : null;
  const shown = sites.filter(
    (s) =>
      (!technology || s.detections.some((d) => d.id === technology)) &&
      (!category || s.detections.some((d) => d.category === category)) &&
      (!status || (status === 'unchecked' ? s.status === null : s.status === status)),
  );
  const tally = (st: TechStatus) => sites.filter((s) => s.status === st).length;
  return {
    generatedAt: now.toISOString(),
    coverage: {
      sites: sites.length,
      checked: sites.filter((s) => s.status !== null).length,
      withSnapshot: sites.filter((s) => s.observedAt !== null).length,
      detected: tally('detected'),
      unknown: tally('unknown'),
      failed: tally('failed'),
      blocked: tally('blocked'),
    },
    technologies,
    sites: shown.sort((a, b) => b.detections.length - a.detections.length || a.name.localeCompare(b.name)),
    filters: { source, category, technology, status },
    sources: [...lists].map(([s, set]) => ({ source: s, sites: domains.filter((d) => set.has(d)).length })),
  };
}

const techChip = (d: { id: string; name: string; version: string }, href = `/tech/?technology=${encodeURIComponent(d.id)}`) =>
  `<a class="tag" href="${html(href)}">${html(d.name)}${d.version !== 'unknown' ? ` ${html(d.version)}` : ''}</a>`;
export function techPage(o: TechOverview, view?: unknown) {
  const { coverage: c, filters: f } = o;
  const chosen = o.technologies.find((t) => t.id === f.technology) ?? PRODUCTS.get(f.technology ?? '');
  const showingSites = !!chosen || view === 'sites' || !!f.status;
  const link = (q: Partial<Record<'source' | 'category' | 'technology' | 'status', string | null>>) => {
    const p = new URLSearchParams();
    for (const key of ['source', 'category', 'technology', 'status'] as const) {
      const value = key in q ? q[key] : f[key];
      if (value) p.set(key, value);
    }
    if (view === 'sites' || (f.status && !chosen)) p.set('view', 'sites');
    const s = p.toString();
    return s ? `/tech/?${html(s)}` : '/tech/';
  };
  const sourceChips = chipRow(
    '來源',
    { href: link({ source: null }), text: '全部來源', on: !f.source },
    o.sources.map((s) => ({
      href: link({ source: s.source }),
      text: SOURCE_LABEL[s.source] ?? html(s.source),
      count: s.sites,
      on: f.source === s.source,
    })),
  );
  const used = new Set(o.technologies.map((t) => t.category));
  const categoryChips = chipRow(
    '類別',
    { href: link({ category: null, technology: null }), text: '全部類別', on: !f.category },
    CATEGORIES.filter((k) => used.has(k)).map((k) => ({
      href: link({ category: f.category === k ? null : k, technology: null }),
      text: CATEGORY_LABEL[k],
      on: f.category === k,
    })),
    8,
  );
  const statusChips = chipRow(
    '檢查結果',
    { href: link({ status: null }), text: '全部結果', on: !f.status },
    (['detected', 'unknown', 'failed', 'blocked', 'unchecked'] as const).map((s) => ({
      href: link({ status: f.status === s ? null : s }),
      text: s === 'unchecked' ? '尚未檢查' : STATUS_LABEL[s],
      on: f.status === s,
    })),
  );
  const technologies = o.technologies.filter((t) => !f.category || t.category === f.category);
  const techRows = technologies
    .map((t) => {
      const href = link({ technology: t.id, status: null });
      return `<li data-tech-name="${html(t.name)}" data-tech-count="${t.sites}"><a class="tech-name" href="${href}"><span class="tech-item-label">${html(t.name)}<small>${CATEGORY_LABEL[t.category]}</small></span><span class="tech-item-count">${t.sites.toLocaleString('en-US')}<small>${c.withSnapshot ? `${((t.sites / c.withSnapshot) * 100).toFixed(1)}%` : '—'}</small></span><span aria-hidden="true">→</span></a></li>`;
    })
    .join('');
  const siteRows = o.sites
    .map(
      (s) =>
        `<tr>${siteCell(s.domain, s.name).replace(` href="/site/${html(s.domain)}/"`, ` href="/tech/${html(s.domain)}/"`)}<td class="l"><span class="tags">${s.detections
          .filter((d) => !f.category || d.category === f.category)
          .sort((a, b) => Number(b.id === f.technology) - Number(a.id === f.technology))
          .map((d) =>
            d.id === f.technology
              ? `<span class="tag tech-selected">${html(d.name)}${d.version !== 'unknown' ? ` ${html(d.version)}` : ''}</span>`
              : techChip(d, link({ technology: d.id, category: null, status: null })),
          )
          .join('')}</span></td>${sortCell('l', s.observedAt ?? '', s.observedAt ? twDate(s.observedAt) : '')}</tr>`,
    )
    .join('');
  const browseLink = (() => {
    const p = new URLSearchParams();
    if (f.source) p.set('source', f.source);
    if (f.category) p.set('category', f.category);
    return `/tech/${p.size ? `?${html(p.toString())}` : ''}`;
  })();
  const search = (id: string, label: string) =>
    `<label class="search-field tech-search"><input type="search" ${id === 'tech-catalog' ? 'data-tech-search' : `data-table-filter="${id}"`} aria-label="${label}" placeholder="${label}" autocomplete="off"></label>`;
  const filters = `<div class="tech-filters"><div><span class="tech-filter-label">網站來源</span>${sourceChips}</div>${!chosen ? `<div><span class="tech-filter-label">技術類別</span>${categoryChips}</div>` : ''}${showingSites ? `<div><span class="tech-filter-label">檢查結果</span>${statusChips}</div>` : ''}</div>`;
  const heading = chosen ? `用 ${chosen.name} 的網站` : showingSites ? '所有網站的技術' : '網站技術';
  const navigation = showingSites
    ? `<nav class="tech-breadcrumb" aria-label="技術導覽"><a href="${browseLink}">← 返回技術總覽</a><span aria-current="page">${chosen ? html(chosen.name) : '所有網站'}</span></nav>`
    : `<nav class="tech-breadcrumb" aria-label="技術導覽"><span aria-current="page">技術總覽</span><a href="${link({ technology: null })}${link({ technology: null }).includes('?') ? '&amp;' : '?'}view=sites">瀏覽所有網站 →</a></nav>`;
  const content = showingSites
    ? `${chosen ? `<div class="tech-selection"><span>${CATEGORY_LABEL[chosen.category]}</span><p>找到 <b>${o.sites.length.toLocaleString('en-US')}</b> 個網站使用這項技術。</p></div>` : ''}${filters}
      ${section('網站清單', `<div class="tech-results"><p data-table-count="tech-sites" data-total="${o.sites.length}" role="status">${o.sites.length.toLocaleString('en-US')} 個網站</p>${search('tech-sites', '搜尋網站名稱或網域')}</div>${table('<th class="l">網站</th><th class="l">偵測到的技術</th><th class="l">檢查日期</th>', siteRows, `沒有符合條件的網站。<a href="${link({ status: null, category: null })}">清除結果與類別篩選</a>`, 3, 'tech-sites')}`)}`
    : `${filters}${section('選一項技術，查看哪些網站使用', `<div class="tech-results"><p data-table-count="tech-catalog" data-total="${technologies.length}" role="status">${technologies.length} 項技術 · 網站數 / 比例</p>${search('tech-catalog', '搜尋技術，例如 Google Tag Manager')}</div><label class="tech-sort">排序 <select data-tech-sort aria-label="技術排序"><option value="count">網站數最多</option><option value="name">名稱 A–Z</option></select></label><ul id="tech-catalog" class="tech-catalog" aria-label="技術，依網站數排序">${techRows}</ul><p data-tech-empty${technologies.length ? ' hidden' : ''}>沒有符合條件的技術。</p>`)}`;
  return layout(
    heading,
    {
      title: heading,
      dek: showingSites ? '從網站名稱進入詳情，也可以返回總覽探索其他技術。' : '探索網站使用的工具。選擇技術，再查看網站與偵測詳情。',
      actions: `<a href="/api/v1/tech${link({}).slice('/tech/'.length)}">JSON</a>`,
      tabs: navigation,
    },
    `<div class="tech-explorer">${content}</div>`,
    {
      nav: 'tech',
      method: `${techMethod(PRODUCTS.size)}${methodPart('技術', `<p>每項技術出現在幾個網站的首頁；比例的分母是此來源有成功檢查結果的 ${c.withSnapshot.toLocaleString('en-US')} 個網站。一個網站可能使用多項技術。網站數與比例不受檢查結果篩選影響。</p>`)}`,
    },
  );
}

export interface TechViewer {
  loginEnabled: boolean;
  signedIn: boolean;
  message?: string;
}
const MESSAGES: Record<string, string> = {
  checked: '已重新檢查。',
  recent: '十分鐘內才檢查過，先顯示上次的結果。',
  rate_limited: '檢查太頻繁，請稍後再試（每個帳號每小時 10 次）。',
  no_rules: '偵測規則尚未安裝，暫時無法檢查。',
};

const detectionRows = (r: TechRecord) =>
  [...r.detections]
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name))
    .map(
      (d) =>
        `<tr><td class="l" data-v="${html(d.name)}">${techChip(d)}</td><td class="l" data-v="${CATEGORIES.indexOf(d.category)}">${CATEGORY_LABEL[d.category] ?? html(d.category)}</td><td class="l">${d.version === 'unknown' ? '<span class="muted">不明</span>' : html(d.version)}</td>${sortCell('num', d.confidence, `${Math.round(d.confidence * 100)}%`)}<td class="l">${d.evidence
          .map((e) => (e.kind === 'generator' ? `meta generator：${html(e.value)}` : (EVIDENCE_LABEL[e.value] ?? html(e.value))))
          .join('、')}</td></tr>`,
    )
    .join('');

/** One domain's result; `known` when it is on a list (then it also has a site page). */
export function techDomainPage(domain: string, name: string | null, record: TechRecord | null, known: boolean, viewer: TechViewer) {
  const title = name ?? domain;
  const check = viewer.signedIn
    ? `<form class="inline" method="post" action="/tech/${html(domain)}/check"><button type="submit">${record ? '重新檢查' : '立即檢查'}</button></form>`
    : viewer.loginEnabled
      ? `<a href="/auth/google?next=${encodeURIComponent(`/tech/${domain}/`)}">登入後${record ? '重新檢查' : '立即檢查'}</a>`
      : '';
  const flash = viewer.message && MESSAGES[viewer.message] ? `<p class="flash" role="status">${MESSAGES[viewer.message]}</p>` : '';
  const stat = (label: string, value: string, sub = '') =>
    `<div><span>${label}</span><b>${value || '—'}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const body = record
    ? `<div class="stats">${stat('最近一次', STATUS_LABEL[record.status], record.errorCode ? (ERROR_LABEL[record.errorCode] ?? html(record.errorCode)) : '')}${stat('技術', String(record.detections.length))}${stat('結果時間', record.observedAt ? twDate(record.observedAt) : '', record.origin === 'blog' ? '來自 blog.observe.tw' : '')}${stat('最近嘗試', twDate(record.lastAttemptAt), record.httpStatus ? `HTTP ${record.httpStatus}` : '')}</div>
${section(
  '偵測到的技術',
  `${record.observedAt === null ? '<p class="note">還沒有成功讀到首頁。</p>' : `<p class="note">${record.sourceUrl ? `讀的是 <a href="${html(record.sourceUrl)}" rel="noopener nofollow">${html(record.sourceUrl)}</a>，` : ''}${tw(record.observedAt)}。${record.status === 'failed' || record.status === 'blocked' ? '之後的檢查沒有成功，這是上一次成功的結果。' : ''}</p>`}${table(
    '<th class="l">技術</th><th class="l" aria-sort="ascending">類別</th><th class="l">版本</th><th class="num">信心</th><th class="l">依據</th>',
    detectionRows(record),
    record.observedAt === null ? '沒有結果。' : '首頁沒有清單內任何技術的痕跡（未辨識，不代表沒有技術）。',
    5,
  )}`,
)}`
    : section(
        '還沒檢查過',
        `<p class="body">${known ? '這個網域在追蹤清單裡，會在排程輪到時檢查。' : '這個網域不在任何追蹤清單裡，不會自動檢查。'}${check ? '也可以現在就檢查。' : ''}</p>`,
      );
  return layout(
    `${title} 的網站技術`,
    {
      title,
      dek: `${favicon(domain, title)}<a href="https://${html(domain)}/" rel="noopener">${html(domain)} ↗</a>${known ? `<span class="sep" aria-hidden="true">·</span><a href="/site/${html(domain)}/">流量資料</a>` : ''}`,
      actions: `${check}<a href="/api/v1/tech/${html(domain)}">JSON</a>`,
    },
    `<nav class="tech-breadcrumb" aria-label="技術導覽"><a href="/tech/">← 返回技術總覽</a><a href="/tech/?view=sites">所有網站</a><span aria-current="page">${html(domain)}</span></nav>${flash}${body}`,
    {
      nav: 'tech',
      method: `${techMethod(PRODUCTS.size)}${record ? methodPart('偵測到的技術', '<p>「依據」是哪一類規則比對到，不是頁面內容。</p>') : ''}`,
    },
  );
}

/** The site page's block: the technologies by category, linking to /tech/<domain>/. */
export function techSection(domain: string, record: TechRecord | null) {
  if (!record)
    return section(
      '網站技術',
      `<p class="note">首頁還沒檢查過，排程輪到時會檢查。<a href="/tech/${html(domain)}/">技術頁</a></p>`,
      ' id="tech"',
    );
  const byCategory = CATEGORIES.map((k) => [k, record.detections.filter((d) => d.category === k)] as const).filter(
    ([, list]) => list.length,
  );
  const list = byCategory.length
    ? `<dl class="tech-list">${byCategory.map(([k, items]) => `<dt>${CATEGORY_LABEL[k]}</dt><dd><span class="tags">${items.map((d) => techChip(d)).join('')}</span></dd>`).join('')}</dl>`
    : `<p class="body">${record.observedAt ? '首頁沒有清單內任何技術的痕跡（未辨識）。' : `還沒有成功讀到首頁（${ERROR_LABEL[record.errorCode as TechErrorCode] ?? STATUS_LABEL[record.status]}）。`}</p>`;
  return section(
    '網站技術',
    `${list}<p class="note">${record.observedAt ? `${twDate(record.observedAt)} 從首頁偵測${record.origin === 'blog' ? '（blog.observe.tw 的結果）' : ''}。` : ''}<a href="/tech/${html(domain)}/">版本、依據與檢查紀錄</a></p>`,
    ' id="tech"',
  );
}
