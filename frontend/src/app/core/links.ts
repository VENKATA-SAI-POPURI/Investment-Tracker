import { Params } from '@angular/router';

/** Links from the API ("/analysis?q=mix") split for [routerLink] + [queryParams], so taps stay inside the app. */
export function linkPath(link: string): string {
  return (link || '/').split('?')[0] || '/';
}

export function linkQuery(link: string): Params | null {
  const q = (link || '').split('?')[1];
  if (!q) return null;
  const out: Params = {};
  new URLSearchParams(q).forEach((v, k) => { out[k] = v; });
  return out;
}

/** An answer's or a to-do's tone as a `.v-tone` class. */
export function toneClass(tone: string | null | undefined): string {
  const map: Record<string, string> = { good: 'good', warn: 'warn', bad: 'bad', info: 'info', primary: 'brand', muted: 'brand' };
  return 'v-tone ' + (map[tone ?? ''] ?? 'brand');
}
