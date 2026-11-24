import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { ViewportScroller } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { ActivatedRouteSnapshot, NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom, map, startWith } from 'rxjs';
import { ActionRunnerService } from '../core/action-runner.service';
import { ActionService } from '../core/action.service';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Brief, Member, Notice, Portfolio, Status, Vital } from '../core/models';
import { NotifyService } from '../core/notify.service';
import { readSnapshot, snapshotKey } from '../core/snapshot';
import { StoreService } from '../core/store.service';
import { TxnDialogService, TxnDialogState } from '../core/txn-dialog.service';
import { FdMatureDialogComponent } from '../shared/fd-mature-dialog.component';
import { IconComponent } from '../shared/icon.component';
import { NavBadges, TOOLS_NAV, navActive } from '../shared/nav-list.component';
import { greeting } from '../core/groups';
import { linkUnder } from '../shared/priority/priority';
import { STATUS_META, statusFromSeverity, vitalOf, worstStatus } from '../shared/priority/priority';
import { TxnFormComponent } from '../shared/txn-form.component';
import { WhatIfSaleComponent } from '../shared/what-if-sale.component';

/* ── The Data vital, mirrored on the client (AMENDMENTS E20; brief.py `_freshness` and `_data_vital`) ── */

/** brief.py FRESH_HOURS, STALE_ACT_HOURS and UNPRICED_ACT_PCT. */
export const DATA_FRESH_HOURS = 26;
export const DATA_STALE_ACT_HOURS = 96;
export const DATA_UNPRICED_ACT_PCT = 5;
const MARKET_PRICED = new Set(['equity', 'mutual_fund', 'commodity']);

/** The backend writes naive timestamps in UTC (brief.py `_ts`); `new Date()` would read them as local time. */
export function parseUtc(v: string | null | undefined): number | null {
  if (!v) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return isNaN(t) ? null : t;
}

/** "12 min", "5 h", "3 days": brief.py `_age_text`. */
export function ageText(minutes: number): string {
  if (minutes < 60) return `${Math.floor(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} days`;
}

export interface DataVitalView {
  status: Status;
  /** "Prices 12 min old · all priced" or "3 holdings at cost (6.2% of value)". */
  value: string;
  note: string | null;
  /** The oldest price stamp among priced holdings (what `brief.freshness.last_refresh` reports), or null. */
  stamp: string | null;
  ageMinutes: number | null;
  /** Where the Data vital came from: the Home brief snapshot or this mirror. */
  source: 'brief' | 'mirror';
}

/**
 * The Data vital from the portfolio already in the store (E20 client mirror of `brief._data_vital`):
 * the age is that of the oldest price among open market-priced holdings (each holding's own `price_at`,
 * else the global refresh stamp); ≤ 26 h with nothing unpriced is good; any unpriced holding, an unknown
 * age or > 26 h is watch; ≥ 5% of value unpriced or > 4 days is act. Null until the portfolio has loaded.
 */
export function dataVitalMirror(port: Portfolio | null, now: number): DataVitalView | null {
  if (!port) return null;
  const priced = (port.positions ?? []).filter(p => p.is_open && MARKET_PRICED.has(p.asset_class));
  if (!priced.length) {
    return { status: 'good', value: 'No holdings need live prices', note: null, stamp: null, ageMinutes: null, source: 'mirror' };
  }
  const glob = port.prices?.last_refresh ?? null;
  const unpriced = priced.filter(p => !p.has_price);
  const stamps = priced.filter(p => p.has_price).map(p => (parseUtc(p.price_at) !== null ? p.price_at! : glob));
  const all = stamps.length ? stamps : [glob];
  let oldest: string | null = null;
  if (all.every(s => parseUtc(s) !== null)) oldest = all.reduce((a, b) => (parseUtc(b)! < parseUtc(a)! ? b : a));
  const age = oldest ? Math.max((now - parseUtc(oldest)!) / 60000, 0) : null;
  const total = port.totals?.value ?? 0;
  const pct = total > 0 ? (unpriced.reduce((s, p) => s + (p.value || 0), 0) / total) * 100 : 0;
  const n = unpriced.length;
  const ageTxt = age !== null ? `Prices ${ageText(age)} old` : 'Prices never refreshed';
  const value = n ? `${n} holding${n > 1 ? 's' : ''} at cost (${pct.toFixed(1)}% of value)` : `${ageTxt} · all priced`;
  let status: Status = 'good';
  if (pct >= DATA_UNPRICED_ACT_PCT || (age !== null && age > DATA_STALE_ACT_HOURS * 60)) status = 'act';
  else if (n || age === null || age > DATA_FRESH_HOURS * 60) status = 'watch';
  let note: string | null = null;
  if (status !== 'good') {
    const parts: string[] = [];
    if (n) parts.push('add tickers so these are valued at market');
    if (age === null || age > DATA_FRESH_HOURS * 60) parts.push(`${ageTxt.toLowerCase()}; refresh them`);
    note = parts.length ? 'Values may be off: ' + parts.join(' · ') : null;
  }
  return { status, value, note, stamp: oldest, ageMinutes: age, source: 'mirror' };
}

/**
 * The vital the shell shows. The brief snapshot's Data vital wins only while it describes the same prices
 * (same oldest stamp); ages only grow, so the worse of the two statuses is shown. A snapshot written before
 * the last refresh (another stamp) is out of date, and the mirror stands alone.
 */
export function pickDataVital(mirror: DataVitalView | null, brief: Partial<Brief> | null): DataVitalView | null {
  const snap: Vital | undefined = Array.isArray(brief?.vitals) ? vitalOf(brief!.vitals, 'data') : undefined;
  if (!snap) return mirror;
  const view: DataVitalView = { status: snap.status, value: snap.value, note: snap.note, stamp: brief?.freshness?.last_refresh ?? null,
    ageMinutes: brief?.freshness?.age_minutes ?? null, source: 'brief' };
  if (!mirror) return view;
  if (view.stamp !== mirror.stamp) return mirror;
  return worstStatus([view.status, mirror.status]) === view.status && view.status !== mirror.status ? view : mirror;
}

/** "Prices · 12 min ago": the age of this portfolio's oldest price, as the pill shows it. */
function pillAge(v: DataVitalView | null, fallback: string | null | undefined, now: number): string {
  const mins = v?.ageMinutes ?? (parseUtc(fallback) !== null ? (now - parseUtc(fallback)!) / 60000 : null);
  if (mins === null) return 'never';
  if (mins < 1) return 'just now';
  return `${ageText(mins)} ago`;
}

/** Days left in the financial year (to 31 March), shown on Tax from January to March only. */
function fyDaysLeft(now: Date): number | null {
  const m = now.getMonth();
  if (m > 2) return null;
  const end = new Date(now.getFullYear(), 2, 31);
  return Math.max(Math.ceil((end.getTime() - new Date(now.getFullYear(), m, now.getDate()).getTime()) / 86400000), 0);
}

const BRIEF_POLL_MS = 30_000;
const APP_NAME = 'Investments';

type Menu = 'portfolio' | 'tools' | 'user' | null;

/** One place in the redesigned navigation. `match` lists the path prefixes where it shows as current. */
export interface ShellNav { path: string; label: string; icon: string; match: string[]; }

/** Home · Portfolio · Analysis · Activity (the phone tab bar puts + Add in the middle). */
export const PRIMARY: ShellNav[] = [
  { path: '/', label: 'Home', icon: 'house', match: ['/'] },
  { path: '/portfolio', label: 'Portfolio', icon: 'layers', match: ['/portfolio', '/holdings', '/holding/', '/p2p', '/fixed-deposits', '/forex', '/epf', '/nps'] },
  { path: '/analysis', label: 'Analysis', icon: 'barChart', match: ['/analysis'] },
  { path: '/activity', label: 'Activity', icon: 'listV2', match: ['/activity', '/transactions', '/import'] },
];
export const MORE: ShellNav[] = [
  { path: '/tax', label: 'Tax', icon: 'receiptText', match: ['/tax'] },
  { path: '/reports', label: 'Reports', icon: 'fileText', match: ['/reports'] },
  { path: '/settings', label: 'Settings', icon: 'settings', match: ['/settings'] },
];
/** Switched off by default; Settings › "Show classic tools" brings them back. */
export const CLASSIC: ShellNav[] = [
  { path: '/plan', label: 'Plan & goals', icon: 'target', match: ['/plan'] },
  { path: '/actions', label: 'Actions', icon: 'bulb', match: ['/actions'] },
  { path: '/markets', label: 'Markets', icon: 'zap', match: ['/markets'] },
  { path: '/performance', label: 'Performance (classic)', icon: 'chart', match: ['/performance'] },
  { path: '/risk', label: 'Risk & mix', icon: 'shield', match: ['/risk'] },
  { path: '/recurring', label: 'Recurring plans', icon: 'repeat', match: ['/recurring'] },
  { path: '/cash-flows', label: 'Cash flows', icon: 'wallet', match: ['/cash-flows'] },
  { path: '/classic', label: 'Classic home', icon: 'home', match: ['/classic'] },
];

/**
 * The application frame: the five-slot bar (§3.1), the More popover, the drawer and the ≤760px bottom bar
 * (all one NavListComponent), the prices pill, the bell and the global dialogs. It renders no h1 (A22):
 * each page owns its own, and the shell only names the browser tab from the route's `data.title`.
 */
@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, IconComponent, TxnFormComponent, FdMatureDialogComponent, WhatIfSaleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {
  auth = inject(AuthService);
  store = inject(StoreService);
  dialog = inject(TxnDialogService);
  notify = inject(NotifyService);
  actions = inject(ActionService);
  private api = inject(ApiService);
  private router = inject(Router);
  private runner = inject(ActionRunnerService);
  private title = inject(Title);

  tools = TOOLS_NAV;
  primary = PRIMARY;
  more = MORE;
  classic = CLASSIC;
  advanced = computed(() => this.store.settings().advancedFeatures === true);
  isOn = (it: ShellNav) => it.match.some(m => linkUnder(this.url(), m));
  isHome = computed(() => this.url() === '/' || this.url() === '');
  /** The page name the shell shows (new pages only; older pages render their own heading). */
  shellTitle = signal<string | null>(null);
  greeting = computed(() => { this.tick(); return greeting(); });
  /** Home's greeting: the member being viewed, else the signed-in person (first name only). */
  firstName = computed(() => {
    const name = this.selected() ? this.auth.portfolioLabel() : (this.auth.user()?.name || this.auth.portfolioLabel());
    return (name || 'there').split(' ')[0];
  });
  menu = signal<Menu>(null);
  drawer = signal(false);

  /** The current path, without query or fragment. */
  url = toSignal(this.router.events.pipe(
    filter(e => e instanceof NavigationEnd),
    map(e => (e as NavigationEnd).urlAfterRedirects.split(/[?#]/)[0]),
    startWith(this.router.url.split(/[?#]/)[0]),
  ), { initialValue: '/' });

  toolsActive = computed(() => TOOLS_NAV.some(t => navActive(t, this.url())));

  /** Bumped on navigation, focus, store reloads and a slow timer: the brief snapshot and ages are re-read then. */
  private tick = signal(0);
  private now = computed(() => { this.tick(); return Date.now(); });

  /** Home's brief, as Home last wrote it on this device (E20: the shell reads it and never fetches). */
  brief = computed(() => {
    this.tick();
    this.store.version();
    return readSnapshot<Partial<Brief>>(snapshotKey('brief', this.store.scopeKey()));
  });

  dataVital = computed(() => pickDataVital(dataVitalMirror(this.store.portfolio(), this.now()), this.brief()));
  pricesAge = computed(() => pillAge(this.dataVital(), this.store.portfolio()?.prices.last_refresh, this.now()));
  /** Spoken and hover text for the pill: the status word first, never colour alone. */
  pricesTitle = computed(() => {
    const v = this.dataVital();
    if (!v) return 'Prices · tap to refresh';
    return `Prices: ${STATUS_META[v.status].word} · ${v.value}${v.note ? ' · ' + v.note : ''} · tap to refresh`;
  });

  badges = computed<NavBadges>(() => {
    const s = this.actions.summary();
    const days = s.tax_open ? fyDaysLeft(new Date(this.now())) : null;
    const mode = this.brief()?.market_state?.mode;
    return {
      actions: { count: (s.now || 0) + (s.month || 0), urgent: (s.now || 0) > 0 },
      planAct: this.brief()?.on_track?.plan?.status === 'act',
      tax: days !== null ? `${days} day${days === 1 ? '' : 's'} left` : null,
      // E20: read from Home's snapshot only; the shell never fetches /brief or /markets for it
      markets: mode === 'correction' || mode === 'crash' ? mode : null,
    };
  });

  /* ── Bell (R13): the server's notices; `act:` ids are "Do now", the rest "Coming up". The nav badge still reads
     ActionService; the bell no longer merges its tier-now actions (W7-B2 sends them as `act:` notices). ── */
  bellDoNow = this.notify.doNow;
  bellComingUp = this.notify.comingUp;
  bellUnread = this.notify.unreadCount;
  bellEmpty = computed(() => !this.notify.items().length);
  /** "{n} things since you were last here": the count when the pop-up opened (the badge drops as they are marked). */
  bellWelcomeCount = computed(() => this.notify.shownUnread().size || this.notify.unreadCount());

  /** The store scope the current settings object arrived under (set whenever `store.settings` changes). */
  private settingsScope = signal<string | null>(null);

  /* ── Member banner (R13, P2.6): whose settings a save in this view writes ── */
  memberBanner = computed<{ text: string; icon: string; kind: 'edit' | 'family' | 'view' } | null>(() => {
    const email = this.auth.portfolio();
    if (!email || this.auth.viewAs()) return null;
    const role = this.auth.realRole();
    const name = this.auth.portfolioLabel();
    if (role === 'guest') return { text: `Viewing ${name}'s plan`, icon: 'eye', kind: 'view' };
    if (role !== 'admin') return null;
    // settings_owner counts only once the settings on screen belong to this view: right after a switch the store can
    // still hold the family's settings (owner __global__), which would flash "Editing the family plan"
    const owner = this.settingsScope() === this.store.scopeKey() ? this.store.settings().settings_owner : undefined;
    if (owner && owner.toLowerCase() !== email.toLowerCase()) return { text: 'Editing the family plan', icon: 'users', kind: 'family' };
    const me = this.auth.user()?.email?.toLowerCase();
    const self = email.toLowerCase() === me || this.auth.members().some(m => m.self && m.email.toLowerCase() === email.toLowerCase());
    return self
      ? { text: 'Editing your own plan · changes save to your settings', icon: 'edit', kind: 'edit' }
      : { text: `Editing ${name}'s plan · changes save to their settings`, icon: 'edit', kind: 'edit' };
  });

  initials = (name: string | null | undefined) => (name || '?').trim().slice(0, 1).toUpperCase();
  selected = computed(() => this.auth.portfolio()?.toLowerCase() ?? null);

  constructor() {
    const destroy = inject(DestroyRef);
    // The router's anchor scroll (withInMemoryScrolling) calls window.scrollTo and ignores scroll-margin, so a
    // linked section (/performance#concentration, /settings#prices, /actions#deploy) would sit under the sticky
    // app bar. 80 px matches the pages' own scroll-margin-top (W4 integrator).
    inject(ViewportScroller).setOffset([0, 80]);
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => {
      this.menu.set(null);
      this.drawer.set(false);
      this.tick.update(t => t + 1);
      this.setDocumentTitle();
      setTimeout(() => this.revealActiveTabs(), 60);
    });
    this.setDocumentTitle();
    const timer = setInterval(() => this.tick.update(t => t + 1), BRIEF_POLL_MS);
    const onFocus = () => this.tick.update(t => t + 1);
    window.addEventListener('focus', onFocus);
    destroy.onDestroy(() => { clearInterval(timer); window.removeEventListener('focus', onFocus); });

    // family members for the switcher, once per sign-in
    effect(() => {
      if (this.auth.token()) queueMicrotask(() => this.loadMembers());
    });
    // the banner trusts settings_owner only for settings that arrived under the scope now on screen
    effect(() => {
      this.store.settings();
      const scope = untracked(() => this.store.scopeKey());
      untracked(() => this.settingsScope.set(scope));
    });
    // reminders follow the portfolio being viewed
    effect(() => {
      const v = this.store.version();
      if (this.auth.token() && v >= 0) queueMicrotask(() => this.notify.load());
    });
  }

  /** A22: the browser tab is named after the deepest route's `data.title`; the page renders its own h1. */
  private setDocumentTitle() {
    let r: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
    let name: string | undefined;
    let shell = false;
    while (r) { name = (r.data?.['title'] as string | undefined) ?? name; shell = (r.data?.['shellTitle'] as boolean | undefined) ?? shell; r = r.firstChild; }
    this.title.setTitle(name ? `${name} · ${APP_NAME}` : APP_NAME);
    this.shellTitle.set(shell && name ? name : null);
  }

  /** Tab rows wider than the screen scroll so the current tab is in view (§3.2). */
  private revealActiveTabs() {
    document.querySelectorAll<HTMLElement>('.tabs').forEach(row => {
      if (row.scrollWidth <= row.clientWidth + 1) return;
      const on = row.querySelector<HTMLElement>(':scope > .on, :scope > [aria-selected="true"]');
      if (on) this.reveal(row, on);
    });
  }

  private reveal(row: HTMLElement, tab: HTMLElement) {
    const r = row.getBoundingClientRect(), t = tab.getBoundingClientRect();
    const pad = 32;  // keep the chosen tab clear of the fade edge
    if (t.left >= r.left + pad && t.right <= r.right - pad) return;
    const left = row.scrollLeft + (t.left - r.left) - (r.width - t.width) / 2;
    row.scrollTo({ left: Math.max(left, 0), behavior: 'smooth' });
  }

  /** A tab chosen in a row that overflows comes fully into view, even when it changes no URL. */
  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent) {
    const tab = (e.target as HTMLElement | null)?.closest?.('.tabs > *') as HTMLElement | null;
    const row = tab?.parentElement;
    if (tab && row && row.scrollWidth > row.clientWidth + 1) setTimeout(() => this.reveal(row, tab), 0);
  }

  /** Escape closes whatever is open: the drawer, a popover or the bell. */
  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.drawer()) this.drawer.set(false);
    this.closeMenus();
  }

  private async loadMembers() {
    try {
      const r = await firstValueFrom(this.api.portfolios());
      this.auth.members.set(r.members);
      const sel = this.auth.portfolio();
      if (sel && !r.members.some(m => m.email.toLowerCase() === sel.toLowerCase())) this.auth.selectPortfolio(null);
    } catch { /* the switcher just stays on Family */ }
  }

  /** A dialog save that fulfils an action marks it done once, with the new transaction ids as evidence (§8.4). */
  txnSaved(s: TxnDialogState, txnIds: number[]) {
    if (!s.actionId) return;
    void this.runner.dialogSaved(s.actionId, txnIds);
    // "Save & add another" keeps the dialog open; later saves are not evidence for the same action
    this.dialog.state.set({ ...s, actionId: undefined });
  }

  refreshPrices() { void this.store.refreshPrices(true); }

  toggle(m: Menu) { this.menu.set(this.menu() === m ? null : m); if (this.notify.open()) this.closeBell(); }
  toggleBell() { this.menu.set(null); if (this.notify.open()) this.closeBell(); else this.notify.show(); }
  closeMenus() { this.menu.set(null); if (this.notify.open()) this.closeBell(); }

  /** Closing the bell: local mode marks what it showed; server mode already posted the shown ids on open (R13). */
  closeBell() { this.notify.close(); }

  pick(m: Member | null) {
    this.auth.selectPortfolio(m ? m.email : null);
    this.menu.set(null);
  }

  /** E19: navigateByUrl parses `?` before `#`, so `/plan?tab=goals` and `/actions?new_money=5000#deploy` both land. */
  go(n: Notice) {
    this.closeBell();
    void this.router.navigateByUrl(n.link || '/');
  }

  /** A "Do now" notice carries the action's severity (crit → critical, warn → warning, R9). */
  noticeStatus = (n: Notice): Status => statusFromSeverity(n.severity);
  statusIcon = (s: Status) => STATUS_META[s].icon;
  noticeIcon = (n: Notice) => ({ festival: 'diya', tax: 'receipt', fy: 'calendar', personal: 'target' } as Record<string, string>)[n.kind] ?? 'info';
  when = (n: Notice) => n.days === null || n.days === undefined ? '' : n.days < 0 ? 'Late' : n.days === 0 ? 'Today' : n.days === 1 ? 'Tomorrow' : `In ${n.days} days`;
}
