import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { IconComponent } from './icon.component';
import { PORTFOLIO_HOLDINGS_HOME } from './portfolio-tabs.component';
import { linkUnder } from './priority/priority';

/** One destination. `match` lists the path prefixes on which it shows as the current place ('/' matches only Home). */
export interface NavItem {
  key: 'home' | 'portfolio' | 'plan' | 'actions' | 'markets' | 'activity' | 'tax' | 'reports' | 'settings';
  path: string;
  label: string;
  icon: string;
  match: string[];
  hint?: string;
}

/** The five slots, in the order of the question ladder (SPEC Part 1 §3.1). */
export const PRIMARY_NAV: NavItem[] = [
  { key: 'home', path: '/', label: 'Home', icon: 'home', match: ['/'] },
  {
    key: 'portfolio', path: PORTFOLIO_HOLDINGS_HOME, label: 'Portfolio', icon: 'layers',
    match: ['/holdings', '/holding/', '/p2p', '/fixed-deposits', '/forex', '/epf', '/nps', '/performance', '/risk'],
  },
  { key: 'plan', path: '/plan', label: 'Plan', icon: 'target', match: ['/plan', '/goals', '/forecast'] },
  { key: 'actions', path: '/actions', label: 'Actions', icon: 'bulb', match: ['/actions', '/insights'] },
  { key: 'markets', path: '/markets', label: 'Markets', icon: 'zap', match: ['/markets'] },
];

/** The More popover and the drawer's Tools section. */
export const TOOLS_NAV: NavItem[] = [
  { key: 'activity', path: '/transactions', label: 'Activity', icon: 'list', match: ['/transactions', '/cash-flows', '/recurring', '/import'],
    hint: 'Transactions, cash flows, recurring plans, imports' },
  { key: 'tax', path: '/tax', label: 'Tax', icon: 'receipt', match: ['/tax'], hint: 'FY estimate, ways to save, what-if sale' },
  { key: 'reports', path: '/reports', label: 'Reports', icon: 'file', match: ['/reports'], hint: 'Exportable tables for any year or holding' },
  { key: 'settings', path: '/settings', label: 'Settings', icon: 'settings', match: ['/settings', '/admin'], hint: 'Profile, alerts, prices and family' },
];

/** The ≤760px bottom bar: Home · Portfolio · (+) · Plan · Actions (§3.2). Markets and the tools sit in the drawer. */
const BOTTOM_LEFT: NavItem['key'][] = ['home', 'portfolio'];
const BOTTOM_RIGHT: NavItem['key'][] = ['plan', 'actions'];

/** Is `item` the current place for this path (no query or fragment)? */
export function navActive(item: NavItem, path: string): boolean {
  return item.match.some(m => linkUnder(path, m));
}

/** What the shell computes once and every rendering of the list shows. */
export interface NavBadges {
  /** Actions: count_now + count_month; urgent (red) when count_now > 0. */
  actions: { count: number; urgent: boolean };
  /** Plan: a red dot when the brief's plan status is act. */
  planAct: boolean;
  /** Tax: "N days left" from January to March while tax actions are open; otherwise null. */
  tax: string | null;
  /** Markets: an amber dot while the brief's `market_state.mode` is correction or crash (§3.1, H17); otherwise null. */
  markets: 'correction' | 'crash' | null;
}

export const NO_BADGES: NavBadges = { actions: { count: 0, urgent: false }, planAct: false, tax: null, markets: null };

/** Spoken and hover text for the Markets dot: the mode in words, never colour alone. */
export function marketsBadgeLabel(mode: NavBadges['markets']): string {
  return mode === 'crash' ? 'Markets: in a crash — see what it means for you' : mode === 'correction' ? 'Markets: in a correction — see what it means for you' : '';
}

export type NavListMode = 'bar' | 'popover' | 'drawer' | 'bottom';

/**
 * The one source of navigation (§3.2): the desktop slots, the More popover, the drawer and the bottom bar
 * all render from PRIMARY_NAV and TOOLS_NAV through this component, so labels, matches and badges never drift.
 * The shell owns the containers (positioning, open/close); this renders the entries.
 */
@Component({
  selector: 'app-nav-list',
  standalone: true,
  imports: [RouterLink, NgTemplateOutlet, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': "'nav-' + mode()" },
  template: `
    @switch (mode()) {
      @case ('bar') {
        @for (it of primary; track it.key) {
          <a [routerLink]="it.path" class="nl" [class.on]="on(it)" [attr.aria-current]="on(it) ? 'page' : null" (click)="picked.emit()">
            {{ it.label }}<ng-container *ngTemplateOutlet="badge; context: { $implicit: it }" />
          </a>
        }
      }
      @case ('popover') {
        @for (it of tools; track it.key) {
          <a class="pop-item" role="menuitem" [routerLink]="it.path" [class.on]="on(it)" [attr.aria-current]="on(it) ? 'page' : null" (click)="picked.emit()">
            <span class="chip sm indigo"><app-icon [name]="it.icon" [size]="15" /></span>
            <span class="pi-text"><b>{{ it.label }}</b><small>{{ it.hint }}</small></span>
            <ng-container *ngTemplateOutlet="badge; context: { $implicit: it }" />
          </a>
        }
      }
      @case ('drawer') {
        @for (it of primary; track it.key) {
          <a [routerLink]="it.path" class="dl" [class.on]="on(it)" [attr.aria-current]="on(it) ? 'page' : null" (click)="picked.emit()">
            <app-icon [name]="it.icon" [size]="17" /><span class="dl-label">{{ it.label }}</span>
            <ng-container *ngTemplateOutlet="badge; context: { $implicit: it }" />
          </a>
        }
        <div class="drawer-sep">Tools</div>
        @for (it of tools; track it.key) {
          <a [routerLink]="it.path" class="dl" [class.on]="on(it)" [attr.aria-current]="on(it) ? 'page' : null" (click)="picked.emit()">
            <app-icon [name]="it.icon" [size]="17" /><span class="dl-label">{{ it.label }}<small>{{ it.hint }}</small></span>
            <ng-container *ngTemplateOutlet="badge; context: { $implicit: it }" />
          </a>
        }
      }
      @case ('bottom') {
        @for (it of bottomLeft; track it.key) { <ng-container *ngTemplateOutlet="tab; context: { $implicit: it }" /> }
        @if (canAdd()) {
          <button class="fab" type="button" (click)="add.emit()" aria-label="Add a transaction"><app-icon name="plus" [size]="22" /></button>
        }
        @for (it of bottomRight; track it.key) { <ng-container *ngTemplateOutlet="tab; context: { $implicit: it }" /> }
      }
    }

    <ng-template #tab let-it>
      <a [routerLink]="it.path" class="bt" [class.on]="on(it)" [attr.aria-current]="on(it) ? 'page' : null" (click)="picked.emit()">
        <span class="bt-ic"><app-icon [name]="it.icon" />
          @if (it.key === 'actions' && badges().actions.count) {
            <span class="count" [class.urgent]="badges().actions.urgent" [attr.aria-label]="countLabel()">{{ countText() }}</span>
          } @else if (it.key === 'plan' && badges().planAct) { <span class="dot-act" role="img" aria-label="A plan needs action"></span>
          } @else if (it.key === 'markets' && badges().markets) {
            <span class="dot-watch" role="img" [attr.aria-label]="marketsLabel()" [attr.title]="marketsLabel()"></span> }
        </span>
        <span>{{ it.label }}</span>
      </a>
    </ng-template>

    <ng-template #badge let-it>
      @switch (it.key) {
        @case ('actions') {
          @if (badges().actions.count) {
            <span class="count" [class.urgent]="badges().actions.urgent" [attr.aria-label]="countLabel()">{{ countText() }}</span>
          }
        }
        @case ('plan') {
          @if (badges().planAct) { <span class="dot-act" role="img" aria-label="A plan needs action"></span> }
        }
        @case ('tax') {
          @if (badges().tax; as t) { <span class="days">{{ t }}</span> }
        }
        @case ('markets') {
          @if (badges().markets) { <span class="dot-watch" role="img" [attr.aria-label]="marketsLabel()" [attr.title]="marketsLabel()"></span> }
        }
      }
    </ng-template>
  `,
  styles: [`
    :host(.nav-bar), :host(.nav-bottom) { display: contents; }
    :host(.nav-popover), :host(.nav-drawer) { display: block; }

    .count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
      font-size: 10.5px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; background: rgba(255, 255, 255, .16); color: #fff; }
    .count.urgent { background: #e5484d; color: #fff; }
    .dot-act { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #e5484d; box-shadow: 0 0 0 2px var(--ink); }
    .dot-watch { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--status-warning); box-shadow: 0 0 0 2px var(--ink); flex: none; }
    .days { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--st-act-soft); color: var(--st-act); white-space: nowrap; }

    /* desktop slots, on the navy bar */
    .nl { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 62px; padding: 0 14px; color: rgba(255, 255, 255, .72);
      font-size: 14px; font-weight: 500; line-height: 1; white-space: nowrap; text-decoration: none; }
    .nl:hover { color: #fff; text-decoration: none; }
    .nl.on { color: #fff; font-weight: 600; }
    .nl.on::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: 0; height: 3px; border-radius: 3px 3px 0 0; background: var(--gold-2); }
    .nl .dot-act, .nl .dot-watch { margin-left: -2px; align-self: flex-start; margin-top: 20px; }
    @media (max-width: 1400px) { .nl { padding: 0 11px; } }
    @media (max-width: 1180px) { .nl { padding: 0 9px; } }

    /* More popover, on white */
    .pop-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border-radius: 8px; color: var(--text);
      text-decoration: none; font-size: 13px; }
    .pop-item:hover { background: var(--surface-hover); text-decoration: none; }
    .pop-item.on { background: var(--accent-soft); }
    .pi-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .pi-text b { font-weight: 600; font-size: 13.5px; }
    .pi-text small { color: var(--muted); font-size: 12px; }

    /* drawer, on navy */
    .dl { display: flex; align-items: center; gap: 12px; padding: 11px 12px; border-radius: 9px; color: rgba(255, 255, 255, .78); text-decoration: none; font-size: 14px; }
    .dl:hover { background: rgba(255, 255, 255, .06); text-decoration: none; color: #fff; }
    .dl.on { background: rgba(255, 255, 255, .1); color: #fff; font-weight: 600; }
    .dl.on app-icon { color: var(--gold-2); }
    .dl-label { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .dl-label small { font-size: 11.5px; font-weight: 400; color: rgba(255, 255, 255, .5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .drawer-sep { padding: 16px 12px 6px; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: rgba(255, 255, 255, .45); }

    /* ≤760px bottom bar, on white */
    .bt { flex: 1 1 0; display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; padding: 6px 4px; font-size: 11px;
      color: var(--muted); text-decoration: none; }
    .bt:hover { text-decoration: none; }
    .bt.on { color: var(--primary); font-weight: 600; }
    .bt-ic { position: relative; display: inline-flex; }
    .bt-ic .count { position: absolute; top: -6px; left: 14px; border: 2px solid var(--surface); height: 19px; background: var(--muted); }
    .bt-ic .count.urgent { background: #e5484d; }
    .bt-ic .dot-act, .bt-ic .dot-watch { position: absolute; top: -2px; right: -4px; box-shadow: 0 0 0 2px var(--surface); }
    .fab { flex: none; width: 50px; height: 50px; border-radius: 16px; border: 0; background: var(--primary); color: #fff; display: inline-flex;
      align-items: center; justify-content: center; box-shadow: 0 8px 20px rgba(63, 60, 187, .35); margin: -18px 6px 0; cursor: pointer; }
  `],
})
export class NavListComponent {
  readonly mode = input.required<NavListMode>();
  /** Current path, without query or fragment. */
  readonly url = input('/');
  readonly badges = input<NavBadges>(NO_BADGES);
  /** Show the (+) button in the bottom bar (writers only). */
  readonly canAdd = input(false);
  /** Any entry was chosen, including the page already open: close the drawer or popover. */
  readonly picked = output<void>();
  readonly add = output<void>();

  readonly primary = PRIMARY_NAV;
  readonly tools = TOOLS_NAV;
  readonly bottomLeft = PRIMARY_NAV.filter(n => BOTTOM_LEFT.includes(n.key));
  readonly bottomRight = PRIMARY_NAV.filter(n => BOTTOM_RIGHT.includes(n.key));

  /** "3", or "3!" when some are tier now: the urgent state is never colour alone (§1.8). */
  readonly countText = computed(() => {
    const { count, urgent } = this.badges().actions;
    return (count > 99 ? '99+' : String(count)) + (urgent ? '!' : '');
  });
  readonly countLabel = computed(() => {
    const { count, urgent } = this.badges().actions;
    return `${count} to do${urgent ? ', some now' : ''}`;
  });
  readonly marketsLabel = computed(() => marketsBadgeLabel(this.badges().markets));
  on = (it: NavItem) => navActive(it, this.url());
}
