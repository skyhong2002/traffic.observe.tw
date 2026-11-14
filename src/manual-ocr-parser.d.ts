export interface ScreenshotResult {
  fields: Record<string, string>;
  months: string[];
  warnings: string[];
}
export const screenshotFields: Record<string, string>;
export function refineScreenshotNumbers(
  tsv: string,
  recognize: (region: { x: number; y: number; w: number; h: number }) => Promise<string>,
): Promise<string>;
export function parseScreenshot(tsv: string): ScreenshotResult;
export function mergeScreenshots(results: ScreenshotResult[]): ScreenshotResult;
