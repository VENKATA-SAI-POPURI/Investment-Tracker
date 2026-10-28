import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { relTime } from '../core/format';
import { StoreService } from '../core/store.service';
import { ThemeService } from '../core/theme.service';
import { TxnDialogService } from '../core/txn-dialog.service';
import { IconComponent } from '../shared/icon.component';
import { TxnFormComponent } from '../shared/txn-form.component';

interface NavItem { path: string; label: string; icon: string; match: string[]; }

export const NAV: NavItem[] = [
  { path: '/', label: 'Overview', icon: 'home', match: [] },
  { path: '/holdings/equity', label: 'Holdings', icon: 'layers', match: ['/holdings', '/holding/', '/p2p', '/fixed-deposits', '/forex'] },
  { path: '/transactions', label: 'Activity', icon: 'list', match: ['/transactions', '/cash-flows'] },
  { path: '/analytics', label: 'Performance', icon: 'chart', match: ['/analytics'] },
  { path: '/tax', label: 'Tax', icon: 'receipt', match: ['/tax'] },
  { path: '/goals', label: 'Goals', icon: 'target', match: ['/goals'] },
  { path: '/insights', label: 'Insights', icon: 'bulb', match: ['/insights'] },
  { path: '/settings', label: 'Settings', icon: 'settings', match: ['/settings'] },
];

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
  theme = inject(ThemeService);
  dialog = inject(TxnDialogService);
  private router = inject(Router);

  nav = NAV;
  mobileNav = [NAV[0], NAV[1], NAV[6]];
  menuOpen = signal(false);

  url = toSignal(this.router.events.pipe(
    filter(e => e instanceof NavigationEnd),
    map(e => (e as NavigationEnd).urlAfterRedirects.split(/[?#]/)[0]),
    startWith(this.router.url.split(/[?#]/)[0]),
  ), { initialValue: '/' });

  active = (item: NavItem) => {
    const u = this.url();
    return item.match.length ? item.match.some(m => u.startsWith(m)) : u === '/';
  };
  title = computed(() => this.nav.find(n => this.active(n))?.label ?? '');
  pricesAge = computed(() => relTime(this.store.portfolio()?.prices.last_refresh));
  themeIcon = computed(() => ({ system: 'monitor', light: 'sun', dark: 'moon' })[this.theme.mode()]);
  initials = computed(() => (this.auth.user()?.name || this.auth.user()?.email || '?').slice(0, 1).toUpperCase());

  constructor() {
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => this.menuOpen.set(false));
  }
}
