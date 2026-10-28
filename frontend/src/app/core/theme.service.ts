import { Injectable, signal } from '@angular/core';

export type ThemeMode = 'system' | 'light' | 'dark';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>(this.load());

  constructor() { this.apply(this.mode()); }

  set(mode: ThemeMode) {
    this.mode.set(mode);
    try { localStorage.setItem('theme', mode); } catch { /* ignore */ }
    this.apply(mode);
  }

  cycle() {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    this.set(order[(order.indexOf(this.mode()) + 1) % order.length]);
  }

  private apply(mode: ThemeMode) {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  }

  private load(): ThemeMode {
    try {
      const v = localStorage.getItem('theme');
      if (v === 'light' || v === 'dark' || v === 'system') return v;
      return localStorage.getItem('darkMode') === 'true' ? 'dark' : 'system';  // migrate old preference
    } catch {
      return 'system';
    }
  }
}
