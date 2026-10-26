import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { domainToUnicode } from 'node:url';

/** Decode IDN labels in display text only; callers still escape the result as HTML. */
export function displayDomainText(value: unknown): string {
  return String(value ?? '').replace(/\bxn--[a-z0-9-]+\b/gi, (label) => domainToUnicode(label) || label);
}

// Use the same established Punycode codec in the browser. Keep it private to this script.
const require = createRequire(import.meta.url);
const codec = readFileSync(require.resolve('punycode/'), 'utf8');
export const DOMAIN_DISPLAY_SCRIPT = `<script>(() => {
const module = { exports: {} };
${codec}
window.displayDomainText = (value) => String(value ?? '').replace(/\\bxn--[a-z0-9-]+\\b/gi, (label) => {
  try {
    const decoded = module.exports.toUnicode(label.toLowerCase());
    return new URL('https://' + decoded).hostname === label.toLowerCase() ? decoded : label;
  } catch { return label; }
});
})();</script>`;
