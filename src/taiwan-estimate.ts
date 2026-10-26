// The Taiwan share a ranking is sorted by (台灣造訪量 = visits × share). Similarweb's own figure
// wins; a site without one gets, in this order:
//   manual   the editors' 「/N」 guess in the sheet (1/N of the visits are Taiwan's)
//   history  the site's latest known share from an earlier month
//   bound    the ceiling Similarweb's top five countries leave: Taiwan is not among them, so it
//            has at most the fifth country's share, and at most what the five leave of 100%
// A manual or earlier share above that ceiling contradicts Similarweb's own countries and is replaced
// by the ceiling (a little slack, since both are estimates).

export type TaiwanBasis = 'measured' | 'manual' | 'history' | 'bound';

export interface TaiwanEstimate {
  /** 0–1: the share the ranking uses. */
  share: number;
  basis: TaiwanBasis;
  /** The ceiling from Similarweb's other top countries, when it has them. */
  max: number | null;
  /** A manual or earlier share was above the ceiling and was replaced by it. */
  capped: boolean;
}

/** An estimate may exceed the ceiling by this factor before it counts as contradicting it. */
export const BOUND_SLACK = 1.1;

/** The most Taiwan can have when it is not among Similarweb's top countries; null without any country data. */
export function taiwanCeiling(countries: Array<{ code: string; share: number }> | null | undefined): number | null {
  if (!countries?.length || countries.some((c) => c.code === 'TW')) return null;
  const left = Math.max(0, 1 - countries.reduce((a, c) => a + c.share, 0));
  // Similarweb lists five countries when it has that many; Taiwan ranks below the last of them.
  return countries.length >= 5 ? Math.min(left, countries[4].share) : left;
}

export function estimateTaiwanShare(input: {
  measured: number | null;
  countries: Array<{ code: string; share: number }> | null | undefined;
  /** The sheet's 「/N」 divisor. */
  divisor: number | null;
  /** The latest measured share of an earlier month. */
  earlier: number | null;
}): TaiwanEstimate | null {
  const { measured, divisor, earlier } = input;
  const max = measured === null ? taiwanCeiling(input.countries) : null;
  if (measured !== null) return { share: measured, basis: 'measured', max: null, capped: false };
  const guess = (share: number, basis: 'manual' | 'history'): TaiwanEstimate =>
    max !== null && share > max * BOUND_SLACK ? { share: max, basis: 'bound', max, capped: true } : { share, basis, max, capped: false };
  if (divisor !== null && divisor > 0) return guess(Math.min(1, 1 / divisor), 'manual');
  if (earlier !== null) return guess(earlier, 'history');
  return max !== null ? { share: max, basis: 'bound', max, capped: false } : null;
}

/** 台灣造訪量 in millions: visits × the share in use; null when either is unknown. */
export const taiwanVisits = (visits: number | null, share: number | null | undefined) =>
  visits !== null && share != null ? visits * share : null;
