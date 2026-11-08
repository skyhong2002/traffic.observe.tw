export interface ScreenshotResult {
  fields: Record<string, string>;
  months: string[];
  warnings: string[];
}
export const screenshotFields: Record<string, string>;
export function parseScreenshot(tsv: string): ScreenshotResult;
export function mergeScreenshots(results: ScreenshotResult[]): ScreenshotResult;
