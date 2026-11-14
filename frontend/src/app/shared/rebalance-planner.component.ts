import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../core/api.service';
import { FORMAT_PIPES, inr as fmtInr, qty as fmtQty } from '../core/format';
import { errorMessage } from '../core/http';
import { Position, RebalancePlan, RebalanceRow, SaleLeg, SEGMENT_COLOR } from '../core/models';
import { StoreService } from '../core/store.service';
import { TxnDialogService } from '../core/txn-dialog.service';
import { IconComponent } from './icon.component';
import { EstTagComponent } from './priority/est-tag.component';

/** Segments that cannot be sold or topped up at will: they are moved by redirecting maturities (SPEC §5.1, P2.8). */
const MATURING = new Set(['Fixed Deposits', 'P2P']);
/** Percentage points within which an over-weight maturing segment still counts as on target. */
const OVER_PTS = 0.5;
/** Holdings whose sale `GET /tax/what-if` can price (H8). */
const SELLABLE = new Set(['equity', 'mutual_fund', 'commodity']);

type Badge = { kind: 'add' | 'trim' | 'hold' | 'redirect' | 'locked'; amount: number | null };

/** Why `tax.plan_sales` picked a sale (K12), in words: losses first, then long-term gains inside the exemption, then the rest. */
export const SALE_ORDER_WORD: Record<SaleLeg['order'], string> = {
  loss: 'loss',
  lt_exempt: 'tax-free long-term gain',
  other: 'other',
};

/** "tax ₹X" for a tax, "saves ₹X" when it is negative (tax saved by booking a loss). */
export function taxWords(tax: number, fmt: (v: number) => string): string {
  return tax < 0 ? `saves ${fmt(-tax)}` : `tax ${fmt(tax)}`;
}

/** The server already costed this sell row with the ledger (K13), so J9's per-row what-if call is not needed. */
export function hasServerTax(r: Pick<RebalanceRow, 'tax_if_sold'>): r is { tax_if_sold: number } {
  return typeof r.tax_if_sold === 'number' && isFinite(r.tax_if_sold);
}

/** "Tax if sold" for one trim row (J9), cached per (segment, amount). */
export type TaxIfSold =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'error'; message: string }
  | { state: 'ok'; instrumentId: number; name: string; qty: number; tax: number };

/**
 * The holding "Tax if sold" prices for a segment: its open holding with a price and the largest value (J9).
 * Only equity, mutual-fund and commodity holdings can be priced by the what-if API.
 */
export function largestSellable(positions: Position[], segment: string): Position | null {
  let best: Position | null = null;
  for (const p of positions) {
    if (p.segment !== segment || !p.is_open || !p.has_price || !SELLABLE.has(p.asset_class)) continue;
    if (!(p.quantity && p.quantity > 0) || !(p.value > 0)) continue;
    if (!best || p.value > best.value) best = p;
  }
  return best;
}

/**
 * Units of `p` worth `amount` at its current value: min(quantity, amount / (value / quantity)), rounded **up** to
 * whole units for equity and commodity and to 0.001 for funds, and never more than is held (J9).
 */
export function unitsFor(p: Pick<Position, 'quantity' | 'value' | 'asset_class'>, amount: number): number {
  const q = p.quantity ?? 0;
  if (q <= 0 || !(p.value > 0) || !(amount > 0)) return 0;
  const raw = Math.min(q, amount / (p.value / q));
  const step = p.asset_class === 'mutual_fund' ? 1000 : 1;
  const up = Math.ceil(raw * step - 1e-9) / step;
  return Math.min(q, up);
}

let nextId = 0;

/**
 * Where new money should go, by asset class, to move toward the target mix (SPEC §5.1 Deploy money, §5.6 Get back
 * on target). Segment level only: it never picks a fund (A33).
 *
 * Inputs are the starting point; the user can change the amount and the "Allow selling" toggle here. The four inputs
 * are a contract with Actions, Recurring and Risk & mix (AMENDMENTS J2): never rename, remove or retype them.
 * - `newMoney`: the amount to place; the Actions page passes `brief.deploy.suggested` or `?new_money=`.
 * - `allowSell`: start with trims allowed.
 * - `useNet`: true when `newMoney` is the brief default, so `GET /rebalance` takes the money that is about to be freed
 *   out of the segments that still hold it (`net=deploy`, A15). Typing an amount drops it.
 * - `riskLink`: show "Open Risk & mix →" (off on the Risk page itself).
 *
 * P1 lines (J9), on every page that hosts the planner:
 * - while selling is off, `months_to_fix` (H14): 0 → "Nothing to fix without selling"; N → "At your SIP + maturity
 *   pace this closes in ~N months" (est.);
 * - a Trim row (never FD or P2P, which read "Redirect maturities") has "Tax if sold": it prices one sale of the
 *   segment's largest priced holding through `GET /tax/what-if` and offers "Plan the sale →" (the what-if modal).
 *
 * P2 lines (R16, K13), drawn from the `allow_sell` payload alone, so every host shows them without new inputs:
 * - a sell row the server costed carries `tax_if_sold` ("tax ₹X", or "saves ₹X" when negative; est.) and a
 *   collapsed list of its `sells` in pick order, each worded loss / tax-free long-term gain / other. Such a row
 *   skips J9's what-if call. `tax_total` and `tax_note` go in the footer;
 * - FD and P2P come as 'hold' with `let_mature`: the "Redirect maturities" badge (L3) plus "Let it mature ₹X";
 * - an over-target EPF or NPS comes as 'hold' with `locked`: "Locked (EPF/NPS)";
 * - `not_sold` > 0: "₹X left in maturity-only or locked money".
 * The no-sell plan carries none of these fields, so it renders exactly as before.
 *
 * It calls `GET /rebalance` through `ApiService.get` (E2), reloads when the store's data moves, and shows
 * loading, error and "no targets" states.
 */
@Component({
  selector: 'app-rebalance-planner',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, EstTagComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rp-controls">
      <div class="field rp-money">
        <label [attr.for]="uid + '-money'">New money</label>
        <div class="rp-input">
          <span class="rp-cur" aria-hidden="true">₹</span>
          <input [id]="uid + '-money'" class="input num" type="number" inputmode="numeric" min="0" step="1000"
            [ngModel]="money()" (ngModelChange)="typed($event)" />
        </div>
      </div>
      <label class="check small rp-sell"><input type="checkbox" [ngModel]="sell()" (ngModelChange)="sell.set(!!$event)" /> Allow selling</label>
      @if (edited()) {
        <button type="button" class="btn ghost sm" (click)="reset()"><app-icon name="refresh" [size]="14" /> Use {{ (newMoney() ?? 0) | inr }}</button>
      }
    </div>

    @let pl = plan();
    @if (error(); as e) {
      <div class="notice bad" role="alert"><app-icon name="alert" [size]="16" />
        <span>Couldn't plan the money · {{ e }}</span><span class="spacer"></span>
        <button type="button" class="btn sm" (click)="load()">Try again</button></div>
    } @else if (pl) {
      @if (pl.error) {
        <div class="notice warn"><app-icon name="target" [size]="16" />
          <span>{{ pl.error }}. The planner splits money by the target mix you choose.</span><span class="spacer"></span>
          <a class="nowrap" routerLink="/risk" fragment="mix">Set targets →</a></div>
      } @else {
        <div class="table-wrap" [class.loading-fade]="loading()">
          <table class="table rp-table">
            <caption class="sr-only">Plan for {{ pl.new_money | inr }} of new money{{ pl.allow_sell ? ', selling allowed' : ', no selling' }}</caption>
            <thead><tr>
              <th scope="col">Asset class</th><th scope="col" class="num">Value</th><th scope="col" class="num">Now</th>
              <th scope="col" class="num">Target</th><th scope="col">Move</th><th scope="col" class="num">After</th>
            </tr></thead>
            <tbody>
              @for (r of pl.rows; track r.segment) {
                @let b = badge(r);
                @let server = b.kind === 'trim' && serverTax(r);
                @let tx = b.kind === 'trim' && !server ? taxOf(r) : null;
                <tr>
                  <td><span class="row"><i class="swatch" [style.background]="colorOf(r.segment)"></i>{{ r.segment }}</span></td>
                  <td class="num">{{ r.current | inr }}</td>
                  <td class="num">{{ r.current_pct | pct: 1 : false }}</td>
                  <td class="num">{{ r.target_pct | pct: 1 : false }}</td>
                  <td><span class="rp-move">@switch (b.kind) {
                      @case ('add') { <span class="badge good"><app-icon name="arrowUp" [size]="12" />Add {{ b.amount | inr }}</span> }
                      @case ('trim') { <span class="badge bad"><app-icon name="arrowDown" [size]="12" />Trim {{ b.amount | inr }}</span>
                        @if (server) {
                          <span class="rp-taxed" [class.pos]="r.tax_if_sold! < 0">{{ taxText(r.tax_if_sold!) }}<app-est [basis]="planTaxBasis" /></span>
                        } @else if (!tx && canPrice(r)) {
                          <button type="button" class="rp-link" (click)="priceSale(r)" [attr.aria-label]="'Tax if you sell ' + (b.amount | inr) + ' of ' + r.segment">Tax if sold</button>
                        } }
                      @case ('redirect') { <span class="badge warn" title="Fixed deposits and P2P loans are not sold: let them mature and put the money where the mix is short">
                        <app-icon name="refresh" [size]="12" />Redirect maturities</span>
                        @if ((r.let_mature ?? 0) > 0) { <span class="rp-sub">Let it mature {{ r.let_mature | inr }}</span> } }
                      @case ('locked') { <span class="badge" title="EPF and NPS cannot be withdrawn at will: new money goes elsewhere instead">
                        <app-icon name="shield" [size]="12" />Locked (EPF/NPS)</span> }
                      @default { <span class="badge">Hold</span> } }</span></td>
                  <td class="num">{{ r.after_pct | pct: 1 : false }}</td>
                </tr>
                @if (b.kind === 'trim' && r.sells?.length) {
                  <tr class="rp-tax-row"><td colspan="6">
                    <details class="more rp-sells">
                      <summary>{{ r.sells!.length }} sale{{ r.sells!.length === 1 ? '' : 's' }} in {{ r.segment }}, lowest tax first@if (short(r); as c) { · frees {{ c | inr }} of {{ r.amount | inr }}}</summary>
                      <ol class="rp-sell-list">
                        @for (s of r.sells!; track s.instrument_id) {
                          <li>
                            <span class="rp-sell-name">{{ s.name }}</span>
                            <span class="muted">{{ units(s.qty) }} units · {{ s.proceeds | inr }}</span>
                            <span class="badge" [class.good]="s.order !== 'other'">{{ orderWord(s.order) }}</span>
                            <span class="num" [class.pos]="s.tax < 0">{{ taxText(s.tax) }}<app-est [basis]="planTaxBasis" /></span>
                          </li>
                        }
                      </ol>
                    </details>
                  </td></tr>
                }
                @if (tx) {
                  <tr class="rp-tax-row"><td colspan="6">
                    <div class="rp-tax" aria-live="polite">
                      @switch (tx.state) {
                        @case ('loading') { <span class="muted">Working out the tax…</span> }
                        @case ('none') { <span class="muted">No priced holding in {{ r.segment }} to work the tax out from.</span> }
                        @case ('error') { <span class="neg"><app-icon name="alert" [size]="13" /> {{ $any(tx).message }}</span>
                          <button type="button" class="rp-link" (click)="priceSale(r, true)">Try again</button> }
                        @case ('ok') {
                          @let ok = $any(tx);
                          <span>
                            @if (ok.tax < 0) { ≈ saves {{ -ok.tax | inr }} tax } @else { ≈ {{ ok.tax | inr }} tax }<app-est [basis]="taxBasis" />
                            selling {{ units(ok.qty) }} of {{ ok.name }}
                          </span>
                          <button type="button" class="rp-link" (click)="planSale(ok.instrumentId, ok.qty)">Plan the sale →</button>
                        }
                      }
                    </div>
                  </td></tr>
                }
              } @empty {
                <tr><td colspan="6" class="muted">No asset class has a target yet.</td></tr>
              }
            </tbody>
          </table>
        </div>
        @if (nettedText(); as n) { <p class="small muted rp-note">{{ n }}</p> }
        <div class="rp-foot">
          <div class="rp-lines">
            <p class="small text-2">
              @if (!pl.allow_sell) {
                @if (pl.money_to_fix_without_selling > 0) {
                  Without selling (no tax), about <b>{{ pl.money_to_fix_without_selling | inr }}</b> of new money would bring every class to its target.
                } @else if (pl.months_to_fix === 0) {
                  Nothing to fix without selling: new money simply follows the target mix.
                } @else { You are on target: new money simply follows the target mix. }
              } @else { Selling can trigger capital-gains tax. Check long-term lots and harvested losses on the <a routerLink="/tax">Tax page</a> before you trim. }
            </p>
            @if (pl.allow_sell && serverTax({ tax_if_sold: pl.tax_total })) {
              <p class="small text-2 rp-pace"><app-icon name="receipt" [size]="13" />
                <span>All these sales together: <b [class.pos]="pl.tax_total! < 0">{{ taxText(pl.tax_total!) }}</b><app-est [basis]="planTaxBasis" /></span></p>
            }
            @if (pl.allow_sell && pl.tax_note) { <p class="small muted">{{ pl.tax_note }}</p> }
            @if (pl.allow_sell && (pl.not_sold ?? 0) > 0) {
              <p class="small text-2 rp-pace"><app-icon name="shield" [size]="13" />
                <span>{{ pl.not_sold | inr }} left in maturity-only or locked money</span></p>
            }
            @if (!pl.allow_sell && pl.months_to_fix !== null && pl.months_to_fix !== undefined && pl.months_to_fix > 0) {
              <p class="small text-2 rp-pace"><app-icon name="calendar" [size]="13" />
                <span>At your SIP + maturity pace this closes in ~{{ pl.months_to_fix }} month{{ pl.months_to_fix === 1 ? '' : 's' }}<app-est [basis]="paceBasis" /></span></p>
            }
          </div>
          @if (riskLink()) { <a class="small nowrap" routerLink="/risk" fragment="rebalance">Open Risk &amp; mix →</a> }
        </div>
      }
    } @else {
      <div class="skeleton" style="height:180px" aria-label="Loading the plan"></div>
    }`,
  styles: [`
    :host { display: block; min-width: 0; }
    .rp-controls { display: flex; align-items: flex-end; gap: 12px 16px; flex-wrap: wrap; margin-bottom: 14px; }
    .rp-money { width: 200px; }
    .rp-input { position: relative; }
    .rp-input .input { padding-left: 24px; }
    .rp-cur { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 13.5px; pointer-events: none; }
    .rp-sell { height: 36px; }
    .rp-table td .row { white-space: nowrap; }
    .rp-move { display: inline-flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; }
    .rp-link { border: 0; background: none; padding: 0; font: inherit; font-size: 12.5px; font-weight: 500; color: var(--primary); cursor: pointer; white-space: nowrap; }
    .rp-link:hover { text-decoration: underline; }
    .rp-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
    .rp-table tr.rp-tax-row td { padding-top: 0; border-top: 0; }
    /* sticky + capped width: on a phone the table scrolls sideways, and the sentence stays in view and wraps */
    .rp-tax { position: sticky; left: 0; max-width: min(100%, calc(100vw - 72px)); display: flex; align-items: baseline; gap: 4px 12px; flex-wrap: wrap;
      padding: 8px 10px; border-radius: 8px; background: var(--surface-2); font-size: 12.5px; white-space: normal; box-sizing: border-box; }
    .rp-taxed { font-size: 12.5px; font-weight: 500; color: var(--text-2); white-space: nowrap; }
    .rp-sub { font-size: 12.5px; color: var(--text-2); white-space: nowrap; }
    .rp-sells { position: sticky; left: 0; max-width: min(100%, calc(100vw - 72px)); box-sizing: border-box;
      padding: 6px 10px; border-radius: 8px; background: var(--surface-2); font-size: 12.5px; white-space: normal; }
    .rp-sells > summary { font-size: 12.5px; }
    .rp-sell-list { margin: 6px 0 2px; padding-left: 18px; display: grid; gap: 6px; }
    .rp-sell-list li { display: flex; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; }
    .rp-sell-name { font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
    .rp-note { margin-top: 8px; }
    .rp-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; margin-top: 12px; }
    .rp-lines { flex: 1 1 280px; display: flex; flex-direction: column; gap: 4px; }
    .rp-lines p { margin: 0; }
    .rp-pace { display: flex; align-items: center; gap: 6px; }
    @media (max-width: 760px) {
      .rp-money { width: 100%; flex: 1 1 160px; }
      .rp-table th, .rp-table td { padding: 10px 10px; }
      .rp-table th:first-child, .rp-table td:first-child { padding-left: 14px; }
      .rp-table th:last-child, .rp-table td:last-child { padding-right: 14px; }
      .rp-tax-row td { padding-left: 14px; }
      /* the visible part of the sideways-scrolling table: the viewport less the page and card gutters */
      .rp-sells { max-width: calc(100vw - 104px); }
    }
  `],
})
export class RebalancePlannerComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private dialog = inject(TxnDialogService);

  /** Starting amount of new money (₹). */
  newMoney = input<number | null>(0);
  /** Start with selling allowed. */
  allowSell = input(false);
  /** `newMoney` is `brief.deploy.suggested`: send `net=deploy` (A15). */
  useNet = input(false);
  /** Show the "Open Risk & mix →" link. */
  riskLink = input(true);

  readonly uid = `rp-${++nextId}`;
  readonly money = signal(0);
  readonly sell = signal(false);
  readonly net = signal(false);
  readonly plan = signal<RebalancePlan | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** "Tax if sold" results by `segment|amount` (J9); cleared when the ledger moves. */
  readonly taxes = signal<Record<string, TaxIfSold>>({});

  readonly taxBasis = 'Tax on this sale at today\'s price, FIFO lots and your slab rate, before brokerage and charges. An estimate, not advice';
  readonly paceBasis = 'Months of your SIPs plus the money due back in the next 90 days that close the gap without selling. An estimate at today\'s pace';
  readonly planTaxBasis = 'Capital-gains tax on these sales at today\'s prices, FIFO lots and your slab rate, all sales costed together so the yearly exemption is used once. Before brokerage and exit loads. An estimate, not advice';

  /** The user has changed the amount away from the one the page handed in. */
  readonly edited = computed(() => this.clean(this.newMoney()) > 0
    && (this.money() !== this.clean(this.newMoney()) || this.net() !== this.useNet()));

  readonly nettedText = computed(() => {
    const n = this.plan()?.netted;
    const parts = Object.entries(n ?? {}).filter(([, v]) => v > 0);
    if (!parts.length) return '';
    const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
    const list = parts.map(([s, v]) => `₹${fmt.format(v)} from ${s}`).join(', ');
    return `Money that is about to be freed is already inside its asset class, so it is taken out first and not counted twice: ${list}.`;
  });

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private taxSeq = 0;

  constructor() {
    // the page's values are the starting point (and come back whenever the page changes them)
    effect(() => {
      const m = this.clean(this.newMoney()), s = this.allowSell(), n = this.useNet();
      untracked(() => { this.money.set(m); this.sell.set(s); this.net.set(n); });
    });
    effect(() => {
      this.money(); this.sell(); this.net(); this.store.version();
      untracked(() => this.schedule());
    });
    // a priced sale is only good for the holdings it was priced on
    effect(() => {
      this.store.version();
      untracked(() => { this.taxSeq++; this.taxes.set({}); });
    });
    inject(DestroyRef).onDestroy(() => { if (this.timer) clearTimeout(this.timer); this.seq++; this.taxSeq++; });
  }

  colorOf(segment: string): string { return SEGMENT_COLOR[segment] ?? 'var(--s7)'; }

  /**
   * Add / Trim / Hold, except that FD and P2P are never sold or force-fed: they read "Redirect maturities", and an
   * over-target EPF or NPS on an allow_sell plan reads "Locked (EPF/NPS)" (K13).
   */
  badge(r: RebalanceRow): Badge {
    if (r.locked) return { kind: 'locked', amount: null };
    // K13: the server now sends an over-target FD/P2P as 'hold' with `let_mature`; older payloads sent 'sell'
    if (MATURING.has(r.segment) && ((r.let_mature ?? 0) > 0 || r.action === 'sell' || (r.action === 'hold' && r.current_pct > r.target_pct + OVER_PTS))) {
      return { kind: 'redirect', amount: r.action === 'sell' ? r.amount : null };
    }
    if (r.action === 'buy') return { kind: 'add', amount: r.amount };
    if (r.action === 'sell') return { kind: 'trim', amount: r.amount };
    return { kind: 'hold', amount: null };
  }

  /** The row (or the plan's total, passed as `{tax_if_sold}`) carries a tax the server worked out (K13). */
  serverTax(r: Pick<RebalanceRow, 'tax_if_sold'>): boolean { return hasServerTax(r); }
  taxText(tax: number): string { return taxWords(tax, v => fmtInr(v)); }
  orderWord(o: SaleLeg['order']): string { return SALE_ORDER_WORD[o] ?? o; }
  /** What the sells actually free, when rounding, ELSS locks or unpriced holdings leave it under the trim. */
  short(r: RebalanceRow): number | null {
    return typeof r.covered === 'number' && r.covered < r.amount - 1 ? r.covered : null;
  }

  private taxKey(r: RebalanceRow): string { return `${r.segment}|${Math.round(r.amount)}`; }
  taxOf(r: RebalanceRow): TaxIfSold | null { return this.taxes()[this.taxKey(r)] ?? null; }
  /** "Tax if sold" shows only where the segment has a holding the what-if API can price (not EPF or NPS). */
  canPrice(r: RebalanceRow): boolean { return r.amount > 0 && !!largestSellable(this.store.positions(), r.segment); }
  /** Whole units as integers, fund units to the 0.001 they were rounded to. */
  units(q: number): string { return Number.isInteger(q) ? fmtQty(q) : q.toLocaleString('en-IN', { maximumFractionDigits: 3 }); }

  /** Price one sale of the segment's largest priced holding for this row's amount (J9). Cached per (segment, amount). */
  async priceSale(r: RebalanceRow, again = false) {
    const key = this.taxKey(r);
    const have = this.taxes()[key];
    if (have && !again && have.state !== 'error') return;
    const p = largestSellable(this.store.positions(), r.segment);
    const q = p ? unitsFor(p, r.amount) : 0;
    if (!p || q <= 0) { this.setTax(key, { state: 'none' }); return; }
    const mine = this.taxSeq;
    this.setTax(key, { state: 'loading' });
    try {
      const w = await firstValueFrom(this.api.whatIf({ instrument_id: p.id, qty: q }));
      if (mine !== this.taxSeq) return;
      this.setTax(key, { state: 'ok', instrumentId: p.id, name: w.name || p.name, qty: w.qty ?? q, tax: w.tax_now });
    } catch (e) {
      if (mine !== this.taxSeq) return;
      this.setTax(key, { state: 'error', message: errorMessage(e) });
    }
  }

  planSale(instrumentId: number, qty: number) { this.dialog.openWhatIf({ instrumentId, qty }); }

  private setTax(key: string, v: TaxIfSold) { this.taxes.update(t => ({ ...t, [key]: v })); }

  /** A typed amount is the user's own: it is planned without netting (A15). */
  typed(v: unknown) {
    this.money.set(this.clean(Number(v)));
    this.net.set(false);
  }

  reset() {
    this.money.set(this.clean(this.newMoney()));
    this.net.set(this.useNet());
  }

  /** Debounced so typing an amount makes one request. */
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.load(); }, this.plan() ? 300 : 0);
  }

  async load(): Promise<void> {
    const mine = ++this.seq;
    this.loading.set(true);
    try {
      const plan = await firstValueFrom(this.api.get<RebalancePlan>('/rebalance', {
        new_money: this.money(), allow_sell: this.sell() ? 1 : 0, net: this.net() ? 'deploy' : null,
      }));
      if (mine !== this.seq) return;
      this.plan.set(plan);
      this.error.set(null);
    } catch (e) {
      if (mine !== this.seq) return;
      this.error.set(errorMessage(e));
    } finally {
      if (mine === this.seq) this.loading.set(false);
    }
  }

  private clean(v: number | null | undefined): number {
    return v !== null && v !== undefined && isFinite(v) && v > 0 ? Math.round(v) : 0;
  }
}
