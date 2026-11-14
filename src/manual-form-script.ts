/** Per-tab drafts survive validation errors, month changes, reloads and sign-in redirects. */
export const MANUAL_FORM_SCRIPT = `<script>
(() => {
  const form = document.querySelector('.manual-form');
  const month = form.elements.namedItem('month');
  const fields = [...form.querySelectorAll('input[name], textarea[name]')];
  const status = document.getElementById('manual-draft-status');
  const discard = document.getElementById('manual-discard');
  const prefix = 'manual-draft:' + form.getAttribute('action') + ':';
  const drafts = new Map();
  let active = month.value, submitting = false, storageOK = true, reviewPending = false;
  const read = (key) => {
    if (drafts.has(key)) return drafts.get(key);
    try { return JSON.parse(sessionStorage.getItem(prefix + key)); }
    catch { storageOK = false; return null; }
  };
  const write = (key, value) => {
    drafts.set(key, value);
    try {
      if (value === null) sessionStorage.removeItem(prefix + key);
      else sessionStorage.setItem(prefix + key, JSON.stringify(value));
    } catch { storageOK = false; }
  };
  const option = () => [...month.options].find((o) => o.value === active);
  const dirty = () => fields.some((f) => f.value !== (option()?.dataset[f.name.toLowerCase()] ?? ''));
  const notify = (restored = false) => {
    const changed = dirty();
    status.textContent = reviewPending ? '截圖核對尚未填入；請先核對並填入，再儲存。' + (changed ? ' 表單另有未儲存的草稿。' : '') : changed
      ? (restored ? '已還原此月份的草稿。' : '') + (storageOK ? '尚未儲存；草稿暫存在此分頁，按「儲存」成功後才會生效。' : '尚未儲存；瀏覽器無法暫存草稿，請先完成儲存再離開。')
      : '目前沒有尚未儲存的變更。';
    discard.hidden = !changed;
  };
  const remember = () => {
    write(active, dirty() ? Object.fromEntries(fields.map((f) => [f.name, f.value])) : null);
    write('selected', active);
    notify();
  };
  const fill = (draft) => {
    for (const field of fields) field.value = draft && typeof draft[field.name] === 'string'
      ? draft[field.name] : (option()?.dataset[field.name.toLowerCase()] ?? '');
    notify(Boolean(draft));
    form.dispatchEvent(new Event('manual:values-changed'));
  };
  form.addEventListener('manual:read-month', (event) => {
    const selected = event.detail.month;
    const saved = [...month.options].find((o) => o.value === selected);
    if (!saved) return;
    const draft = selected === active ? Object.fromEntries(fields.map((f) => [f.name, f.value])) : read(selected);
    event.detail.values = Object.fromEntries(fields.map((f) => [f.name,
      draft && typeof draft[f.name] === 'string' ? draft[f.name] : (saved.dataset[f.name.toLowerCase()] ?? '')]));
  });
  if (form.dataset.completedMonth) {
    write(form.dataset.completedMonth, null);
    // Refreshing after another edit must not replay the success and erase its new draft.
    const url = new URL(window.location.href);
    url.searchParams.delete('done');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  if (form.dataset.hasError === 'true') {
    remember();
    document.getElementById('manual-error')?.focus();
  } else {
    const selected = form.dataset.completedMonth || read('selected');
    if ([...month.options].some((o) => o.value === selected)) month.value = selected;
    active = month.value;
    fill(read(active));
  }
  form.addEventListener('manual:review-state', (event) => { reviewPending = event.detail.pending; notify(); });
  form.addEventListener('input', remember);
  form.addEventListener('change', (event) => {
    if (event.target !== month) { remember(); return; }
    remember();
    active = month.value;
    for (const field of form.querySelectorAll('[aria-invalid]')) field.removeAttribute('aria-invalid');
    fill(read(active));
    write('selected', active);
  });
  discard.addEventListener('click', () => {
    if (!confirm('放棄這個月份尚未儲存的草稿？')) return;
    write(active, null);
    fill(null);
  });
  form.addEventListener('submit', () => { remember(); submitting = true; });
  window.addEventListener('pageshow', () => { submitting = false; });
  window.addEventListener('beforeunload', (event) => {
    if (!submitting && dirty()) { event.preventDefault(); event.returnValue = ''; }
  });
})();
</script>`;
