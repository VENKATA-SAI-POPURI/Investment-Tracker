import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { Notice } from './models';

const SEEN_KEY = 'seen_notices';
const SHOWN_KEY = 'reminders_shown';

function readSeen(): string[] {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch { return []; }
}

/** Reminders (upcoming maturities, lock-ins, tax dates, items needing action): the bell, the
 *  sign-in pop-up, and an optional system notification when the browser allows it. */
@Injectable({ providedIn: 'root' })
export class NotifyService {
  private api = inject(ApiService);

  readonly items = signal<Notice[]>([]);
  readonly seen = signal<string[]>(readSeen());
  readonly open = signal(false);
  /** True while the pop-up is showing because of a fresh sign-in. */
  readonly welcome = signal(false);
  readonly unread = computed(() => this.items().filter(n => !this.seen().includes(n.id)));
  readonly systemSupported = typeof window !== 'undefined' && 'Notification' in window;
  readonly systemAllowed = signal(this.systemSupported && Notification.permission === 'granted');

  async load() {
    try {
      const r = await firstValueFrom(this.api.notifications());
      this.items.set(r.items);
      this.greetOnce();
    } catch { /* reminders are optional */ }
  }

  /** Once per browser session (i.e. at sign-in), surface unread reminders. */
  private greetOnce() {
    let shown = false;
    try { shown = sessionStorage.getItem(SHOWN_KEY) === '1'; sessionStorage.setItem(SHOWN_KEY, '1'); } catch { /* ignore */ }
    const unread = this.unread();
    if (shown || !unread.length) return;
    this.welcome.set(true);
    this.open.set(true);
    if (this.systemAllowed()) {
      try {
        new Notification(`${unread.length} reminder${unread.length > 1 ? 's' : ''} for your portfolio`, {
          body: unread.slice(0, 3).map(n => '• ' + n.title).join('\n'), icon: '/favicon.ico', tag: 'portfolio-reminders',
        });
      } catch { /* some browsers only allow this from a service worker */ }
    }
  }

  async enableSystem() {
    if (!this.systemSupported) return;
    const p = await Notification.requestPermission();
    this.systemAllowed.set(p === 'granted');
  }

  markAllSeen() {
    const ids = Array.from(new Set([...this.seen(), ...this.items().map(n => n.id)])).slice(-300);
    this.seen.set(ids);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
  }

  close() {
    this.open.set(false);
    this.welcome.set(false);
    this.markAllSeen();
  }
}
