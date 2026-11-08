import { runInNewContext } from 'node:vm';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { MANUAL_FORM_SCRIPT } from '../src/manual-form-script.ts';
import { type ManualForm, manualPage } from '../src/metadata-pages.ts';

const prefix = 'manual-draft:/site/tw.news.yahoo.com/manual/:';
const site = { domain: 'tw.news.yahoo.com', name: 'Yahoo 新聞' };
const base: ManualForm = { months: [], choices: ['202610', '202609'], free: [] };
type Listener = (event: Record<string, unknown>) => void;

// Run the actual inline script against controls parsed from the rendered form.
function open(storage = new Map<string, string>(), overrides: Partial<ManualForm> = {}, blocked = false) {
  const $ = load(manualPage(site, { ...base, ...overrides }));
  const listeners = new Map<string, Listener>();
  const windowListeners = new Map<string, Listener>();
  const fields = $('.manual-form input[name], .manual-form textarea[name]')
    .toArray()
    .map((el) => ({
      name: $(el).attr('name') as string,
      value: String($(el).val() ?? ''),
      removeAttribute: () => {},
    }));
  const month = {
    value: String($('#manual-month').val()),
    options: $('#manual-month option')
      .toArray()
      .map((el) => ({ value: $(el).attr('value'), dataset: $(el).data() })),
  };
  const status = { textContent: '' };
  const discard = { hidden: true, addEventListener: (_event: string, fn: Listener) => listeners.set('discard', fn) };
  let focusedError = false;
  let url = 'https://site.observe.tw/site/tw.news.yahoo.com/manual/?done=saved&month=202610';
  const form = {
    elements: { namedItem: () => month },
    dataset: {
      hasError: $('.manual-form').attr('data-has-error'),
      completedMonth: $('.manual-form').attr('data-completed-month'),
    },
    getAttribute: () => $('.manual-form').attr('action'),
    querySelectorAll: () => fields,
    addEventListener: (event: string, fn: Listener) => listeners.set(event, fn),
  };
  runInNewContext(MANUAL_FORM_SCRIPT.replace(/^<script>\n|\n<\/script>$/g, ''), {
    document: {
      querySelector: () => form,
      getElementById: (id: string) =>
        id === 'manual-draft-status'
          ? status
          : id === 'manual-discard'
            ? discard
            : {
                focus: () => {
                  focusedError = true;
                },
              },
    },
    sessionStorage: {
      getItem: (key: string) => {
        if (blocked) throw Error('blocked');
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (blocked) throw Error('blocked');
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        if (blocked) throw Error('blocked');
        storage.delete(key);
      },
    },
    URL,
    window: {
      location: { href: url },
      history: {
        replaceState: (_state: unknown, _unused: string, value: string) => {
          url = value;
        },
      },
      addEventListener: (event: string, fn: Listener) => windowListeners.set(event, fn),
    },
    confirm: () => true,
  });
  return {
    storage,
    status,
    fields,
    month,
    discard,
    focusedError: () => focusedError,
    url: () => url,
    value: (key: string) => fields.find((f) => f.name === key)?.value,
    input: (key: string, value: string) => {
      const field = fields.find((f) => f.name === key);
      if (!field) throw Error(key);
      field.value = value;
      listeners.get('input')?.({ target: field });
    },
    switchMonth: (value: string) => {
      month.value = value;
      listeners.get('change')?.({ target: month });
    },
    discardDraft: () => listeners.get('discard')?.({}),
    submit: () => listeners.get('submit')?.({}),
    warnBeforeLeaving: () => {
      let prevented = false;
      windowListeners.get('beforeunload')?.({
        preventDefault: () => {
          prevented = true;
        },
      });
      return prevented;
    },
  };
}

describe('manual entry drafts', () => {
  it('preserves every field independently per month, across switching and reloads', () => {
    const page = open();
    page.fields.forEach((f, i) => {
      page.input(f.name, `draft ${i}`);
    });
    const october = Object.fromEntries(page.fields.map((f) => [f.name, f.value]));
    page.switchMonth('202609');
    expect(page.value('visits')).toBe('');
    page.input('visits', '60.10M');
    page.switchMonth('202610');
    expect(Object.fromEntries(page.fields.map((f) => [f.name, f.value]))).toEqual(october);
    const reloaded = open(page.storage);
    expect(Object.fromEntries(reloaded.fields.map((f) => [f.name, f.value]))).toEqual(october);
    expect(reloaded.status.textContent).toContain('已還原');
    expect(reloaded.warnBeforeLeaving()).toBe(true);
    reloaded.switchMonth('202609');
    expect(reloaded.value('visits')).toBe('60.10M');
  });

  it('keeps a rejected submission instead of replacing it with an older browser draft', () => {
    const page = open();
    page.input('visits', 'old draft');
    const rejected = open(page.storage, {
      error: '平均停留時間不正確',
      errorFields: ['duration'],
      draft: { month: '202610', visits: '57M', duration: '2:60' },
    });
    expect(rejected.value('visits')).toBe('57M');
    expect(rejected.value('duration')).toBe('2:60');
    expect(rejected.focusedError()).toBe(true);
    expect(open(page.storage).value('duration')).toBe('2:60');
  });

  it('clears only the completed month after success and preserves the other draft', () => {
    const page = open();
    page.input('visits', '57M');
    page.switchMonth('202609');
    page.input('visits', '60.10M');
    page.switchMonth('202610');
    page.submit();
    expect(page.warnBeforeLeaving()).toBe(false);
    const saved = open(page.storage, { message: '已儲存。', selectedMonth: '202610', completedMonth: '202610' });
    expect(page.storage.has(prefix + '202610')).toBe(false);
    expect(saved.url()).not.toContain('done=');
    saved.input('visits', '58M');
    expect(open(page.storage, { selectedMonth: '202610' }).value('visits')).toBe('58M');
    saved.switchMonth('202609');
    expect(saved.value('visits')).toBe('60.10M');
    saved.discardDraft();
    expect(page.storage.has(prefix + '202609')).toBe(false);
    expect(saved.warnBeforeLeaving()).toBe(false);
  });

  it('continues editing and warns on leaving if browser storage is blocked', () => {
    const page = open(new Map(), {}, true);
    page.input('visits', '57M');
    expect(page.status.textContent).toContain('無法暫存草稿');
    expect(page.warnBeforeLeaving()).toBe(true);
    page.switchMonth('202609');
    page.switchMonth('202610');
    expect(page.value('visits')).toBe('57M');
  });
});
