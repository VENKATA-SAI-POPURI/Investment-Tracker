import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { Notice } from './models';

const SEEN_KEY = 'seen_notices';
const SHOWN_KEY = 'reminders_shown';
/** The local seen list keeps the newest ids only (it is a per-device convenience, never the record). */
const SEEN_MAX = 300;
/** POST /notifications/seen takes ≤ 100 ids of ≤ 200 characters (R9). */
const SEEN_POST_MAX = 100;

function readSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function writeSeen(ids: string[]) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids)); } catch { /* storage unavailable: the list stays in memory */ }
}

/** Action notices (`act:<action id>`, K19) are the bell's "Do now"; everything else is "Coming up" (R13). */
export function isActionNotice(n: Pick<Notice, 'id'>): boolean {
  return n.id.startsWith('act:');
}

/**
 * The bell's data (R13, R9): `GET /notifications` items and the server's `unread`, the sign-in pop-up, and an optional
 * system notification when the browser allows it.
 *
 * Two ways of knowing what is read:
 * - **Server** (a W7-B2 server sends `unread`, and the viewer can write): each item's `seen` and the badge come from
 *   `action_log.seen_at`. Opening the bell posts the shown unread ids to `/notifications/seen` and takes `unread`
 *   from the reply, so the count follows the user to other devices.
 * - **Local** (guests, who share `__global__` with the admin and may not mark it; and a wave-6 server with no
 *   `unread`): today's `seen_notices` list in localStorage, marked when the bell closes.
 */
@Injectable({ providedIn: 'root' })
export class NotifyService {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  readonly items = signal<Notice[]>([]);
  /** The server's unread count, or null when the server sent none (wave 6). */
  readonly serverUnread = signal<number | null>(null);
  /** Local seen ids (guests and wave-6 servers). */
  readonly seen = signal<string[]>(readSeen());
  readonly open = signal(false);
  /** True while the pop-up is showing because of a fresh sign-in. */
  readonly welcome = signal(false);
  /** The ids that were unread when the bell opened: they keep their dot while it is open, after being marked. */
  readonly shownUnread = signal<ReadonlySet<string>>(new Set());
  /** The last load or seen post failed; the bell still shows what it has. */
  readonly failed = signal(false);
  readonly loaded = signal(false);

  /** Server mode: the server counts unread and this viewer may mark items seen (guests get a 403, R9). */
  readonly serverMode = computed(() => this.serverUnread() !== null && this.auth.canWrite());

  readonly doNow = computed(() => this.items().filter(isActionNotice));
  readonly comingUp = computed(() => this.items().filter(n => !isActionNotice(n)));

  /** The items not yet read, by whichever record applies. */
  readonly unreadItems = computed(() => {
    if (this.serverMode()) return this.items().filter(n => n.seen !== true);
    const seen = new Set(this.seen());
    return this.items().filter(n => !seen.has(n.id));
  });
  /** The badge: the server's count when it sends one (R13), else the local count. */
  readonly unreadCount = computed(() => {
    const s = this.serverUnread();
    return this.serverMode() && s !== null ? Math.max(s, 0) : this.unreadItems().length;
  });
  /** Backwards-compatible name: the unread items. */
  readonly unread = this.unreadItems;

  readonly systemSupported = typeof window !== 'undefined' && 'Notification' in window;
  readonly systemAllowed = signal(this.systemSupported && Notification.permission === 'granted');

  private loadSeq = 0;

  async load() {
    const seq = ++this.loadSeq;
    try {
      const r = await firstValueFrom(this.api.notifications());
      if (seq !== this.loadSeq) return;  // a newer load (portfolio switch) owns the bell
      this.items.set(Array.isArray(r?.items) ? r.items : []);
      this.serverUnread.set(typeof r?.unread === 'number' && Number.isFinite(r.unread) ? r.unread : null);
      this.failed.set(false);
      this.loaded.set(true);
      this.greetOnce();
    } catch {
      // reminders are optional: keep what the bell had and say so inside it
      if (seq === this.loadSeq) { this.failed.set(true); this.loaded.set(true); }
    }
  }

  /** Is this item new to the viewer? While the bell is open, the items that were unread when it opened stay new. */
  isNew(n: Notice): boolean {
    if (this.open() && this.shownUnread().has(n.id)) return true;
    if (this.serverMode()) return n.seen !== true;
    return !this.seen().includes(n.id);
  }

  /** Opens the bell. In server mode the shown unread ids are posted as seen straight away (R13). */
  show() {
    const unread = this.unreadItems();
    this.shownUnread.set(new Set(unread.map(n => n.id)));
    this.open.set(true);
    if (this.serverMode() && unread.length) void this.postSeen(unread.map(n => n.id));
  }

  /** Once per browser session (i.e. at sign-in), surface unread reminders. */
  private greetOnce() {
    let shown = false;
    try { shown = sessionStorage.getItem(SHOWN_KEY) === '1'; sessionStorage.setItem(SHOWN_KEY, '1'); } catch { /* ignore */ }
    const unread = this.unreadItems();
    if (shown || !unread.length || this.open()) return;
    this.welcome.set(true);
    this.show();
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

  /**
   * Marks ids seen on the server and takes `unread` from the reply. The badge drops at once (optimistic) and goes
   * back if the post fails, so a failed post never pretends the items were read.
   */
  private async postSeen(ids: string[]) {
    const clean = Array.from(new Set(ids.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200))).slice(0, SEEN_POST_MAX);
    if (!clean.length) return;
    const before = this.serverUnread();
    const seq = this.loadSeq;
    // the ids this post turns from unread to read: only these are put back if it fails
    const flipped = new Set(this.items().filter(n => clean.includes(n.id) && n.seen !== true).map(n => n.id));
    this.items.update(list => list.map(n => (flipped.has(n.id) ? { ...n, seen: true } : n)));
    if (before !== null) this.serverUnread.set(Math.max(before - flipped.size, 0));
    try {
      const r = await firstValueFrom(this.api.notificationsSeen(clean));
      if (typeof r?.unread === 'number' && Number.isFinite(r.unread)) this.serverUnread.set(r.unread);
      this.failed.set(false);
    } catch {
      // a load that landed meanwhile already holds the server's truth; otherwise undo exactly this post
      if (seq === this.loadSeq) {
        this.items.update(list => list.map(n => (flipped.has(n.id) ? { ...n, seen: false } : n)));
        if (before !== null) this.serverUnread.update(u => (u === null ? u : u + flipped.size));
      }
      this.failed.set(true);
    }
  }

  /** Local mode: everything the bell lists is now seen on this device. */
  markAllSeen() {
    const ids = Array.from(new Set([...this.seen(), ...this.items().map(n => n.id)])).slice(-SEEN_MAX);
    this.seen.set(ids);
    writeSeen(ids);
  }

  /** Closes the bell. Local mode marks what it showed; server mode posts anything that arrived while it was open. */
  close() {
    this.open.set(false);
    this.welcome.set(false);
    if (this.serverMode()) {
      const left = this.items().filter(n => n.seen !== true).map(n => n.id);
      if (left.length) void this.postSeen(left);
    } else {
      this.markAllSeen();
    }
    this.shownUnread.set(new Set());
  }
}
