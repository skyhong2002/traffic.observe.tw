import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const report = readFileSync(new URL('../src/report.html', import.meta.url), 'utf8');
const rowCode = report.slice(report.indexOf('const twShare ='), report.indexOf('function rowsFor('));
const point = (visits: number, share: number | null, used = share) => [visits, null, null, share, 0, used, 0, null, 0];
const change = (now: unknown[], before?: unknown[], sameMonth = false) =>
  runInNewContext(`${rowCode}; row('example.tw', site).change`, {
    V: 0,
    S: 1,
    A: 2,
    T: 3,
    ORIGIN: 4,
    USED: 5,
    BASIS: 6,
    CAPPED: 8,
    state: { to: '202609', from: sameMonth ? '202609' : '202608', data: { radar: {} } },
    topicsOf: () => [],
    window: { displayDomainText: (value: string) => value },
    site: { m: { '202609': now, ...(before ? { '202608': before } : {}) } },
  });

it('compares Taiwan visits including the adopted share, rather than total visits', () => {
  // Total visits rise 20%, but Taiwan visits fall from 80 to 60.
  expect(change(point(120, 0.5), point(100, 0.8))).toBe(-0.25);
  expect(change(point(120, null, 0.5), point(100, null, 0.8))).toBe(-0.25);
});

it('does not invent Taiwan growth when a share or comparable baseline is missing', () => {
  expect(change(point(120, null), point(100, 0.8))).toBeNull();
  expect(change(point(120, 0.5), point(100, null))).toBeNull();
  expect(change(point(120, 0.5), point(100, 0))).toBeNull();
  expect(change(point(120, 0.5), undefined, true)).toBeNull();
  expect(change(point(120, 0.5))).toBe('new');
  expect(change(point(120, 0), point(100, 0.8))).toBe(-1);
});
