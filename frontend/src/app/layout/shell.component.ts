import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { relTime } from '../core/format';
import { StoreService } from '../core/store.service';
import { ThemeService } from '../core/theme.service';
import { TxnDialogService } from '../core/txn-dialog.service';
import { IconComponent } from '../shared/icon.component';
import { TxnFormComponent } from '../shared/txn-form.component';

interface NavItem { path: string; label: string; icon: string; exact?: boolean; }

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, TxnFormComponent],
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
  private route = inject(ActivatedRoute);

  moreOpen = signal(false);
  menuOpen = signal(false);

  groups: { title: string; items: NavItem[] }[] = [
    { title: '', items: [{ path: '/', label: 'Overview', icon: 'home', exact: true }] },
    { title: 'Holdings', items: [
      { path: '/holdings/equity', label: 'Stocks', icon: 'trend' },
      { path: '/holdings/mutual_fund', label: 'Mutual funds', icon: 'layers' },
      { path: '/holdings/commodity', label: 'Commodities', icon: 'coins' },
      { path: '/p2p', label: 'P2P lending', icon: 'users' },
      { path: '/fixed-deposits', label: 'Fixed deposits', icon: 'bank' },
      { path: '/forex', label: 'USD wallet', icon: 'globe' },
    ] },
    { title: 'Activity', items: [
      { path: '/transactions', label: 'Transactions', icon: 'list' },
      { path: '/cash-flows', label: 'Cash flows', icon: 'wallet' },
    ] },
    { title: 'Analysis', items: [
      { path: '/analytics', label: 'Performance', icon: 'chart' },
      { path: '/tax', label: 'Tax', icon: 'receipt' },
      { path: '/goals', label: 'Goals', icon: 'target' },
      { path: '/insights', label: 'Insights', icon: 'bulb' },
    ] },
    { title: '', items: [{ path: '/settings', label: 'Settings', icon: 'settings' }] },
  ];

  private title$ = this.router.events.pipe(
    filter(e => e instanceof NavigationEnd),
    map(() => {
      let r = this.route.firstChild;
      while (r?.firstChild) r = r.firstChild;
      return (r?.snapshot.data['title'] as string) ?? '';
    }),
  );
  title = toSignal(this.title$, { initialValue: '' });

  pricesAge = computed(() => relTime(this.store.portfolio()?.prices.last_refresh));
  themeIcon = computed(() => ({ system: 'monitor', light: 'sun', dark: 'moon' })[this.theme.mode()]);
  initials = computed(() => (this.auth.user()?.name || this.auth.user()?.email || '?').slice(0, 1).toUpperCase());

  constructor() {
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => {
      this.moreOpen.set(false);
      this.menuOpen.set(false);
    });
  }
}
