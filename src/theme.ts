/** Runs in the head so a saved theme is applied before the first paint. */
export const THEME_SCRIPT = `<script>
(() => {
  const root = document.documentElement;
  const key = 'traffic-theme';
  try {
    if (localStorage.getItem(key) === 'light') root.dataset.theme = 'light';
  } catch {}
  const sync = () => {
    const light = root.dataset.theme === 'light';
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      button.hidden = false;
      button.textContent = light ? '黑底' : '白底';
      button.setAttribute('aria-label', light ? '切換為黑底' : '切換為白底');
      button.setAttribute('aria-pressed', String(light));
    }
  };
  document.addEventListener('DOMContentLoaded', sync);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-theme-toggle]')) return;
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(key, root.dataset.theme); } catch {}
    sync();
  });
  addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    root.dataset.theme = event.newValue === 'light' ? 'light' : 'dark';
    sync();
  });
})();
</script>`;
