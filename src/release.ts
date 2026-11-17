import { readFileSync } from 'node:fs';
export function releaseRevision() {
  try {
    const revision = readFileSync(new URL('../.release-revision', import.meta.url), 'utf8').trim();
    return /^[a-f0-9]{40}$/.test(revision) ? revision : null;
  } catch {
    return null;
  }
}
