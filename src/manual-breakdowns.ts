import { ManualInputError, manualText, missingManualValue } from './manual-input.ts';
import { publicDomain } from './similarweb.ts';

/** Fraction of the section's denominator, retaining inequalities from the platform. */
export interface ReportedPercent {
  value: number;
  bound: 'lt' | 'gt' | null;
}
export interface BreakdownRow {
  /** Null when Similarweb hides the name behind an upgrade prompt. */
  name: string | null;
  share: ReportedPercent;
  /** Platform-reported change, not recomputed from a partial list. */
  change: string | null;
}
export const breakdownFields = [
  ['social', 'Social 平台分布', 'Facebook | 76.23%；占社群流量，不是全站流量'],
  ['referringSites', 'Referrals 來源網站', 'yahoo.com | 92.41% | -13.99%；占 Referral 流量'],
  ['referringIndustries', 'Referrals 來源產業', 'News and Media | 9.67%；占 Referral 流量'],
  ['outgoingLinks', 'Outgoing traffic 連出目的地', 'yahoo.com | 34.30% | +10.39%；占連出流量'],
  ['outgoingAdvertisers', 'Outgoing ads 廣告主', 'worldlifestyle.com | 15.17% | +210.72%；占連出廣告流量'],
  ['displayPublishers', 'Display advertising 刊登網站', 'msn.com | 99.82% | +88%；占展示廣告流量'],
] as const;
export const breakdownTotals = [
  ['socialTotal', 'Social 占全站流量'],
  ['referralTotal', 'Referrals 占全站流量'],
  ['displayTotal', 'Display ads 占全站流量'],
] as const;
export type PlatformBreakdowns = Record<(typeof breakdownFields)[number][0], BreakdownRow[]> &
  Record<(typeof breakdownTotals)[number][0], ReportedPercent | null>;

export function parseReportedPercent(raw: unknown, label = '占比', field = ''): ReportedPercent | null {
  const text = manualText(raw);
  if (missingManualValue(text)) return null;
  const m = /^(<|>)?\s*(\d+(?:\.\d+)?)\s*%?$/.exec(text);
  if (!m || Number(m[2]) > 100) throw new ManualInputError(`${label}請填 0–100 的百分比，也可填 <0.01%。`, field);
  return { value: Number(m[2]) / 100, bound: m[1] === '<' ? 'lt' : m[1] === '>' ? 'gt' : null };
}
export const reportedPercentText = (share: ReportedPercent | null | undefined) =>
  share ? `${share.bound === 'lt' ? '<' : share.bound === 'gt' ? '>' : ''}${Number((share.value * 100).toFixed(8))}%` : '';

function parseChange(raw: string | undefined, field: string) {
  const text = (raw ?? '').trim().replace(/,/g, '').replace(/^↑\s*/, '+').replace(/^↓\s*/, '-');
  if (!text || text === '-' || text === '—') return null;
  if (/^new$/i.test(text)) return 'New';
  if (!/^[+-]?\s*[<>]?\s*\d+(?:\.\d+)?\s*%?$/.test(text) || text.length > 32)
    throw new ManualInputError('Change 請填有正負號的百分比、>5000% 或 New。', field);
  return `${text.replace(/\s|%/g, '')}%`;
}
export function parseBreakdowns(body: Record<string, unknown>): PlatformBreakdowns {
  const out = {} as PlatformBreakdowns;
  for (const [key, label] of breakdownTotals) out[key] = parseReportedPercent(body[key], label, key);
  for (const [key, label] of breakdownFields) {
    const text = String(body[key] ?? '').trim();
    if (text.length > 20000) throw new ManualInputError(`${label}內容過長。`, key);
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > 100) throw new ManualInputError(`${label}最多 100 列。`, key);
    const seen = new Set<string>();
    out[key] = lines.map((line) => {
      const parts = line.split(/\||\t/).map((v) => v.trim());
      if (parts.length < 2 || parts.length > 3) throw new ManualInputError(`${label}每行請填「名稱 | 占比 | 變化（選填）」。`, key);
      let name = parts[0] === '?' ? null : parts[0];
      if (name !== null && (!name || name.length > 128 || [...name].some((c) => c < ' ' || c.charCodeAt(0) === 127)))
        throw new ManualInputError(`${label}名稱不正確。`, key);
      if (name && !['social', 'referringIndustries'].includes(key)) {
        name = publicDomain(name);
        if (!name) throw new ManualInputError(`${label}請填公開網域；平台隱藏名稱時填 ?。`, key);
      }
      if (name && seen.has(name.toLowerCase())) throw new ManualInputError(`${label}名稱不能重複。`, key);
      if (name) seen.add(name.toLowerCase());
      const share = parseReportedPercent(parts[1], label, key);
      if (!share) throw new ManualInputError(`${label}每列須有占比；不知道的列可以不填。`, key);
      return { name, share, change: parseChange(parts[2], key) };
    });
    // Only exact shares and lower bounds contribute to the known minimum.
    if (out[key].reduce((sum, row) => sum + (row.share.bound === 'lt' ? 0 : row.share.value), 0) > 1.001)
      throw new ManualInputError(`${label}占比合計不能超過 100%。`, key);
  }
  return out;
}

export function breakdownValues(breakdowns?: PlatformBreakdowns): Record<string, string> {
  return Object.fromEntries([
    ...breakdownTotals.map(([key]) => [key, reportedPercentText(breakdowns?.[key])]),
    ...breakdownFields.map(([key]) => [
      key,
      (breakdowns?.[key] ?? [])
        .map((r) => [r.name ?? '?', reportedPercentText(r.share), ...(r.change ? [r.change] : [])].join(' | '))
        .join('\n'),
    ]),
  ]);
}
