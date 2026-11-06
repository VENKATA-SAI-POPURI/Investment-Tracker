/**
 * Last-seen API results kept on this device, so a page can draw at once and refresh quietly
 * (stale-while-revalidate). Keyed by who is signed in and which portfolio is shown; cleared on sign-out.
 * Storage can be unavailable (private mode, quota), so every access is best-effort.
 */
const PREFIX = 'snap:';

export function snapshotKey(...parts: (string | null | undefined)[]): string {
  return PREFIX + parts.map(p => p ?? '').join('|');
}

export function readSnapshot<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    clearSnapshots();  // most likely over quota: drop old snapshots rather than keep stale ones around
  }
}

export function clearSnapshots(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch { /* storage unavailable */ }
}
