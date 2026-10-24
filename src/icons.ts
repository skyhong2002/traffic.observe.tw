import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

// Site icons for the tables. Each domain's icon is fetched once, on the server,
// from Google's favicon service and kept on disk, so visitors only ever ask this
// site. A domain without an icon is remembered too, and the pages fall back to
// the name's first letter.

const SOURCE = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
const FRESH_MS = 30 * 24 * 3600_000;
const MISSING_RETRY_MS = 7 * 24 * 3600_000;
const MAX_BYTES = 200_000;
const TIMEOUT_MS = 8000;
/** At most this many icons are fetched at once, however many rows a page shows. */
const PARALLEL = 6;

export interface Icon {
  body: Buffer;
  type: string;
}

export function iconStore(
  dir = new URL(
    process.env.TRAFFIC_ICON_DIR ? `file://${process.env.TRAFFIC_ICON_DIR.replace(/\/?$/, '/')}` : '../data/icons/',
    import.meta.url,
  ),
  request: typeof fetch = fetch,
  now = () => Date.now(),
) {
  const inFlight = new Map<string, Promise<Icon | null>>();
  let running = 0;
  const waiting: Array<() => void> = [];
  const slot = async () => {
    if (running >= PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };
  const file = (domain: string, ext: string) => new URL(`${domain}.${ext}`, dir);
  const age = async (url: URL) => {
    try {
      return now() - (await stat(url)).mtimeMs;
    } catch {
      return null;
    }
  };

  async function fetchIcon(domain: string): Promise<Icon | null> {
    await slot();
    try {
      const res = await request(SOURCE(domain), { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
      const type = res.headers.get('content-type') ?? '';
      const body = Buffer.from(await res.arrayBuffer());
      // Google answers 404 with a generic globe for a domain it has no icon for.
      return res.ok && type.startsWith('image/') && body.length > 0 && body.length <= MAX_BYTES ? { body, type: type.split(';')[0] } : null;
    } finally {
      release();
    }
  }

  async function load(domain: string): Promise<Icon | null> {
    const png = file(domain, 'png');
    const pngAge = await age(png);
    if (pngAge !== null && pngAge < FRESH_MS) return { body: await readFile(png), type: 'image/png' };
    const missingAge = await age(file(domain, 'none'));
    if (missingAge !== null && missingAge < MISSING_RETRY_MS) return null;
    let icon: Icon | null;
    try {
      icon = await fetchIcon(domain);
    } catch {
      // A network failure keeps an older icon and tries again on a later visit.
      return pngAge !== null ? { body: await readFile(png), type: 'image/png' } : null;
    }
    await mkdir(dir, { recursive: true });
    if (icon) await writeFile(png, icon.body);
    else await writeFile(file(domain, 'none'), '');
    return icon ?? (pngAge !== null ? { body: await readFile(png), type: 'image/png' } : null);
  }

  /** The icon for a domain already checked with publicDomain(), or null when it has none. */
  return (domain: string) => {
    const pending = inFlight.get(domain) ?? load(domain).finally(() => inFlight.delete(domain));
    inFlight.set(domain, pending);
    return pending;
  };
}
