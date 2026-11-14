import { type ManualMonth, manualChannels, manualDesktopChannels, manualDetailFields, manualDetailValues, proUrl } from './manual.ts';
import { breakdownFields, breakdownTotals } from './manual-breakdowns.ts';
import { MANUAL_FORM_SCRIPT } from './manual-form-script.ts';
import { OCR_IMPORTER, OCR_STYLE } from './manual-ocr.ts';
import type { ManagedSite } from './metadata.ts';
import { displayHtml, favicon, html, layout, siteTabs, vol, volText } from './pages.ts';

export interface ManualForm {
  months: ManualMonth[];
  /** Months that can be entered, newest first. */
  choices: string[];
  /** What the free endpoint last answered for the domain, oldest first; estimated is false when it said 0. */
  free: Array<{ month: string; estimated: boolean }>;
  message?: string;
  error?: string;
  errorFields?: string[];
  selectedMonth?: string;
  completedMonth?: string;
  draft?: Record<string, string | undefined>;
}

const monthLabel = (m: string) => `${m.slice(0, 4)}/${m.slice(4)}`;
const percent = (n: number | null, digits: number) => (n === null ? '—' : `${(n * 100).toFixed(digits)}%`);
/** Visits (a count) as the platform writes them, which the form reads back. */
const millions = (n: number) => volText(n / 1e6);
/** How a share is written back into the form: 0.3645 → "36.45". */
const percentInput = (n: number | null) => (n === null ? '' : String(Math.round(n * 1e4) / 100));
const flash = (error?: string, message?: string) =>
  error
    ? `<p class="flash" role="alert">${displayHtml(error)}</p>`
    : message
      ? `<p class="flash" role="status">${displayHtml(message)}</p>`
      : '';
/** The site's own head on every page of it, with the sub-pages as tabs. */
const siteHead = (site: Pick<ManagedSite, 'domain' | 'name'>, tab: 'edit' | 'manual', actions = '') => ({
  title: site.name,
  dek: `${favicon(site.domain, site.name)}<a href="https://${html(site.domain)}/" rel="noopener">${displayHtml(site.domain)} ↗</a>`,
  tabs: siteTabs(site.domain, tab),
  actions,
});

/** Known tags, most used first; the tag editor offers them in this order. */
const options = (topics: string[]) =>
  `<datalist id="tag-suggestions">${[...new Set(topics)].map((t) => `<option value="${html(t)}"></option>`).join('')}</datalist>`;
/** Without JavaScript this is a comma-separated text box; TAG_SCRIPT turns it into chips and a search. */
const tagInput = (name: string, title: string, value: string, hint: string) =>
  `<div class="field tag-editor" data-tag-editor><label for="tags-${name}">${title}</label><textarea id="tags-${name}" name="${name}" rows="2" maxlength="8000">${html(value)}</textarea><small>${hint}</small></div>`;

// One stable list of toggle buttons: selected and suggested tags share the same controls.
const TAG_SCRIPT = `<script>
(() => {
  const split = (v) => [...new Set(v.split(/[,，、;；\\n]+/).map((t) => t.trim()).filter(Boolean))];
  const known = [...document.querySelectorAll('#tag-suggestions option')].map((o) => o.value);
  const make = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
  document.querySelectorAll('[data-tag-editor]').forEach((host, n) => {
    const textarea = host.querySelector('textarea');
    const label = host.querySelector('label');
    const initial = split(textarea.value);
    let tags = [...initial], expanded = false;
    const choices = [...new Set([...initial, ...known])];
    const toolbar = make('div', 'tag-toolbar');
    const input = make('input'); input.type = 'search'; input.maxLength = 64; input.autocomplete = 'off';
    input.id = 'tag-search-' + n; input.placeholder = '搜尋或新增標籤'; input.setAttribute('aria-label', '搜尋或新增' + label.textContent);
    const create = make('button', 'tag-text-button', '新增'); create.type = 'button'; create.hidden = true;
    toolbar.append(input, create);
    const list = make('div', 'tag-options'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', label.textContent);
    const footer = make('div', 'tag-foot');
    const status = make('span', 'note'); status.setAttribute('role', 'status');
    const more = make('button', 'tag-text-button'); more.type = 'button';
    const reset = make('button', 'tag-text-button', '還原'); reset.type = 'button';
    footer.append(status, more, reset);
    const render = (focusTag) => {
      textarea.value = tags.join(', ');
      const query = input.value.trim().toLocaleLowerCase();
      const filtered = choices.filter((t) => !query || t.toLocaleLowerCase().includes(query));
      const visible = query || expanded ? filtered : filtered.filter((t, i) => i < 14 || tags.includes(t));
      list.replaceChildren(...visible.map((tag) => {
        const selected = tags.includes(tag);
        const button = make('button', 'chip-filter tag-option' + (selected && textarea.name === 'remove' ? ' excluded' : '')); button.type = 'button'; button.dataset.tag = tag;
        button.setAttribute('aria-pressed', String(selected));
        const mark = make('span', 'tag-check', selected ? (textarea.name === 'remove' ? '−' : '✓') : ''); mark.setAttribute('aria-hidden', 'true');
        button.append(mark, make('span', 'tag-label', tag));
        button.addEventListener('click', () => {
          tags = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
          render(tag);
        });
        return button;
      }));
      if (!visible.length) list.append(make('span', 'note', '沒有符合的標籤'));
      const parts = split(input.value);
      create.hidden = !parts.length || parts.every((t) => tags.includes(t));
      create.textContent = parts.length === 1 && choices.includes(parts[0]) ? '加入' : '新增';
      more.hidden = !!query || choices.length <= 14;
      more.textContent = expanded ? '收合' : '全部標籤（' + choices.length + '）';
      more.setAttribute('aria-expanded', String(expanded));
      const dirty = tags.length !== initial.length || tags.some((t) => !initial.includes(t));
      status.textContent = tags.length + ' 個已選' + (dirty ? '・尚未儲存' : '');
      reset.hidden = !dirty;
      if (focusTag) [...list.children].find((el) => el.dataset.tag === focusTag)?.focus();
    };
    const add = () => {
      for (const tag of split(input.value)) {
        if (!choices.includes(tag)) choices.unshift(tag);
        if (!tags.includes(tag)) tags.push(tag);
      }
      input.value = ''; render(); input.focus();
    };
    input.addEventListener('input', () => render());
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); if (input.value.trim()) add(); }
      if (event.key === 'Escape') { input.value = ''; render(); }
    });
    create.addEventListener('click', add);
    more.addEventListener('click', () => { expanded = !expanded; render(); });
    reset.addEventListener('click', () => { tags = [...initial]; input.value = ''; render(); input.focus(); });
    textarea.hidden = true;
    label.htmlFor = input.id;
    textarea.after(toolbar, list, footer);
    render();
  });
})();
</script>`;

export function editSitePage(
  site: ManagedSite,
  suggestions: string[],
  error = '',
  draft?: { name?: string; topics?: string; revision?: string },
  message = '',
) {
  return layout(
    `名稱與標籤・${site.name}`,
    siteHead(site, 'edit', '<a href="/sites/">批次管理標籤</a>'),
    `${flash(error, message)}
<form class="form edit-form" method="post" action="/site/${html(site.domain)}/edit/">
<input type="hidden" name="revision" value="${html(draft?.revision ?? site.revision)}">
<div class="field edit-name"><label for="site-name">網站名稱</label><input id="site-name" name="name" maxlength="128" value="${displayHtml(draft?.name ?? site.name)}"></div>
${tagInput('topics', '標籤', draft?.topics ?? site.baseTopics.join(', '), '點選加入或移除，儲存後生效。')}
<div class="form-actions"><button type="submit" class="tag-save">儲存變更 →</button><a href="/site/${html(site.domain)}/#tags">查看標籤投票</a></div><details class="tag-help"><summary>編輯說明</summary><p>名稱留空會沿用試算表。這裡調整的是編輯清單，匯入試算表不會覆蓋設定；讀者提議與管理員顯示設定可到網站的標籤區操作。</p></details>
</form>${options(suggestions)}${TAG_SCRIPT}`,
    { nav: 'sites' },
  );
}

/** Copying months from Similarweb's platform for a domain its free data does not estimate. */
export function manualPage(site: Pick<ManagedSite, 'domain' | 'name'>, form: ManualForm) {
  const d = form.draft ?? {};
  const byMonth = new Map(form.months.map((m) => [m.month, m]));
  const selected = d.month ?? form.selectedMonth;
  const month = selected && form.choices.includes(selected) ? selected : form.choices[0];
  const invalid = (key: string) => (form.errorFields?.includes(key) ? ' aria-invalid="true" aria-describedby="manual-error"' : '');
  // A month already entered starts filled in, so correcting it is just editing the numbers.
  const saved = byMonth.get(month);
  const detailValues = manualDetailValues(saved);
  const value = (key: keyof NonNullable<ManualForm['draft']>, fromSaved: string) => html(form.draft ? (d[key] ?? '') : fromSaved);
  const field = (key: string, label: string, where: string, placeholder: string, fromSaved: string, unit = '') =>
    `<div class="field"><label for="manual-${key}">${label}</label><span class="input-unit"><input id="manual-${key}" name="${key}"${invalid(key)} value="${value(key, fromSaved)}" placeholder="${placeholder ? `例如 ${placeholder}` : ''}" inputmode="${['visits', 'countryCode', 'category', 'duration', ...breakdownTotals.map(([key]) => key)].includes(key) ? 'text' : 'decimal'}" autocomplete="off"${key === 'visits' ? ' required' : ''}>${unit ? `<span>${unit}</span>` : ''}</span><small>${where}</small></div>`;
  const free = form.free.length
    ? form.free.map((f) => `${monthLabel(f.month)} ${f.estimated ? '有估算' : '<b>無估算</b>'}`).join('・')
    : '還沒有向 Similarweb 抓過';
  const needed = form.free.some((f) => !f.estimated);
  const rows = [...form.months]
    .reverse()
    .map(
      (m) =>
        `<tr><td class="l" data-v="${m.month}">${monthLabel(m.month)}</td><td class="num" data-v="${m.visits}">${vol(m.visits / 1e6)}</td><td class="num">${percent(m.searchShare, 2)}</td><td class="num">${percent(m.aiShare, 2)}</td><td class="num">${percent(m.taiwanShare, 2)}</td>${manualChannels.map(([key]) => `<td class="num">${percent(m.channels[key] ?? null, 2)}</td>`).join('')}<td class="l"><span class="site-identity"><span>${html(m.updatedBy)}</span><span class="site-domain">${html(new Date(m.updatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, dateStyle: 'short', timeStyle: 'short' }))}</span></span></td><td><form class="inline" method="post" action="/site/${html(site.domain)}/manual/" onsubmit="return confirm('刪除 ${monthLabel(m.month)} 的補登數字？')"><input type="hidden" name="month" value="${m.month}"><input type="hidden" name="action" value="delete"><button type="submit" class="quiet">刪除</button></form></td></tr>`,
    )
    .join('');
  const savedData = (m: string) => {
    const r = byMonth.get(m);
    return r
      ? ` data-visits="${millions(r.visits)}" data-search="${percentInput(r.searchShare)}" data-ai="${percentInput(r.aiShare)}" data-taiwan="${percentInput(r.taiwanShare)}"${manualChannels.map(([key]) => ` data-${key.toLowerCase()}="${percentInput(r.channels[key] ?? null)}"`).join('')}${Object.entries(
          manualDetailValues(r),
        )
          .map(([key, v]) => ` data-${key.toLowerCase()}="${html(v)}"`)
          .join('')}`
      : '';
  };
  return layout(
    `人工補登・${site.name}`,
    siteHead(site, 'manual'),
    `${form.error ? `<p class="flash" id="manual-error" role="alert" tabindex="-1"><b>尚未儲存。</b>${html(form.error)} 已填內容仍保留，請修正後再按儲存。${(form.errorFields ?? []).map((key) => `<a href="#manual-${html(key)}">前往欄位</a>`).join('　')}</p>` : flash(undefined, form.message)}
<p class="callout manual-status${needed ? ' warn' : ''}"><b>Similarweb 免費資料</b>　${free}${needed ? '。沒有估算的月份可以從 Similarweb 平台抄數字補上。' : '。免費資料有估算的月份仍優先使用免費資料。'}</p>
<link rel="stylesheet" href="${OCR_STYLE}">
<section class="block manual-workspace"><div class="manual-intro"><div><span class="ocr-eyebrow">SIMILARWEB · 人工補登</span><h2>把截圖變成可核對的資料</h2><p class="note">先對照原圖確認數值，再填入表單儲存。</p></div><a class="ocr-platform-link" href="${html(proUrl(site.domain))}" rel="noopener">開啟 Similarweb ↗</a></div>
<details class="manual-instructions"><summary>如何取得截圖與補登？</summary><ol class="steps"><li>用自己的 Similarweb 帳號登入後，打開<a href="${html(proUrl(site.domain))}" rel="noopener">這個網站在平台上的頁面 ↗</a>。</li><li>照下面每個欄位註明的位置抄數字。不需要購買 Pro；依帳號可查看的月份補登，免費帳號通常只看得到最近一個月。</li><li>按「儲存」，排行與網站頁會立刻改用這個數字（Similarweb 免費資料有估算的月份仍以它為準）。</li></ol></details>
<section id="manual-import" class="manual-import" data-domain="${html(site.domain)}" aria-labelledby="manual-import-heading">
<ol class="ocr-steps" aria-label="截圖匯入步驟"><li data-step="select" aria-current="step"><span>1</span> 選擇截圖</li><li data-step="review"><span>2</span> 對照與核對</li><li data-step="save"><span>3</span> 填入後儲存</li></ol>
<div class="ocr-upload-head"><div><h3 id="manual-import-heading">從截圖填入</h3><p class="note">同一網站、同一月份的英文版截圖；網站或外掛皆可。</p></div><span class="ocr-local-badge">本機辨識・圖片不上傳</span></div>
<div class="ocr-upload" data-dropzone><div><p class="ocr-upload-label">加入截圖，也可以拖曳到這裡</p><p class="note">概況、國家、流量來源 · 最多 4 張 · PNG / JPG / WebP · 每張 10 MB</p><label class="ocr-choose" for="manual-screenshots">選擇／加入截圖</label><input class="ocr-file-input" type="file" aria-label="選擇／加入截圖" id="manual-screenshots" accept="image/png,image/jpeg,image/webp" multiple></div><button type="button" class="primary" data-recognize>辨識截圖</button></div>
<div class="ocr-files" data-files></div>
<p class="ocr-progress" role="status" aria-live="polite" data-progress></p><div data-review></div>
<details class="ocr-help"><summary>辨識範圍與資料處理</summary><p class="note">辨識在瀏覽器內完成，沒有 AI token 費用。Desktop Only 渠道填入獨立的桌面限定欄位，Mobile Only 目前不支援。已有內容預設保留；辨識結果需核對並按「儲存」才會生效。</p></details>
<noscript><p>截圖辨識需要啟用 JavaScript，仍可使用下方表單手動補登。</p></noscript>
</section>
<form class="form manual-form" method="post" action="/site/${html(site.domain)}/manual/" data-has-error="${Boolean(form.error)}" data-completed-month="${html(form.completedMonth ?? '')}">
<div class="manual-form-title"><span class="ocr-eyebrow">最後一步</span><h3>補登表單</h3><p class="note">核對區填入的數值會出現在這裡，也可以直接手動輸入。</p></div>
<p id="manual-draft-status" role="status" aria-live="polite" class="note"></p>
<div class="manual-save-bar"><span>核對月份與月造訪量後即可儲存；其他欄位可留空。</span><button type="submit" class="primary">儲存此月份</button></div>
<div class="field-grid manual-basics">
<div class="field"><label for="manual-month">月份</label><select id="manual-month" name="month"${invalid('month')}>${form.choices
      .map(
        (m) =>
          `<option value="${m}"${m === month ? ' selected' : ''}${savedData(m)}>${monthLabel(m)}${byMonth.has(m) ? '（已補登）' : ''}</option>`,
      )
      .join('')}</select><small>平台上方日期選單顯示的月份</small></div>
${field('visits', '月造訪量', 'Traffic &amp; engagement → Total visits', '60.10M', saved ? millions(saved.visits) : '')}
${field('taiwan', '台灣', 'Geography → Taiwan', '61.57', saved ? percentInput(saved.taiwanShare) : '', '%')}
</div>
<h3>全裝置流量來源占比（選填）</h3><div class="field-grid">
${field('search', '自然搜尋', 'Marketing channels → Org. Search', '36.45', saved ? percentInput(saved.searchShare) : '', '%')}
${field('ai', 'Gen AI', 'Marketing channels → Gen AI', '0.37', saved ? percentInput(saved.aiShare) : '', '%')}
${manualChannels.map(([key, label]) => field(key, label, 'Marketing channels → ' + label, '0.00', percentInput(saved?.channels[key] ?? null), '%')).join('')}
</div>
<details class="manual-breakdowns" data-desktop-channels${form.error || Object.entries({ ...detailValues, ...d }).some(([key, v]) => key.startsWith('desktop_') && v) ? ' open' : ''}><summary>桌面限定流量來源（Desktop Only，選填）</summary>
<p class="note">占桌面造訪的比例，與上方全裝置渠道分開保存。沒有桌面造訪量時，只顯示占比，不以全裝置月造訪量換算次數。</p>
<div class="field-grid">${manualDesktopChannels.map(([key, label]) => field(`desktop_${key}`, `桌面限定・${label}`, 'Traffic Sources → Worldwide／Desktop Only', '0.00', detailValues[`desktop_${key}`] ?? '', '%')).join('')}</div>
</details>
<h3>互動與排名（選填）</h3><div class="field-grid">${manualDetailFields.map(([key, label, hint, unit]) => field(key, label, hint, '', detailValues[key], unit)).join('')}</div>
<div class="field"><label for="manual-countries">國家占比</label><textarea id="manual-countries" name="countries"${invalid('countries')} rows="5" placeholder="例如：&#10;TW 61.57&#10;US 12.34">${value('countries', detailValues.countries)}</textarea><small>每行一個兩碼國家代碼與百分比。可填平台列出的所有國家，未列出的國家不推定為 0%。TW 如有填寫須與上方台灣占比一致。</small></div>
<details class="manual-breakdowns"${form.error ? ' open' : ''}><summary>平台詳細分布（選填）</summary>
<p class="note">請確認各表使用相同月份、Worldwide 與 All traffic 範圍。各表的占比分母不同。每行填「名稱 | 占比 | 變化」，變化可省略；名稱未提供時填 ?。保留平台的 &lt;0.01%、&gt;5000%、New，不自行換算。</p>
<div class="field-grid manual-basics">${breakdownTotals.map(([key, label]) => field(key, label, key === 'socialTotal' ? '占全站造訪；不等同自然社群' : '占全站造訪', '<0.01%', detailValues[key] ?? '')).join('')}</div>
<div class="manual-detail-grid">${breakdownFields.map(([key, label, hint]) => `<div class="field"><label for="manual-${key}">${html(label)}</label><textarea id="manual-${key}" name="${key}"${invalid(key)} rows="3" maxlength="20000" placeholder="${html(hint.split('；')[0])}">${value(key, detailValues[key] ?? '')}</textarea><small>${html(hint)}</small></div>`).join('')}</div>
</details>
<div class="form-actions"><button type="submit" class="primary">儲存</button><button type="button" id="manual-discard" class="quiet" hidden>放棄此月份草稿</button><span class="note">造訪量可直接貼平台的寫法（60.10M、950K）；占比不知道可以留空。同一月份再存一次會覆蓋。</span></div>
</form></section>
<section class="block"><h2>已補登的月份</h2>${
      rows
        ? `<div class="scroll"><table data-sortable><thead><tr><th class="l" aria-sort="descending">月份</th><th class="num">月造訪量</th><th class="num">自然搜尋</th><th class="num">Gen AI</th><th class="num">台灣</th>${manualChannels.map(([, label]) => `<th class="num">${html(label)}</th>`).join('')}<th class="l">補登者</th><th data-nosort><span class="sr-only">操作</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="note">還沒有補登的月份。</p>'
    }</section>
${MANUAL_FORM_SCRIPT}<script type="module" src="${OCR_IMPORTER}"></script>`,
    { nav: 'sites' },
  );
}

/** Every tag, most used first. */
export const tagsByUse = (sites: Pick<ManagedSite, 'topics'>[]) => {
  const count = new Map<string, number>();
  for (const s of sites) for (const t of s.topics) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-TW')).map(([t]) => t);
};

export function manageSitesPage(sites: ManagedSite[], message = '', draft?: { domains?: string; add?: string; remove?: string }) {
  const topics = [...new Set(sites.flatMap((s) => s.topics))].sort((a, b) => a.localeCompare(b, 'zh-TW'));
  return layout(
    '網站與標籤管理',
    { title: '網站與標籤管理', dek: '搜尋網站、修改名稱，或一次替多個網站新增與移除標籤。' },
    `${message ? `<p class="flash" role="status">${displayHtml(message)}</p>` : ''}
<form method="post" action="/sites/" id="bulk-edit">
<div class="form bulk-form"><label for="domains">選取網域（每行一個，最多 200 個）</label><textarea id="domains" name="domains" rows="4" required>${displayHtml(draft?.domains ?? '')}</textarea>
${tagInput('add', '要加上的標籤', draft?.add ?? '', '加到每個選取的網站，原有標籤保留。')}${tagInput('remove', '要移除的標籤', draft?.remove ?? '', '從每個選取的網站拿掉，沒有這個標籤的網站不受影響。')}
<p class="note">只加減指定標籤，其他標籤與名稱保持原值。</p>
<div class="row"><span id="selection-count" role="status"></span><button type="submit">套用至選取網站</button></div></div>
<div class="toolbar"><label class="search-field"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input type="search" id="manage-search" aria-label="搜尋名稱或網域" placeholder="搜尋名稱或網域" autocomplete="off"></label><label class="select-field"><span>標籤</span><select id="manage-topic"><option value="">全部標籤</option>${topics.map((t) => `<option>${html(t)}</option>`).join('')}</select></label><button type="button" id="select-visible">選取目前結果（最多 200 個）</button><button type="button" id="clear-selection" class="quiet">清除選取</button></div>
<p class="results-line" id="manage-count" role="status">${sites.length} 個網站</p>
<div class="scroll"><table data-sortable><thead><tr><th data-nosort><span class="sr-only">選取</span></th><th class="l" aria-sort="ascending">網站</th><th class="l">網域</th><th class="l">標籤</th><th class="l" data-nosort>編輯</th></tr></thead><tbody>${sites.map((s) => `<tr data-domain="${html(s.domain)}" data-name="${displayHtml(s.name)}" data-topics="${html(JSON.stringify(s.topics))}"><td><input type="checkbox" class="site-select" aria-label="選取 ${displayHtml(s.domain)}"></td><td class="l" data-v="${displayHtml(s.name)}"><span class="site-identity">${favicon(s.domain, s.name)}<a class="site-name" href="/site/${html(s.domain)}/">${displayHtml(s.name)}</a></span></td><td class="l" data-v="${html(s.domain)}"><span class="site-domain">${displayHtml(s.domain)}</span></td><td class="l" data-v="${html(s.topics.join('、'))}"><span class="tags">${s.topics.map((t) => `<span class="tag">${html(t)}</span>`).join('')}</span></td><td class="l"><a href="/site/${html(s.domain)}/edit/">編輯</a></td></tr>`).join('')}</tbody></table></div>
</form>${options(tagsByUse(sites))}${TAG_SCRIPT}
<script>
(() => {
 const rows = [...document.querySelectorAll('tr[data-domain]')], field = document.getElementById('domains');
 const selection = () => [...new Set(field.value.split(/[\\s,]+/).filter(Boolean).map(d => { try { return new URL('https://' + d).hostname; } catch { return d; } }))];
 const sync = () => { const selected = new Set(selection()); rows.forEach(r => r.querySelector('input').checked = selected.has(r.dataset.domain)); document.getElementById('selection-count').textContent = '已選取 ' + selected.size + ' 個網站'; };
 const search = document.getElementById('manage-search'), topic = document.getElementById('manage-topic');
 const filter = () => { let count = 0; rows.forEach(r => { const out = !window.displayDomainText(r.dataset.name + ' ' + r.dataset.domain).toLowerCase().includes(window.displayDomainText(search.value.trim()).toLowerCase()) || (topic.value && !JSON.parse(r.dataset.topics).includes(topic.value)); r.toggleAttribute('data-out', !!out); if (!out) count++; }); document.getElementById('manage-count').textContent = count + ' 個網站'; rows[0]?.closest('table').dispatchEvent(new Event('traffic:rows')); };
 search.addEventListener('input', filter); topic.addEventListener('change', filter);
 rows.forEach(r => r.querySelector('input').addEventListener('change', e => { const selected = new Set(selection()); if(e.target.checked) selected.add(r.dataset.domain); else selected.delete(r.dataset.domain); field.value = [...selected].map(window.displayDomainText).join('\\n'); sync(); }));
 field.addEventListener('input', sync);
 document.getElementById('select-visible').addEventListener('click', () => { field.value = [...document.querySelectorAll('tr[data-domain]')].filter(r => !r.hasAttribute('data-out')).slice(0, 200).map(r => window.displayDomainText(r.dataset.domain)).join('\\n'); sync(); });
 document.getElementById('clear-selection').addEventListener('click', () => { field.value = ''; sync(); }); sync();
})();
</script>`,
    { nav: 'sites' },
  );
}
