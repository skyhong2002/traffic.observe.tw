/* Compact tables: pinned identity, horizontal scroll hints, and a header that
   follows page scrolling, including browsers without scroll-driven CSS.
   Server-rendered tables (data-sortable) sort by their headers the way the
   report's ranking does, show 50 rows until 「瀏覽更多」, and search boxes
   (data-table-filter) leave out the rows that do not match. */
(() => {
  const tables = new Map();
  let frame = 0;
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const resize = new ResizeObserver(schedule);
  function update() {
    frame = 0;
    for (const [table, entry] of tables) {
      if (!table.isConnected) {
        resize.unobserve(table);
        tables.delete(table);
        continue;
      }
      const { scroller, shell, head } = entry;
      const max = scroller.scrollWidth - scroller.clientWidth;
      // Only compact when enough overflow remains after the 152 → 88px shrink.
      // Include the width already removed so the decision stays stable while
      // animating. Otherwise a barely overflowing table alternates sizes and
      // the browser repeatedly clamps scrollLeft back to zero.
      const leadBox = table.querySelector('tbody .table-lead-box');
      const expandedOverflow = max + Math.max(0, 152 - (leadBox?.offsetWidth ?? 152));
      scroller.dataset.compactLead = String(expandedOverflow > 80);
      const position = max <= 1 ? 'none' : scroller.scrollLeft <= 1 ? 'start' : scroller.scrollLeft >= max - 1 ? 'end' : 'middle';
      scroller.dataset.scrollX = shell.dataset.scrollX = position;
      const offset = !table.getClientRects().length
        ? 0
        : Math.max(0, Math.min(-table.getBoundingClientRect().top, table.offsetHeight - head.offsetHeight));
      head.style.setProperty('--head-offset', `${offset}px`);
    }
  }
  /** Pins the identity column of rows not seen yet; the report appends rows as you scroll. */
  function pinRows(table, { lead, hasRank, width }) {
    if (lead < 0) return;
    for (const row of table.rows) {
      // Empty-state cells span the whole table; keep them unpinned.
      if (row.cells.length !== width || row.cells[lead].classList.contains('table-lead')) continue;
      const cell = row.cells[lead];
      cell.classList.add('table-lead');
      if (hasRank) row.cells[0].classList.add('table-rank');
      if (cell.tagName === 'TH') {
        cell.scope = 'col';
      } else {
        const box = document.createElement('span');
        box.className = 'table-lead-box';
        if (!cell.querySelector('[title]')) box.title = cell.textContent.trim();
        box.append(...cell.childNodes);
        cell.append(box);
      }
    }
  }
  function refresh() {
    for (const tags of document.querySelectorAll('td .tags:not([tabindex])')) {
      if (tags.closest('.tech-list')) continue;
      tags.tabIndex = 0;
      tags.setAttribute('role', 'group');
      tags.setAttribute('aria-label', '標籤，可左右捲動');
    }
    for (const table of document.querySelectorAll('.scroll > table')) {
      if (!table.tHead) continue;
      if (tables.has(table)) {
        pinRows(table, tables.get(table).pin);
        continue;
      }
      const scroller = table.parentElement;
      const shell = document.createElement('div');
      shell.className = 'table-frame';
      scroller.before(shell);
      shell.append(scroller);
      scroller.tabIndex = 0;
      scroller.setAttribute('role', 'region');
      scroller.setAttribute('aria-label', `${table.closest('[aria-label]')?.getAttribute('aria-label') || '資料表'}，可左右捲動`);
      table.classList.add('data-table');
      const head = table.tHead;
      head.classList.add('table-head-follow');
      const headers = [...head.rows[0].cells];
      const lead = headers.findIndex((cell) => cell.classList.contains('l'));
      const hasRank = lead === 1 && !!table.tBodies[0]?.rows[0]?.cells[0]?.classList.contains('rank');
      if (hasRank) table.classList.add('with-rank');
      const pin = { lead, hasRank, width: headers.length };
      pinRows(table, pin);
      for (const cell of headers) cell.scope = 'col';
      if (table.hasAttribute('data-sortable')) {
        sortable(table, headers);
        paged(table, shell);
      }
      scroller.addEventListener('scroll', schedule, { passive: true });
      resize.observe(table);
      tables.set(table, { scroller, shell, head, pin });
    }
    schedule();
  }
  const collator = new Intl.Collator('zh-TW', { numeric: true });
  /** A cell's sort value: data-v when the page gives one, else its text; null when empty. */
  function sortValue(cell, numeric) {
    const raw = (cell?.dataset.v ?? cell?.textContent ?? '').trim();
    if (!raw || raw === '—') return null;
    if (!numeric) return raw;
    const n = Number.parseFloat(raw.replace(/[^\d.eE+-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  // A first click sorts numbers high to low (ranks low to high) and text in
  // order; another click reverses. Empty values stay last, ties keep page order.
  function sortable(table, headers) {
    const body = table.tBodies[0];
    const order = new Map([...body.rows].map((row, i) => [row, i]));
    if (body.rows.length < 2 || body.rows[0].cells.length !== headers.length) return;
    const paint = () => {
      for (const th of headers) {
        const arrow = th.querySelector('.arrow');
        if (!arrow) continue;
        const sort = th.getAttribute('aria-sort');
        arrow.textContent = sort === 'ascending' ? '▲' : sort === 'descending' ? '▼' : '↕';
        arrow.classList.toggle('active', sort !== 'none');
      }
    };
    headers.forEach((th, index) => {
      if (th.hasAttribute('data-nosort') || !th.textContent.trim()) return;
      const rank = th.classList.contains('rank');
      const numeric = rank || th.classList.contains('num');
      const button = document.createElement('button');
      button.type = 'button';
      button.append(...th.childNodes);
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.setAttribute('aria-hidden', 'true');
      button.append(arrow);
      th.append(button);
      if (!th.hasAttribute('aria-sort')) th.setAttribute('aria-sort', 'none');
      button.addEventListener('click', () => {
        const was = th.getAttribute('aria-sort');
        const dir = was === 'ascending' ? -1 : was === 'descending' ? 1 : rank || !numeric ? 1 : -1;
        for (const other of headers) if (other.hasAttribute('aria-sort')) other.setAttribute('aria-sort', 'none');
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        const keyed = [...body.rows].map((row) => ({ row, v: sortValue(row.cells[index], numeric) }));
        keyed.sort((a, b) => {
          const tie = order.get(a.row) - order.get(b.row);
          if (a.v === null || b.v === null) return (a.v === null) - (b.v === null) || tie;
          return (numeric ? a.v - b.v : collator.compare(a.v, b.v)) * dir || tie;
        });
        body.append(...keyed.map((k) => k.row));
        paint();
        restart(table);
      });
    });
    paint();
  }
  // Tables start with PAGE rows. 「瀏覽更多」 adds the next PAGE and from then on
  // rows keep coming while scrolling down. Rows a filter leaves out carry
  // data-out; sorting or filtering starts again from the first PAGE rows.
  const PAGE = 50;
  const pages = new Map();
  const nearEnd = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const table = [...pages].find(([, p]) => p.bar === entry.target)?.[0];
        if (entry.isIntersecting && table) grow(table);
      }
    },
    { rootMargin: '0px 0px 600px 0px' },
  );
  function paged(table, shell) {
    const bar = document.createElement('div');
    bar.className = 'table-more';
    bar.innerHTML = '<span role="status"></span><button type="button">瀏覽更多</button>';
    shell.after(bar);
    const p = { limit: PAGE, endless: false, bar };
    pages.set(table, p);
    bar.querySelector('button').addEventListener('click', () => {
      p.endless = true;
      grow(table);
    });
    // Pages with their own filters (/sites/) set data-out and send this event.
    table.addEventListener('traffic:rows', () => restart(table));
    showRows(table);
  }
  /** Shows the first p.limit rows that no filter leaves out; returns how many match. */
  function showRows(table) {
    const p = pages.get(table);
    let matched = 0;
    for (const row of table.tBodies[0].rows) {
      if (row.cells.length === 1) continue;
      const out = row.hasAttribute('data-out');
      row.hidden = out || matched >= p.limit;
      if (!out) matched++;
    }
    const shown = Math.min(p.limit, matched);
    p.bar.hidden = matched <= PAGE;
    p.bar.firstChild.textContent = `已顯示 ${shown.toLocaleString('zh-TW')}／${matched.toLocaleString('zh-TW')} 列`;
    p.bar.lastChild.hidden = p.endless || shown >= matched;
    // Observing again reports at once whether the end is still in view.
    nearEnd.unobserve(p.bar);
    if (p.endless && shown < matched) nearEnd.observe(p.bar);
    schedule();
    return matched;
  }
  function grow(table) {
    pages.get(table).limit += PAGE;
    showRows(table);
  }
  function restart(table) {
    const p = pages.get(table);
    if (!p) return null;
    p.limit = PAGE;
    p.endless = false;
    return showRows(table);
  }
  function filters() {
    for (const input of document.querySelectorAll('[data-table-filter]')) {
      const table = document.getElementById(input.dataset.tableFilter);
      if (!table || input.dataset.ready) continue;
      input.dataset.ready = 'true';
      const count = document.querySelector(`[data-table-count="${table.id}"]`);
      const original = count ? [...count.childNodes] : [];
      // The box sits in a GET form on /table/; Enter must not reload the page.
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) e.preventDefault();
      });
      input.addEventListener('input', () => {
        const query = input.value.trim().toLocaleLowerCase();
        for (const row of table.tBodies[0].rows) {
          if (row.cells.length === 1) continue;
          const text = (row.querySelector('.table-lead') ?? row).textContent.toLocaleLowerCase();
          row.toggleAttribute('data-out', !!query && !text.includes(query));
        }
        const matched = restart(table);
        if (count) {
          if (query) count.textContent = `${matched} 個符合「${input.value.trim()}」・共 ${count.dataset.total} 個`;
          else count.replaceChildren(...original);
        }
      });
    }
  }
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  addEventListener('traffic:tables', refresh);
  document.addEventListener('toggle', schedule, true);
  // 「更多」 shows the rest of a chip row and 「收合」 folds it again; the link under
  // each title opens the method note above the footer.
  const openMethod = () => {
    const note = document.getElementById('method');
    if (note) note.open = true;
  };
  document.addEventListener('click', (e) => {
    const more = e.target.closest?.('[data-chip-more]');
    if (more) {
      const open = more.closest('.chip-row').classList.toggle('open');
      more.textContent = open ? more.dataset.less : more.dataset.more;
    }
    if (e.target.closest?.('a[href="#method"]')) openMethod();
  });
  addEventListener('hashchange', () => {
    if (location.hash === '#method') openMethod();
  });
  if (location.hash === '#method') openMethod();
  // Update only the tag panel after a vote; plain form posts remain the no-JS fallback.
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    const panel = form.closest?.('#tags');
    if (!panel || !(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (panel.getAttribute('aria-busy') === 'true') return;
    const submitter = event.submitter;
    const tag = form.elements.namedItem('tag')?.value;
    const choice = submitter?.dataset.choice;
    const body = new URLSearchParams(new FormData(form));
    if (submitter?.name) body.set(submitter.name, submitter.value);
    panel.setAttribute('aria-busy', 'true');
    const feedback = panel.querySelector('.tag-feedback');
    feedback.setAttribute('role', 'status');
    feedback.textContent = '儲存中…';
    panel.querySelectorAll('button').forEach((button) => {
      button.disabled = true;
    });
    try {
      const response = await fetch(form.action, { method: 'POST', body, credentials: 'same-origin' });
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const updated = page.querySelector('#tags');
      if (!response.ok || !updated) throw Error('無法確認是否儲存，請重新整理查看。');
      const top = panel.getBoundingClientRect().top;
      panel.replaceChildren(...updated.childNodes);
      window.scrollBy(0, panel.getBoundingClientRect().top - top);
      const nextForm = [...panel.querySelectorAll('form')].find((item) => item.elements.namedItem('tag')?.value === tag);
      const next = choice
        ? [...(nextForm?.querySelectorAll('button') || [])].find((button) => button.dataset.choice === choice)
        : panel.querySelector('.tag-propose input');
      next?.focus({ preventScroll: true });
    } catch {
      feedback.setAttribute('role', 'alert');
      feedback.textContent = '無法確認是否儲存，請重新整理查看。';
    } finally {
      panel.removeAttribute('aria-busy');
      panel.querySelectorAll('button').forEach((button) => {
        button.disabled = false;
      });
    }
  });
  refresh();
  filters();
})();

// The technology catalog is a compact link grid, independent of site tables.
(() => {
  const catalog = document.getElementById('tech-catalog');
  const input = document.querySelector('[data-tech-search]');
  if (!catalog || !input) return;
  const items = [...catalog.children];
  const count = document.querySelector('[data-table-count="tech-catalog"]');
  const empty = document.querySelector('[data-tech-empty]');
  input.addEventListener('input', () => {
    const query = input.value.trim().toLocaleLowerCase();
    let matched = 0;
    for (const item of items) {
      item.hidden = !item.dataset.techName.toLocaleLowerCase().includes(query);
      if (!item.hidden) matched++;
    }
    count.textContent = query
      ? `${matched} 項符合「${input.value.trim()}」・共 ${items.length} 項`
      : `${items.length} 項技術 · 網站數 / 比例`;
    empty.hidden = matched !== 0;
  });
  document.querySelector('[data-tech-sort]').addEventListener('change', (event) => {
    const byName = event.target.value === 'name';
    items.sort((a, b) =>
      byName ? a.dataset.techName.localeCompare(b.dataset.techName) : Number(b.dataset.techCount) - Number(a.dataset.techCount),
    );
    catalog.append(...items);
    catalog.setAttribute('aria-label', byName ? '技術，依名稱排序' : '技術，依網站數排序');
  });
})();
