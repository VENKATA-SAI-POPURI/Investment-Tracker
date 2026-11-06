import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom, map, startWith } from 'rxjs';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { relTime } from '../core/format';
import { Member, Notice } from '../core/models';
import { NotifyService } from '../core/notify.service';
import { StoreService } from '../core/store.service';
import { TxnDialogService } from '../core/txn-dialog.service';
import { IconComponent } from '../shared/icon.component';
import { TxnFormComponent } from '../shared/txn-form.component';

interface NavItem { path: string; label: string; icon: string; match: string[]; hint?: string; }

export const NAV: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: 'home', match: [] },
  { path: '/holdings/equity', label: 'Holdings', icon: 'layers', match: ['/holdings', '/holding/', '/p2p', '/fixed-deposits', '/forex', '/epf', '/nps'] },
  { path: '/transactions', label: 'Transactions', icon: 'list', match: ['/transactions', '/cash-flows'] },
  { path: '/reports', label: 'Reports', icon: 'file', match: ['/reports'] },
  { path: '/analytics', label: 'Analytics', icon: 'chart', match: ['/analytics'] },
  { path: '/markets', label: 'Markets', icon: 'zap', match: ['/markets'] },
];

export const TOOLS: NavItem[] = [
  { path: '/tax', label: 'Tax planner', icon: 'receipt', match: ['/tax'], hint: 'Capital gains, harvesting and the tax estimate' },
  { path: '/goals', label: 'Goals', icon: 'target', match: ['/goals'], hint: 'Earmark money and track your chances' },
  { path: '/insights', label: 'Insights', icon: 'bulb', match: ['/insights'], hint: 'Suggestions and the rebalancing planner' },
  { path: '/import', label: 'Import statements', icon: 'upload', match: ['/import'], hint: 'CAS, broker tradebooks, P2P statements' },
  { path: '/settings', label: 'Settings', icon: 'settings', match: ['/settings'], hint: 'Targets, tax slab, prices and family access' },
];

type Menu = 'portfolio' | 'tools' | 'user' | null;

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, IconComponent, TxnFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {
  auth = inject(AuthService);
  store = inject(StoreService);
  dialog = inject(TxnDialogService);
  notify = inject(NotifyService);
  private api = inject(ApiService);
  private router = inject(Router);

  nav = NAV;
  tools = TOOLS;
  menu = signal<Menu>(null);
  drawer = signal(false);

  url = toSignal(this.router.events.pipe(
    filter(e => e instanceof NavigationEnd),
    map(e => (e as NavigationEnd).urlAfterRedirects.split(/[?#]/)[0]),
    startWith(this.router.url.split(/[?#]/)[0]),
  ), { initialValue: '/' });

  active = (item: NavItem) => {
    const u = this.url();
    return item.match.length ? item.match.some(m => u.startsWith(m)) : u === '/';
  };
  toolsActive = computed(() => this.tools.some(t => this.active(t)));
  title = computed(() => [...this.nav, ...this.tools].find(n => this.active(n))?.label ?? '');
  pricesAge = computed(() => relTime(this.store.portfolio()?.prices.last_refresh));
  initials = (name: string | null | undefined) => (name || '?').trim().slice(0, 1).toUpperCase();
  selected = computed(() => this.auth.portfolio()?.toLowerCase() ?? null);

  constructor() {
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => { this.menu.set(null); this.drawer.set(false); });
    // family members for the switcher, once per sign-in
    effect(() => {
      if (this.auth.token()) queueMicrotask(() => this.loadMembers());
    });
    // reminders follow the portfolio being viewed
    effect(() => {
      const v = this.store.version();
      if (this.auth.token() && v >= 0) queueMicrotask(() => this.notify.load());
    });
  }

  private async loadMembers() {
    try {
      const r = await firstValueFrom(this.api.portfolios());
      this.auth.members.set(r.members);
      const sel = this.auth.portfolio();
      if (sel && !r.members.some(m => m.email.toLowerCase() === sel.toLowerCase())) this.auth.selectPortfolio(null);
    } catch { /* the switcher just stays on Family */ }
  }

  toggle(m: Menu) { this.menu.set(this.menu() === m ? null : m); this.notify.open.set(false); }
  toggleBell() { this.menu.set(null); if (this.notify.open()) this.notify.close(); else this.notify.open.set(true); }
  pick(m: Member | null) {
    this.auth.selectPortfolio(m ? m.email : null);
    this.menu.set(null);
  }
  go(n: Notice) {
    this.notify.close();
    const [path, frag] = (n.link ?? '/').split('#');
    this.router.navigate([path], { fragment: frag || undefined });
  }
  noticeIcon = (n: Notice) => ({ festival: 'diya', tax: 'receipt', fy: 'calendar', personal: 'target', insight: 'bulb' } as Record<string, string>)[n.kind] ?? 'info';
  when = (n: Notice) => n.days === null ? '' : n.days === 0 ? 'Today' : n.days === 1 ? 'Tomorrow' : `In ${n.days} days`;
}
