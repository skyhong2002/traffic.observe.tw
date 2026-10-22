/* Compact tables: pinned identity, horizontal scroll hints, and a header that
   follows page scrolling, including browsers without scroll-driven CSS. */
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
      // Drawers have their own scroll position; leave their short headers in place.
      const offset =
        table.closest('.panel') || !table.getClientRects().length
          ? 0
          : Math.max(0, Math.min(-table.getBoundingClientRect().top, table.offsetHeight - head.offsetHeight));
      head.style.setProperty('--head-offset', `${offset}px`);
    }
  }
  function refresh() {
    for (const table of document.querySelectorAll('.scroll > table')) {
      if (tables.has(table) || !table.tHead) continue;
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
      if (lead >= 0) {
        const hasRank = lead === 1 && table.tBodies[0]?.rows[0]?.cells[0]?.classList.contains('rank');
        if (hasRank) table.classList.add('with-rank');
        for (const row of table.rows) {
          // Empty-state cells span the whole table; keep them unpinned.
          if (row.cells.length !== headers.length) continue;
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
      for (const cell of headers) cell.scope = 'col';
      scroller.addEventListener('scroll', schedule, { passive: true });
      resize.observe(table);
      tables.set(table, { scroller, shell, head });
    }
    schedule();
  }
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  addEventListener('traffic:tables', refresh);
  document.addEventListener('toggle', schedule, true);
  refresh();
})();
