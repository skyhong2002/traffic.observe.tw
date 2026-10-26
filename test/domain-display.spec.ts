import { domainToASCII } from 'node:url';
import { runInNewContext } from 'node:vm';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { DOMAIN_DISPLAY_SCRIPT, displayDomainText } from '../src/domain-display.ts';
import { displayHtml, layout, siteCell } from '../src/pages.ts';
import { techDomainPage } from '../src/tech-pages.ts';

const unicode = '中文網域.tw';
const ascii = domainToASCII(unicode);

describe('international domain display', () => {
  it('decodes Chinese labels, subdomains and URL labels without changing ordinary text', () => {
    expect(displayDomainText(`網站 https://blog.${ascii}/path?q=1`)).toBe(`網站 https://blog.${unicode}/path?q=1`);
    expect(displayDomainText(domainToASCII('測試.台灣'))).toBe('測試.台灣');
    expect(displayDomainText('example.tw / 中文網域.tw')).toBe('example.tw / 中文網域.tw');
    expect(displayDomainText('xn--a.tw')).toBe('xn--a.tw');
    expect(displayHtml(`${ascii}<img src=x>`)).toBe(`${unicode}&lt;img src=x&gt;`);
  });
  it('keeps canonical links and identity attributes while rendering Chinese labels and titles', () => {
    const $ = load(`<table><tbody><tr>${siteCell(ascii, ascii)}</tr></tbody></table>`);
    expect($('.site-name').text()).toBe(unicode);
    expect($('.site-name').attr('href')).toBe(`/site/${ascii}/`);
    expect($('.favicon').attr('data-card')).toBe(ascii);
    expect($('.favicon').attr('data-letter')).toBe('中');
    const detail = load(techDomainPage(ascii, null, null, false, { loginEnabled: false, signedIn: false }));
    expect(detail('h1').text()).toBe(unicode);
    expect(detail('title').text()).toContain(unicode);
    expect(detail('.dek a').first().attr('href')).toBe(`https://${ascii}/`);
    expect(detail('.dek a').first().text()).toContain(unicode);
    expect(load(layout(ascii, { title: ascii }, ''))('h1').text()).toBe(unicode);
  });
  it('uses matching browser conversion for live tables, search and hover cards', () => {
    const window: { displayDomainText?: (s: string) => string } = {};
    runInNewContext(DOMAIN_DISPLAY_SCRIPT.replace(/^<script>|<\/script>$/g, ''), { window, URL });
    for (const s of [ascii, `www.${ascii}`, domainToASCII('測試.台灣'), ascii.toUpperCase(), '普通名稱', 'example.tw', 'xn--a.tw']) {
      expect(window.displayDomainText?.(s)).toBe(displayDomainText(s));
    }
  });
});
