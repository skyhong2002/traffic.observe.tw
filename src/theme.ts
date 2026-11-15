/** Apply the same system preference and explicit override rules as the other observe.tw sites before first paint. */
export const THEME_SCRIPT = `<script>
(() => {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const key = 'theme';
  const sync = () => {
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      button.hidden = false;
      button.setAttribute('aria-pressed', String(root.dataset.theme === 'dark'));
    }
  };
  const apply = () => {
    let saved;
    try { saved = localStorage.getItem(key); } catch {}
    root.dataset.theme = saved === 'light' || saved === 'dark' ? saved : media.matches ? 'dark' : 'light';
    sync();
  };
  apply();
  media.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', sync);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-theme-toggle]')) return;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      if (next === (media.matches ? 'dark' : 'light')) localStorage.removeItem(key);
      else localStorage.setItem(key, next);
    } catch {}
    sync();
  });
  addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) apply();
  });
})();
</script>`;

export const THEME_TOGGLE = `<button type="button" class="theme-toggle" data-theme-toggle aria-label="深色模式" aria-pressed="false" title="切換淺色／深色模式" hidden>
<svg class="theme-moon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>
<svg class="theme-sun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
</button>`;
