import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The one stylesheet every page links (report.html and pages.ts). The link
// carries a content hash, so a changed file is fetched fresh and the old one
// can be cached for long.
export const STYLE = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
export const STYLE_HREF = `/style.css?v=${createHash('sha256').update(STYLE).digest('hex').slice(0, 10)}`;

export const TABLES_SCRIPT = readFileSync(new URL('./tables.js', import.meta.url), 'utf8');
export const TABLES_HREF = `/tables.js?v=${createHash('sha256').update(TABLES_SCRIPT).digest('hex').slice(0, 10)}`;
