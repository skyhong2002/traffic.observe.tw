export interface ScreenshotSource {
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
  image?: number;
}
export interface ScreenshotResult {
  fields: Record<string, string>;
  months: string[];
  warnings: string[];
  sources?: Record<string, ScreenshotSource[]>;
  countryTable?: boolean;
  uncertainSources?: Record<string, ScreenshotSource[]>;
  countryContexts?: ScreenshotSource[];
}
export const screenshotCountryCodes: Record<string, string>;
export const screenshotFields: Record<string, string>;
export function refineScreenshotNumbers(
  tsv: string,
  recognize: (region: { x: number; y: number; w: number; h: number }) => Promise<string>,
): Promise<string>;
export function reviewScreenshotCountries(
  tsv: string,
  primary: ScreenshotResult,
  recognize: () => Promise<ScreenshotResult>,
): Promise<ScreenshotResult>;
export function parseScreenshot(tsv: string, includeSources?: boolean): ScreenshotResult;
export function mergeScreenshots(results: ScreenshotResult[]): ScreenshotResult;
