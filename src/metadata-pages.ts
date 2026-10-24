import { type ManualMonth, proUrl } from './manual.ts';
import type { ManagedSite } from './metadata.ts';
import { favicon, html, layout, siteTabs, vol, volText } from './pages.ts';

export interface ManualForm {
  months: ManualMonth[];
  /** Months that can be entered, newest first. */
  choices: string[];
  /** What the free endpoint last answered for the domain, oldest first; estimated is false when it said 0. */
  free: Array<{ month: string; estimated: boolean }>;
  message?: string;
  error?: string;
  draft?: { month?: string; visits?: string; search?: string; ai?: string; taiwan?: string };
}

const monthLabel = (m: string) => `${m.slice(0, 4)}/${m.slice(4)}`;
const percent = (n: number | null, digits: number) => (n === null ? '—' : `${(n * 100).toFixed(digits)}%`);
/** Visits (a count) as the platform writes them, which the form reads back. */
const millions = (n: number) => volText(n / 1e6);
/** How a share is written back into the form: 0.3645 → "36.45". */
const percentInput = (n: number | null) => (n === null ? '' : String(Math.round(n * 1e4) / 100));
const flash = (error?: string, message?: string) =>
  error ? `<p class="flash" role="alert">${html(error)}</p>` : message ? `<p class="flash" role="status">${html(message)}</p>` : '';
/** The site's own head on every page of it, with the sub-pages as tabs. */
const siteHead = (site: Pick<ManagedSite, 'domain' | 'name'>, tab: 'edit' | 'manual', actions = '') => ({
  title: site.name,
  dek: `${favicon(site.domain, site.name)}<a href="https://${html(site.domain)}/" rel="noopener">${html(site.domain)} ↗</a>`,
  tabs: siteTabs(site.domain, tab),
  actions,
});

/** Known tags, most used first; the tag editor offers them in this order. */
const options = (topics: string[]) =>
  `<datalist id="tag-suggestions">${[...new Set(topics)].map((t) => `<option value="${html(t)}"></option>`).join('')}</datalist>`;
/** Without JavaScript this is a comma-separated text box; TAG_SCRIPT turns it into chips and a search. */
const tagInput = (name: string, title: string, value: string, hint: string) =>
  `<div class="field tag-editor" data-tag-editor><label for="tags-${name}">${title}</label><textarea id="tags-${name}" name="${name}" rows="2" maxlength="8000">${html(value)}</textarea><small>${hint}</small></div>`;

// The selected tags as chips with a remove button, then one search box: typing
// lists matching tags (and offers to create the typed name), Enter or a click
// adds, Backspace on an empty box removes the last tag. The most used tags not
// yet selected are one click away below.
const TAG_SCRIPT = `<script>
(() => {
  const split = (v) => [...new Set(v.split(/[,，、;；\\n]+/).map((t) => t.trim()).filter(Boolean))];
  const known = [...document.querySelectorAll('#tag-suggestions option')].map((o) => o.value);
  const make = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
  document.querySelectorAll('[data-tag-editor]').forEach((host, n) => {
    const textarea = host.querySelector('textarea');
    const name = host.querySelector('label').textContent;
    const initial = split(textarea.value);
    let tags = [...initial];
    let options = [];
    let active = -1;
    const picked = make('div', 'tag-picked'); picked.setAttribute('role', 'list'); picked.setAttribute('aria-label', '已選' + name);
    const field = make('div', 'tag-field');
    const input = make('input'); input.type = 'text'; input.maxLength = 64; input.autocomplete = 'off';
    input.placeholder = '輸入標籤名稱，按 Enter 加入';
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-label', '加入' + name);
    input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
    const list = make('ul', 'tag-suggest'); list.id = 'tag-suggest-' + n; list.setAttribute('role', 'listbox'); list.hidden = true;
    input.setAttribute('aria-controls', list.id);
    field.append(input, list);
    const quick = make('div', 'tag-quick');
    const foot = make('div', 'tag-foot');
    const status = make('span', 'note'); status.setAttribute('role', 'status');
    const reset = make('button', 'quiet', '還原'); reset.type = 'button';
    foot.append(status, reset);
    const add = (value) => { for (const t of split(value)) if (!tags.includes(t)) tags.push(t); input.value = ''; render(); input.focus(); };
    const remove = (tag) => { tags = tags.filter((t) => t !== tag); render(); };
    const suggest = () => {
      const query = input.value.trim();
      const q = query.toLocaleLowerCase();
      options = !query ? [] : [...new Set([...known, ...tags])].filter((t) => !tags.includes(t) && t.toLocaleLowerCase().includes(q)).slice(0, 8).map((t) => ({ tag: t, label: t }));
      if (query && !known.includes(query) && !tags.includes(query)) options.push({ tag: query, label: '新增標籤「' + query + '」' });
      active = options.length ? 0 : -1;
      list.replaceChildren(...options.map((o, i) => {
        const li = make('li', null, o.label); li.id = list.id + '-' + i; li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        li.addEventListener('mousedown', (e) => { e.preventDefault(); add(o.tag); });
        return li;
      }));
      list.hidden = !options.length;
      input.setAttribute('aria-expanded', String(!list.hidden));
      if (active >= 0) input.setAttribute('aria-activedescendant', list.id + '-' + active); else input.removeAttribute('aria-activedescendant');
    };
    const move = (step) => {
      if (!options.length) return;
      active = (active + step + options.length) % options.length;
      [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
      input.setAttribute('aria-activedescendant', list.id + '-' + active);
    };
    const render = () => {
      textarea.value = tags.join(', ');
      picked.replaceChildren(...(tags.length ? tags.map((tag) => {
        const chip = make('span', 'chip'); chip.setAttribute('role', 'listitem');
        const x = make('button', null, '×'); x.type = 'button'; x.setAttribute('aria-label', '移除 ' + tag);
        x.addEventListener('click', () => { remove(tag); input.focus(); });
        chip.append(make('span', null, tag), x);
        return chip;
      }) : [make('span', 'muted', '還沒有標籤')]));
      const top = known.filter((t) => !tags.includes(t)).slice(0, 12);
      quick.replaceChildren(...(top.length ? [make('span', 'muted', '常用'), ...top.map((t) => {
        const b = make('button', null, '+ ' + t); b.type = 'button'; b.addEventListener('click', () => add(t)); return b;
      })] : []));
      const dirty = tags.length !== initial.length || tags.some((t, i) => t !== initial[i]);
      status.textContent = '已選 ' + tags.length + ' 個' + (dirty ? '・尚未儲存' : '');
      reset.disabled = !dirty;
      suggest();
    };
    input.addEventListener('input', suggest);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (options[active]) add(options[active].tag); else if (input.value.trim()) add(input.value); }
      else if (e.key === 'Escape') { input.value = ''; suggest(); }
      else if (e.key === 'Backspace' && !input.value && tags.length) remove(tags.at(-1));
    });
    input.addEventListener('blur', () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); });
    input.addEventListener('focus', suggest);
    reset.addEventListener('click', () => { tags = [...initial]; input.value = ''; render(); });
    textarea.hidden = true;
    host.querySelector('label').htmlFor = '';
    host.querySelector('label').addEventListener('click', () => input.focus());
    textarea.after(picked, field, quick, foot);
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
<div class="field"><label for="site-name">網站名稱</label><input id="site-name" name="name" maxlength="128" value="${html(draft?.name ?? site.name)}"><small>留空會沿用試算表的名稱。網域不能改，歷史流量都跟著網域走。</small></div>
${tagInput('topics', '標籤', draft?.topics ?? site.baseTopics.join(', '), '地區、主題、網站類型都用標籤表示，可以複選，也可以新增。這裡是編輯清單；讀者新增、AI 初判與單一標籤的覆寫在網站頁的「標籤」區塊。')}
<div class="form-actions"><button type="submit" class="primary">儲存</button><span class="note">重新匯入試算表不會覆蓋這裡的設定。</span></div>
</form>${options(suggestions)}${TAG_SCRIPT}`,
    { nav: 'sites' },
  );
}

/** Copying months from Similarweb's platform for a domain its free data does not estimate. */
export function manualPage(site: Pick<ManagedSite, 'domain' | 'name'>, form: ManualForm) {
  const d = form.draft ?? {};
  const byMonth = new Map(form.months.map((m) => [m.month, m]));
  const month = d.month && form.choices.includes(d.month) ? d.month : form.choices[0];
  // A month already entered starts filled in, so correcting it is just editing the numbers.
  const saved = byMonth.get(month);
  const value = (key: keyof NonNullable<ManualForm['draft']>, fromSaved: string) => html(form.draft ? (d[key] ?? '') : fromSaved);
  const field = (
    key: 'visits' | 'search' | 'ai' | 'taiwan',
    label: string,
    where: string,
    placeholder: string,
    fromSaved: string,
    unit = '',
  ) =>
    `<div class="field"><label for="manual-${key}">${label}</label><span class="input-unit"><input id="manual-${key}" name="${key}" value="${value(key, fromSaved)}" placeholder="${placeholder}" inputmode="decimal" autocomplete="off"${key === 'visits' ? ' required' : ''}>${unit ? `<span>${unit}</span>` : ''}</span><small>${where}</small></div>`;
  const free = form.free.length
    ? form.free.map((f) => `${monthLabel(f.month)} ${f.estimated ? '有估算' : '<b>無估算</b>'}`).join('・')
    : '還沒有向 Similarweb 抓過。';
  const needed = form.free.some((f) => !f.estimated);
  const rows = [...form.months]
    .reverse()
    .map(
      (m) =>
        `<tr><td class="l" data-v="${m.month}">${monthLabel(m.month)}</td><td class="num" data-v="${m.visits}">${vol(m.visits / 1e6)}</td><td class="num">${percent(m.searchShare, 2)}</td><td class="num">${percent(m.aiShare, 2)}</td><td class="num">${percent(m.taiwanShare, 2)}</td><td class="l"><span class="site-identity"><span>${html(m.updatedBy)}</span><span class="site-domain">${html(new Date(m.updatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, dateStyle: 'short', timeStyle: 'short' }))}</span></span></td><td><form class="inline" method="post" action="/site/${html(site.domain)}/manual/" onsubmit="return confirm('刪除 ${monthLabel(m.month)} 的補登數字？')"><input type="hidden" name="month" value="${m.month}"><input type="hidden" name="action" value="delete"><button type="submit" class="quiet">刪除</button></form></td></tr>`,
    )
    .join('');
  const savedData = (m: string) => {
    const r = byMonth.get(m);
    return r
      ? ` data-visits="${millions(r.visits)}" data-search="${percentInput(r.searchShare)}" data-ai="${percentInput(r.aiShare)}" data-taiwan="${percentInput(r.taiwanShare)}"`
      : '';
  };
  return layout(
    `Pro 補登・${site.name}`,
    siteHead(site, 'manual'),
    `${flash(form.error, form.message)}
<p class="callout${needed ? ' warn' : ''}"><b>Similarweb 免費資料</b>　${free}${needed ? '。沒有估算的月份可以從 Similarweb 平台抄數字補上。' : '。都有估算時不需要補登。'}</p>
<section class="block"><h2>補登一個月份</h2>
<ol class="steps"><li>用 Similarweb 帳號登入後，打開<a href="${html(proUrl(site.domain))}" rel="noopener">這個網站在平台上的頁面 ↗</a>。</li><li>照下面每個欄位註明的位置抄數字。免費帳號只看得到最近一個月，請每月補一次。</li><li>按「儲存」，排行與網站頁會立刻改用這個數字（Similarweb 免費資料有估算的月份仍以它為準）。</li></ol>
<form class="form manual-form" method="post" action="/site/${html(site.domain)}/manual/">
<div class="field-grid">
<div class="field"><label for="manual-month">月份</label><select id="manual-month" name="month">${form.choices
      .map(
        (m) =>
          `<option value="${m}"${m === month ? ' selected' : ''}${savedData(m)}>${monthLabel(m)}${byMonth.has(m) ? '（已補登）' : ''}</option>`,
      )
      .join('')}</select><small>平台上方日期選單顯示的月份</small></div>
${field('visits', '月造訪量', 'Traffic &amp; engagement → Total visits', '60.10M', saved ? millions(saved.visits) : '')}
${field('search', '自然搜尋', 'Marketing channels → Org. Search', '36.45', saved ? percentInput(saved.searchShare) : '', '%')}
${field('ai', 'Gen AI', 'Marketing channels → Gen AI', '0.37', saved ? percentInput(saved.aiShare) : '', '%')}
${field('taiwan', '台灣', 'Geography → Taiwan', '61.57', saved ? percentInput(saved.taiwanShare) : '', '%')}
</div>
<div class="form-actions"><button type="submit" class="primary">儲存</button><span class="note">造訪量可直接貼平台的寫法（60.10M、950K）；占比不知道可以留空。同一月份再存一次會覆蓋。</span></div>
</form></section>
<section class="block"><h2>已補登的月份</h2>${
      rows
        ? `<div class="scroll"><table data-sortable><thead><tr><th class="l" aria-sort="descending">月份</th><th class="num">月造訪量</th><th class="num">自然搜尋</th><th class="num">Gen AI</th><th class="num">台灣</th><th class="l">補登者</th><th data-nosort><span class="sr-only">操作</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="note">還沒有補登的月份。</p>'
    }</section>
<script>
(() => {
  // Choosing a month already entered fills in its numbers; a new month starts empty.
  const month = document.getElementById('manual-month');
  month.addEventListener('change', () => {
    const o = month.selectedOptions[0];
    for (const key of ['visits', 'search', 'ai', 'taiwan']) document.getElementById('manual-' + key).value = o.dataset[key] ?? '';
  });
})();
</script>`,
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
    `${message ? `<p class="flash" role="status">${html(message)}</p>` : ''}
<form method="post" action="/sites/" id="bulk-edit">
<div class="form bulk-form"><label for="domains">選取網域（每行一個，最多 200 個）</label><textarea id="domains" name="domains" rows="4" required>${html(draft?.domains ?? '')}</textarea>
${tagInput('add', '要加上的標籤', draft?.add ?? '', '加到每個選取的網站，原有標籤保留。')}${tagInput('remove', '要移除的標籤', draft?.remove ?? '', '從每個選取的網站拿掉，沒有這個標籤的網站不受影響。')}
<p class="note">只加減指定標籤，其他標籤與名稱保持原值。</p>
<div class="row"><span id="selection-count" role="status"></span><button type="submit">套用至選取網站</button></div></div>
<div class="toolbar"><label class="search-field"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input type="search" id="manage-search" aria-label="搜尋名稱或網域" placeholder="搜尋名稱或網域" autocomplete="off"></label><label class="select-field"><span>標籤</span><select id="manage-topic"><option value="">全部標籤</option>${topics.map((t) => `<option>${html(t)}</option>`).join('')}</select></label><button type="button" id="select-visible">選取目前結果（最多 200 個）</button><button type="button" id="clear-selection" class="quiet">清除選取</button></div>
<p class="results-line" id="manage-count" role="status">${sites.length} 個網站</p>
<div class="scroll"><table data-sortable><thead><tr><th data-nosort><span class="sr-only">選取</span></th><th class="l" aria-sort="ascending">網站</th><th class="l">標籤</th><th class="l" data-nosort>編輯</th></tr></thead><tbody>${sites.map((s) => `<tr data-domain="${html(s.domain)}" data-name="${html(s.name)}" data-topics="${html(JSON.stringify(s.topics))}"><td><input type="checkbox" class="site-select" aria-label="選取 ${html(s.domain)}"></td><td class="l" data-v="${html(s.name)}"><span class="site-identity">${favicon(s.domain, s.name)}<a class="site-name" href="/site/${html(s.domain)}/">${html(s.name)}</a>${s.name === s.domain ? '' : `<span class="site-domain table-lead-extra">${html(s.domain)}</span>`}</span></td><td class="l" data-v="${html(s.topics.join('、'))}"><span class="tags">${s.topics.map((t) => `<span class="tag">${html(t)}</span>`).join('')}</span></td><td class="l"><a href="/site/${html(s.domain)}/edit/">編輯</a></td></tr>`).join('')}</tbody></table></div>
</form>${options(tagsByUse(sites))}${TAG_SCRIPT}
<script>
(() => {
 const rows = [...document.querySelectorAll('tr[data-domain]')], field = document.getElementById('domains');
 const selection = () => [...new Set(field.value.split(/[\\s,]+/).filter(Boolean))];
 const sync = () => { const selected = new Set(selection()); rows.forEach(r => r.querySelector('input').checked = selected.has(r.dataset.domain)); document.getElementById('selection-count').textContent = '已選取 ' + selected.size + ' 個網站'; };
 const search = document.getElementById('manage-search'), topic = document.getElementById('manage-topic');
 const filter = () => { let count = 0; rows.forEach(r => { const out = !(r.dataset.name + ' ' + r.dataset.domain).toLowerCase().includes(search.value.trim().toLowerCase()) || (topic.value && !JSON.parse(r.dataset.topics).includes(topic.value)); r.toggleAttribute('data-out', !!out); if (!out) count++; }); document.getElementById('manage-count').textContent = count + ' 個網站'; rows[0]?.closest('table').dispatchEvent(new Event('traffic:rows')); };
 search.addEventListener('input', filter); topic.addEventListener('change', filter);
 rows.forEach(r => r.querySelector('input').addEventListener('change', e => { const selected = new Set(selection()); if(e.target.checked) selected.add(r.dataset.domain); else selected.delete(r.dataset.domain); field.value = [...selected].join('\\n'); sync(); }));
 field.addEventListener('input', sync);
 document.getElementById('select-visible').addEventListener('click', () => { field.value = [...document.querySelectorAll('tr[data-domain]')].filter(r => !r.hasAttribute('data-out')).slice(0, 200).map(r => r.dataset.domain).join('\\n'); sync(); });
 document.getElementById('clear-selection').addEventListener('click', () => { field.value = ''; sync(); }); sync();
})();
</script>`,
    { nav: 'sites' },
  );
}
