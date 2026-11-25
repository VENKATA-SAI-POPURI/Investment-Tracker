import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { fmtDate, money, pctV, usd } from '../../core/format';
import { GROUP_HEX, GroupKey, groupMeta } from '../../core/groups';
import { holdingLine, initials, logoColor } from '../../core/holding-view';
import { Position } from '../../core/models';
import { OverviewService } from '../../core/overview.service';
import { StoreService } from '../../core/store.service';
import { AuthService } from '../../core/auth.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { HoldingSheetComponent } from '../../shared/v2/holding-sheet.component';

/** A card on the page: Equity joins India and Global stocks; every other card is one group. */
interface CardDef { key: string; label: string; icon: string; color: string; groups: GroupKey[]; }
const CARDS: CardDef[] = [
  { key: 'equity', label: 'Equity', icon: 'trendUp', color: 'var(--g-equity_india)', groups: ['equity_india', 'equity_global'] },
  { key: 'mutual_funds', label: 'Mutual funds', icon: 'pieChart', color: 'var(--g-mutual_funds)', groups: ['mutual_funds'] },
  { key: 'p2p', label: 'P2P', icon: 'handshake', color: 'var(--g-p2p)', groups: ['p2p'] },
  { key: 'commodities', label: 'Commodities', icon: 'gem', color: 'var(--g-commodities)', groups: ['commodities'] },
  { key: 'epf', label: 'EPF', icon: 'piggy', color: 'var(--g-epf)', groups: ['epf'] },
  { key: 'others', label: 'Others', icon: 'layers', color: 'var(--g-others)', groups: ['others'] },
];
const SUB_LABEL: Partial<Record<GroupKey, string>> = { equity_india: 'India', equity_global: 'Global' };
const SHOW = 5;
const MARKET_CARDS = ['equity', 'mutual_funds', 'commodities'];

interface Section { group: GroupKey; label: string | null; value: number; rows: Position[]; hidden: number; }
interface Card extends CardDef { value: number; pct: number; change: string | null; tone: 'gain' | 'loss' | 'mut'; count: number; summary: string; sections: Section[]; }

/** Everything you own, grouped the same way everywhere (redesign). A holding opens in a sheet. */
@Component({
  selector: 'app-portfolio',
  standalone: true,
  imports: [IconComponent, HoldingSheetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="v2">
    <section class="v-card summary">
      <div class="sum">
        <div><div class="v-mut lb">Total value</div><div class="v-num big">{{ money(total()) }}</div></div>
        <div class="right"><div class="v-mut lb">Total gain · return a year</div>
          <div class="v-num gain" [class.v-gain]="gain() >= 0" [class.v-loss]="gain() < 0">{{ money(gain(), true) }}{{ xirr() !== null ? ' · ' + pctV(xirr()) : '' }}</div></div>
      </div>
      <div class="stack" aria-hidden="true">@for (s of stack(); track s.key) { <b [style.background]="s.color" [style.flex-grow]="s.value"></b> }</div>
    </section>

    <div class="v-filters" role="tablist" aria-label="Show">
      <button role="tab" [class.on]="filter() === 'all'" (click)="setFilter('all')">All</button>
      @for (c of cardsAll(); track c.key) {
        <button role="tab" [class.on]="filter() === c.key" (click)="setFilter(c.key)"><span class="d" [style.--c]="c.color"></span>{{ c.label }}</button>
      }
    </div>

    <div class="cards">
    @for (c of cards(); track c.key) {
      <section class="v-card grp" [class.open]="isOpen(c.key)">
        <button class="ghead" (click)="toggle(c.key)" [attr.aria-expanded]="isOpen(c.key)">
          <span class="v-ic lg" [style.--c]="c.color"><app-icon [name]="c.icon" [size]="20" /></span>
          <span class="grow"><span class="gn">{{ c.label }}</span><span class="gs">{{ c.summary }}</span></span>
          <span class="gr"><b>{{ money(c.value) }}</b>
            @if (c.change) { <span class="pct" [class.v-gain]="c.tone === 'gain'" [class.v-loss]="c.tone === 'loss'">{{ c.change }}</span> }</span>
          <app-icon class="chev" [name]="isOpen(c.key) ? 'chevronDown' : 'chevronRight'" [size]="18" [stroke]="2.2" />
        </button>
        @if (isOpen(c.key)) {
          @if (c.key === 'p2p') {
            <div class="cashrow">
              <span class="v-ic sm" style="--c:var(--g-p2p)"><app-icon name="wallet2" [size]="15" /></span>
              <span class="grow"><span class="n">P2P wallet</span><span class="s">Idle cash, not lent yet{{ topups() > 1 ? ' · ' + money(topups()) + ' of loans had no top-up' : '' }}</span></span>
              <b>{{ money(escrow()) }}</b>
              @if (auth.canWrite()) { <button class="v-btn sm" (click)="dialog.openWallet()">Add / withdraw</button> }
            </div>
          }
          @for (s of c.sections; track s.group) {
            @if (s.label) { <div class="subhd"><span>{{ s.label }} · {{ s.rows.length + s.hidden }}{{ s.group === 'equity_global' && usdCash() !== null ? ' · ' + usd(usdCash()) + ' cash' : '' }}</span><span>{{ money(s.value) }}</span></div> }
            @for (p of s.rows; track p.id) {
              <button class="hold" (click)="openHolding(p.id)">
                <span class="v-logo" [style.--c]="logo(p.name)">{{ ini(p.name) }}</span>
                <span class="grow"><span class="n">{{ p.name }}</span><span class="s">{{ line(p).sub }}</span></span>
                <span class="r"><b>{{ money(p.value) }}</b><span class="pct" [class]="'t-' + line(p).tone">{{ line(p).change }}</span></span>
              </button>
            }
            @if (s.hidden) { <button class="moreb" (click)="expand(s.group)">Show {{ s.hidden }} more</button> }
          } @empty { <p class="v-empty">Nothing here yet.</p> }
        }
      </section>
    } @empty {
      @if (!store.portfolio()) { @for (i of [1, 2, 3]; track i) { <div class="v-skel" style="height:76px"></div> } }
      @else { <div class="v-card v-empty">No holdings yet. Tap + to add your first.</div> }
    }
    </div>

    @if (closedCount()) {
      <button class="v-link closedt" (click)="showClosed.set(!showClosed())">{{ showClosed() ? 'Hide' : 'Show' }} {{ closedCount() }} sold or closed holding{{ closedCount() === 1 ? '' : 's' }}</button>
    }
  </div>
  @if (holdingId(); as id) { <v-holding-sheet [id]="id" (closed)="closeHolding()" /> }
  `,
  styles: [`
    .summary { background: var(--hero) !important; color: #fff; border: 1px solid rgba(255,255,255,.12) !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.16), 0 24px 50px -24px rgba(76,62,200,.6) !important; }
    .summary .lb { color: rgba(255,255,255,.7) !important; }
    .summary .v-gain { color: #bbf7d0; } .summary .v-loss { color: #fecdd3; }
    .summary .stack { background: rgba(255,255,255,.12); padding: 2px; height: 14px; }
    .summary .stack b { border-radius: 99px; }
    .sum { display: flex; justify-content: space-between; align-items: flex-end; gap: 10px; }
    .lb { font-size: 12.5px; font-weight: 600; }
    .big { font-size: 28px; }
    .right { text-align: right; }
    .gain { font-size: 18px; }
    .stack { display: flex; height: 12px; border-radius: 99px; overflow: hidden; gap: 2px; margin-top: 14px; }
    .stack b { flex-basis: 0; min-width: 3px; }
    .grp { padding: 13px 16px; }
    .ghead { display: flex; align-items: center; gap: 12px; width: 100%; background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; text-align: left; }
    .grow { min-width: 0; flex: 1; display: flex; flex-direction: column; }
    .gn { font-weight: 700; font-size: 15px; } .gs { font-size: 12.5px; color: var(--muted); font-weight: 500; }
    .gr { text-align: right; display: flex; flex-direction: column; }
    .gr b { font-size: 15px; font-weight: 800; }
    .pct { font-size: 12.5px; font-weight: 700; }
    .chev { color: var(--muted); }
    .subhd { font-size: 11.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin: 16px 0 4px;
      display: flex; justify-content: space-between; }
    .grp.open .ghead { margin-bottom: 4px; }
    .hold { display: flex; align-items: center; gap: 11px; width: 100%; padding: 10px 0; border: 0; border-top: 1px solid var(--border); background: none;
      font: inherit; color: inherit; text-align: left; cursor: pointer; }
    .hold .n { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hold .s { font-size: 12px; color: var(--muted); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hold .r { text-align: right; display: flex; flex-direction: column; flex: none; }
    .hold .r b { font-weight: 700; }
    .t-gain { color: var(--pos); } .t-loss { color: var(--neg); } .t-mut { color: var(--muted); } .t-warn { color: var(--warn); }
    .cashrow { display: flex; align-items: center; gap: 11px; flex-wrap: wrap; margin: 12px 0 2px; padding: 10px 12px; border-radius: 14px;
      background: rgba(251, 113, 133, .1); border: 1px solid rgba(251, 113, 133, .25); text-decoration: none; color: inherit; }
    .cashrow .n { font-weight: 700; font-size: 13.5px; } .cashrow .s { font-size: 11.5px; color: var(--muted); }
    .cashrow b { font-weight: 800; white-space: nowrap; }
    .cashrow .v-btn { flex: none; }
    .moreb { width: 100%; text-align: center; font: inherit; font-size: 13px; font-weight: 600; color: var(--accent); padding: 10px 0 2px; border: 0;
      border-top: 1px solid var(--border); background: none; cursor: pointer; }
    .closedt { align-self: center; margin-top: 4px; }
    .cards { display: block; }
    @media (min-width: 900px) {
      .cards { column-count: 2; column-gap: 14px; }
      .cards > * { break-inside: avoid; margin-bottom: 14px; display: block; }
    }
    @media (min-width: 900px) { .cards > .grp { display: block; } }
  `],
})
export class PortfolioComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private ovs = inject(OverviewService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  money = money; pctV = pctV; usd = usd; line = holdingLine; ini = initials; logo = logoColor;

  private qp = toSignal(this.route.queryParamMap.pipe(map(q => ({ group: q.get('group'), holding: q.get('holding') }))),
    { initialValue: { group: null as string | null, holding: null as string | null } });
  filter = computed(() => {
    const g = this.qp().group;
    if (!g) return 'all';
    return CARDS.find(c => c.key === g || c.groups.includes(g as GroupKey))?.key ?? 'all';
  });
  holdingId = computed(() => { const h = Number(this.qp().holding); return Number.isFinite(h) && h > 0 ? h : null; });

  showClosed = signal(false);
  private opened = signal<Set<string> | null>(null);
  private expanded = signal<Set<string>>(new Set());

  private positions = computed(() => this.store.positions().filter(p => p.status !== 'wallet' && (this.showClosed() || p.is_open || (p.asset_class === 'cash' && p.value > 0))));
  closedCount = computed(() => this.store.positions().filter(p => !p.is_open && p.asset_class !== 'cash' && p.status !== 'wallet').length);
  /** P2P escrow: Σ in − Σ out of the escrow account (as on the classic Cash flows page). */
  escrow = computed(() => this.store.positions().filter(p => p.status === 'wallet').reduce((s, p) => s + p.value, 0));
  topups = computed(() => this.store.positions().filter(p => p.status === 'wallet').reduce((s, p) => s + (p.wallet?.topups ?? 0), 0));
  /** Dollars in the USD wallet(s). */
  usdCash = computed(() => {
    const w = this.store.positions().filter(p => p.asset_class === 'cash');
    return w.length ? w.reduce((s, p) => s + (p.balance_usd ?? 0), 0) : null;
  });
  total = computed(() => this.ovs.data()?.totals.value ?? this.store.portfolio()?.totals.value ?? 0);
  gain = computed(() => this.ovs.data()?.totals.gain ?? this.store.portfolio()?.totals.total_gain ?? 0);
  xirr = computed(() => this.ovs.data()?.totals.xirr ?? null);
  stack = computed(() => (this.ovs.data()?.groups ?? []).filter(g => g.value > 0).map(g => ({ key: g.key, value: g.value, color: GROUP_HEX[g.key] })));

  cardsAll = computed<Card[]>(() => {
    const groups = new Map((this.ovs.data()?.groups ?? []).map(g => [g.key, g]));
    const total = this.total() || 1;
    const out: Card[] = [];
    for (const def of CARDS) {
      const pos = this.positions().filter(p => def.groups.includes((p.group ?? groupMeta(null).key) as GroupKey));
      if (!pos.length) continue;
      const sections: Section[] = def.groups.map(g => {
        const rows = pos.filter(p => p.group === g).sort((a, b) => b.value - a.value);
        const big = this.expanded().has(g) ? rows : rows.slice(0, SHOW);
        return { group: g, label: def.groups.length > 1 ? SUB_LABEL[g] ?? null : null, value: rows.reduce((s, p) => s + p.value, 0),
          rows: big, hidden: rows.length - big.length };
      }).filter(s => s.rows.length || s.hidden);
      // the P2P card includes the wallet's idle cash (it is part of P2P, and of net worth)
      const value = pos.reduce((s, p) => s + p.value, 0) + (def.key === 'p2p' ? this.escrow() : 0);
      const count = pos.filter(p => p.asset_class !== 'cash').length;
      // Market-priced groups: gain on the cost of what you hold now (what a broker shows). Deposits, loans and EPF:
      // the yearly return, because their "gain on money put in" shrinks its base with every repayment or withdrawal.
      let change: string | null = null, tone: Card['tone'] = 'mut';
      if (MARKET_CARDS.includes(def.key)) {
        const open = pos.filter(p => p.is_open && p.asset_class !== 'cash');
        const cost = open.reduce((s, p) => s + p.cost, 0), unr = open.reduce((s, p) => s + (p.unrealized || 0), 0);
        if (cost > 0) { change = pctV((unr / cost) * 100, 1, true); tone = unr >= 0 ? 'gain' : 'loss'; }
      } else {
        const g = groups.get(def.groups[0]);
        if (g?.xirr !== null && g?.xirr !== undefined) { change = pctV(g.xirr) + ' a yr'; tone = g.xirr >= 0 ? 'gain' : 'loss'; }
      }
      out.push({ ...def, value, pct: (value / total) * 100, count, sections, change, tone,
        summary: this.summary(def, pos, count, (value / total) * 100) });
    }
    return out;
  });
  cards = computed(() => this.filter() === 'all' ? this.cardsAll() : this.cardsAll().filter(c => c.key === this.filter()));

  isOpen(key: string): boolean {
    const o = this.opened();
    if (o) return o.has(key);
    return this.filter() !== 'all' || key === this.cardsAll()[0]?.key;
  }

  toggle(key: string) {
    const cur = new Set(this.cards().filter(c => this.isOpen(c.key)).map(c => c.key));
    if (cur.has(key)) cur.delete(key); else cur.add(key);
    this.opened.set(cur);
  }

  expand(g: string) { this.expanded.update(s => new Set(s).add(g)); }

  setFilter(key: string) {
    this.opened.set(null);
    void this.router.navigate([], { queryParams: { group: key === 'all' ? null : key }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  openHolding(id: number) { void this.router.navigate([], { queryParams: { holding: id }, queryParamsHandling: 'merge' }); }
  closeHolding() { void this.router.navigate([], { queryParams: { holding: null }, queryParamsHandling: 'merge', replaceUrl: true }); }

  private summary(def: CardDef, pos: Position[], count: number, pct: number): string {
    const share = ` · ${pct.toFixed(1)}%`;
    switch (def.key) {
      case 'equity': return `${pos.some(p => p.group === 'equity_global') ? 'India & Global' : 'India'} · ${count} stock${count === 1 ? '' : 's'}`;
      case 'mutual_funds': return `${count} fund${count === 1 ? '' : 's'}${share}`;
      case 'p2p': {
        const late = pos.filter(p => (p.emis_behind ?? 0) > 0).length;
        const asOf = pos.find(p => p.data_as_of)?.data_as_of;
        return `${count} loan${count === 1 ? '' : 's'}${late ? ` · ${late} behind` : ''}${asOf ? ` · repayments to ${fmtDate(asOf, false)}` : share}`;
      }
      case 'epf': return `${count} account${count === 1 ? '' : 's'}${share}`;
      case 'others': {
        const fd = pos.filter(p => p.asset_class === 'fixed_deposit').length, nps = pos.some(p => p.asset_class === 'nps');
        return [fd ? `${fd} FD${fd > 1 ? 's' : ''}` : '', nps ? 'NPS' : ''].filter(Boolean).join(' · ') + share;
      }
      default: return `${count} holding${count === 1 ? '' : 's'}${share}`;
    }
  }
}
