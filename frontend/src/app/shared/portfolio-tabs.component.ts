import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { inrCompact } from '../core/format';
import { AssetClass, CLASS_COLOR } from '../core/models';
import { StoreService } from '../core/store.service';

export type PortfolioTab = 'holdings' | 'performance' | 'risk';

/** Where the Holdings tab, the nav Portfolio slot, the `/holdings` redirect and Home's fallback links land (G14). */
export const PORTFOLIO_HOLDINGS_HOME = '/holdings/all';

const TABS: { key: PortfolioTab; label: string; path: string }[] = [
  { key: 'holdings', label: 'Holdings', path: PORTFOLIO_HOLDINGS_HOME },
  { key: 'performance', label: 'Performance', path: '/performance' },
  { key: 'risk', label: 'Risk & mix', path: '/risk' },
];

/** Holdings class chips (Part 1 §3.3), in a fixed order. */
const CLASSES: { path: string; label: string; cls: AssetClass; noun: string }[] = [
  { path: '/holdings/equity', label: 'Stocks', cls: 'equity', noun: 'stock' },
  { path: '/holdings/mutual_fund', label: 'Mutual funds', cls: 'mutual_fund', noun: 'mutual fund' },
  { path: '/holdings/commodity', label: 'Gold & silver', cls: 'commodity', noun: 'gold or silver holding' },
  { path: '/p2p', label: 'P2P', cls: 'p2p', noun: 'P2P loan' },
  { path: '/fixed-deposits', label: 'FDs', cls: 'fixed_deposit', noun: 'fixed deposit' },
  { path: '/forex', label: 'USD wallet', cls: 'cash', noun: 'USD transfer' },
  { path: '/epf', label: 'EPF', cls: 'epf', noun: 'EPF entry' },
  { path: '/nps', label: 'NPS', cls: 'nps', noun: 'NPS contribution' },
];

/**
 * Portfolio hub navigation: Holdings | Performance | Risk & mix, plus the class chips under Holdings.
 * In `route` mode (default) the tabs link to their pages and the active one follows the URL.
 * In `query` mode the tabs are in-page and synced to `?tab=` with `replaceUrl`, so Back leaves the page.
 * Classes with nothing in them are greyed under "+ more"; each still opens its page and its empty state.
 */
@Component({
  selector: 'app-portfolio-tabs',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="tabs" aria-label="Portfolio">
      @for (t of tabs; track t.key) {
        @if (mode() === 'query') {
          <button type="button" [class.on]="t.key === current()" [attr.aria-current]="t.key === current() ? 'page' : null" (click)="pick(t.key)">{{ t.label }}</button>
        } @else {
          <a [routerLink]="t.path" [class.on]="t.key === current()" [attr.aria-current]="t.key === current() ? 'page' : null">{{ t.label }}</a>
        }
      }
    </nav>
    @if (chips() && current() === 'holdings') {
      <nav class="class-chips" aria-label="Asset classes">
        @if (withAll()) { <a routerLink="/holdings/all" class="cc" [class.on]="path() === '/holdings/all'" [attr.aria-current]="path() === '/holdings/all' ? 'page' : null">All</a> }
        @for (c of held(); track c.path) {
          <a [routerLink]="c.path" class="cc" [class.on]="c.path === path()" [attr.aria-current]="c.path === path() ? 'page' : null"><i class="dot" [style.background]="c.color"></i>{{ c.label }}@if (c.value) { <span class="v">{{ c.value }}</span> }</a>
        }
        @if (empty().length) {
          <button type="button" class="cc more" (click)="more.set(!more())" [attr.aria-expanded]="more()">{{ more() ? '− less' : '+ more' }}</button>
          @if (more()) {
            @for (c of empty(); track c.path) {
              <a [routerLink]="c.path" class="cc empty-cls" [class.on]="c.path === path()" [attr.aria-current]="c.path === path() ? 'page' : null" [attr.title]="'Add your first ' + c.noun">{{ c.label }}</a>
            }
          }
        }
      </nav>
    }`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .class-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .cc { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text-2); font-size: 13px; font-weight: 500; text-decoration: none; cursor: pointer; white-space: nowrap; }
    .cc:hover { border-color: var(--border-strong); color: var(--text); text-decoration: none; }
    .cc.on { border-color: var(--primary); color: var(--text); font-weight: 600; box-shadow: inset 0 0 0 1px var(--primary); }
    .cc.more { border-style: dashed; color: var(--muted); }
    .cc.empty-cls { color: var(--muted); background: var(--surface-2); }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
    .v { color: var(--muted); font-weight: 400; font-size: 12px; }
  `],
})
export class PortfolioTabsComponent {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private store = inject(StoreService);

  /** 'route' links to /holdings, /performance and /risk; 'query' keeps the tabs in-page on `?tab=`. */
  mode = input<'route' | 'query'>('route');
  /** Forces the active tab; otherwise it follows the URL. */
  active = input<PortfolioTab | null>(null);
  /** Show the class chips under Holdings. */
  chips = input(true);
  /** Show the "All" chip that opens /holdings/all (on by default since W3-F1; G14). */
  withAll = input(true);
  /** In `query` mode: the tab the user picked. */
  tabChange = output<PortfolioTab>();

  readonly tabs = TABS;
  more = signal(false);

  private url = toSignal(this.router.events.pipe(
    filter(e => e instanceof NavigationEnd),
    map(e => (e as NavigationEnd).urlAfterRedirects),
    startWith(this.router.url),
  ), { initialValue: this.router.url });
  private queryTab = toSignal(this.route.queryParamMap.pipe(map(q => q.get('tab'))), { initialValue: null });

  path = computed(() => this.url().split(/[?#]/)[0]);
  current = computed<PortfolioTab>(() => {
    const forced = this.active();
    if (forced) return forced;
    if (this.mode() === 'query') {
      const q = this.queryTab();
      return q === 'performance' || q === 'risk' ? q : 'holdings';
    }
    const p = this.path();
    return p.startsWith('/performance') ? 'performance' : p.startsWith('/risk') ? 'risk' : 'holdings';
  });

  private classes = computed(() => {
    const pos = this.store.positions();
    return CLASSES.map(c => {
      const v = pos.filter(p => p.asset_class === c.cls && p.is_open).reduce((a, p) => a + p.value, 0);
      return { ...c, color: CLASS_COLOR[c.cls], value: v > 0 ? inrCompact(v) : '', has: v > 0 };
    });
  });
  held = computed(() => this.classes().filter(c => c.has || c.path === this.path()));
  empty = computed(() => this.classes().filter(c => !c.has && c.path !== this.path()));

  /** `query` mode: switch tab in place, replacing the history entry. */
  pick(tab: PortfolioTab) {
    if (tab === this.current()) return;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab }, queryParamsHandling: 'merge', replaceUrl: true });
    this.tabChange.emit(tab);
  }
}
