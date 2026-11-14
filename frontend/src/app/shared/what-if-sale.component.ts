import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { kindFor } from '../core/action-runner.service';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { FORMAT_PIPES, today } from '../core/format';
import { errorMessage } from '../core/http';
import { Position, WhatIfSale } from '../core/models';
import { StoreService } from '../core/store.service';
import { TxnDialogService, WhatIfState } from '../core/txn-dialog.service';
import { IconComponent } from './icon.component';
import { EstTagComponent } from './priority/est-tag.component';
import { ModalComponent } from './ui';

/** D12: the backend's note carries it; this is the fallback for an older payload. */
const CHARGES_NOTE = 'Brokerage, STT and stamp duty from imports are not deducted.';
/** `tax.MAX_AHEAD_DAYS`: a sale can be planned at most a year ahead. */
const MAX_AHEAD_DAYS = 365;

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * "What if I sell?" (Part 2 §9.3, §6.9; AMENDMENTS H17), hosted by the shell like the FD dialog (A19).
 *
 * Quantity, price and date default to the held quantity, the holding's price (D16) and today; the modal works
 * the tax out on open and on every "Work it out". The answer comes first: the tax (or what the sale saves, when
 * a loss offsets gains already booked) with an est. tag, then the wait hint, the figures, the lots and the note.
 * A 400 from `/tax/what-if` (ELSS lock-in, more than you hold, no price) shows inline. "Record this sale"
 * (writers only) closes the modal and opens the transaction dialog on a SELL with the instrument, quantity, date
 * and the action it fulfils.
 */
@Component({
  selector: 'app-what-if-sale',
  standalone: true,
  imports: [FormsModule, ModalComponent, IconComponent, EstTagComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal [title]="pos() ? 'What if I sell ' + pos()!.name + '?' : 'What if I sell?'" [width]="660" (close)="closed.emit()">
      @if (pos(); as p) {
        <form class="form wi-form" (ngSubmit)="run()" autocomplete="off">
          <div class="cols three">
            <div class="field"><label for="wi-qty">Units to sell</label>
              <input id="wi-qty" class="input num" type="number" step="any" min="0" name="qty" [(ngModel)]="qty" />
              <span class="hint">You hold {{ p.quantity | qty }}@if (p.elss?.locked_qty) { · {{ p.elss!.locked_qty | qty }} locked (ELSS) }</span></div>
            <div class="field"><label for="wi-price">Price per unit ({{ usd() ? '$' : '₹' }})</label>
              <input id="wi-price" class="input num" type="number" step="any" min="0" name="price" [(ngModel)]="price" [placeholder]="p.has_price ? '' : 'Enter a price'" />
              <span class="hint">{{ p.has_price && p.price ? 'Last price ' + (usd() ? '$' + p.price : (p.price | inr: 2)) : 'No price yet' }}</span></div>
            <div class="field"><label for="wi-date">Sale date</label>
              <input id="wi-date" class="input" type="date" name="date" [min]="todayIso" [max]="maxDate" [(ngModel)]="date" /></div>
          </div>
          <div class="wi-run"><button type="submit" class="btn" [disabled]="loading()">
            @if (loading()) { Working it out… } @else { <app-icon name="refresh" [size]="14" /> Work it out }</button></div>
        </form>

        @if (error(); as e) {
          <div class="notice bad wi-error" role="alert"><app-icon name="alert" [size]="16" /> <span>{{ e }}</span></div>
        }

        @if (result(); as r) {
          <section class="wi-result" [class.stale]="loading()" aria-live="polite">
            <div class="wi-answer" [attr.data-status]="r.tax_now > 0 ? 'watch' : 'good'">
              <span class="wi-label">{{ r.tax_now < 0 ? 'This sale saves' : 'Tax on this sale' }}</span>
              <span class="wi-big">
                @if (r.tax_now < 0) { saves {{ -r.tax_now | inr }} } @else if (r.tax_now === 0) { No tax } @else { {{ r.tax_now | inr }} }
                <app-est [basis]="r.note" />
              </span>
              <span class="wi-line">You'd keep {{ r.net_cash | inr }} of {{ r.proceeds | inr }}
                @if (r.effective_pct !== null) { · {{ r.effective_pct | pct: 1 : false }} of the gain }
                · sold {{ r.sell_date | dt }}, {{ r.fy }}</span>
            </div>

            @if (r.wait; as w) {
              <div class="notice warn wi-wait"><app-icon name="calendar" [size]="16" />
                <span><b>Wait {{ w.days }} day{{ w.days === 1 ? '' : 's' }}</b> — sold on {{ w.date | dt }} at the same price
                  ({{ r.currency === 'USD' ? (r.price | usd) : (r.price | inr: 2) }}), the tax is {{ w.tax_then | inr }}
                  <app-est [basis]="waitBasis(r)" />, which saves {{ w.saving | inr }}: that is when the short-term lots it sells turn long-term.</span></div>
            }

            <dl class="wi-facts">
              <div><dt>Proceeds</dt><dd>{{ r.proceeds | inr }}@if (r.amount_fc !== undefined) { <small>{{ r.amount_fc | usd }} at ₹{{ r.usd_inr }}</small> }</dd></div>
              <div><dt>Cost</dt><dd>{{ r.cost | inr }}</dd></div>
              <div><dt>Gain</dt><dd [class]="r.gain | sign">{{ r.gain | inr: 0 : true }}</dd></div>
              <div><dt>Short-term gain</dt><dd [class]="r.st_gain | sign">{{ r.st_gain | inr: 0 : true }}</dd></div>
              <div><dt>Long-term gain</dt><dd [class]="r.lt_gain | sign">{{ r.lt_gain | inr: 0 : true }}</dd></div>
              <div><dt>Tax-free allowance</dt><dd>{{ r.exemption_used | inr }} used<small>{{ r.exemption_left | inr }} left this FY</small></dd></div>
            </dl>

            @if (r.lots.length) {
              <details class="wi-lots" [open]="r.lots.length <= 4">
                <summary>Lots sold, oldest first ({{ r.lots.length }})</summary>
                <div class="table-wrap">
                  <table class="table">
                    <thead><tr><th>Bought</th><th class="num">Units</th><th class="num">Cost</th><th class="num">Proceeds</th><th class="num">Gain</th><th>Term</th><th class="num">Rate</th><th>Long-term on</th></tr></thead>
                    <tbody>
                      @for (l of r.lots; track $index) {
                        <tr>
                          <td>{{ l.date | dt }}</td><td class="num">{{ l.qty | qty }}</td><td class="num">{{ l.cost | inr }}</td>
                          <td class="num">{{ l.proceeds | inr }}</td><td class="num" [class]="l.gain | sign">{{ l.gain | inr: 0 : true }}</td>
                          <td><span class="badge">{{ termLabel(l.term) }}</span></td>
                          <td class="num">{{ l.rate_pct === null ? 'slab' : l.rate_pct + '%' }}</td>
                          <td>{{ l.term === 'STCG' && l.lt_on ? (l.lt_on | dt) : '—' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </details>
            }
            <p class="small muted wi-note">{{ note(r) }}</p>
          </section>
        } @else if (loading()) {
          <div class="wi-result" aria-busy="true"><div class="skeleton" style="height:72px"></div><div class="skeleton" style="height:120px;margin-top:10px"></div></div>
        } @else if (!error()) {
          <p class="small muted">Enter the units, price and date, then work it out.</p>
        }

        <div class="form-actions wi-actions">
          <button type="button" class="btn" (click)="closed.emit()">Close</button>
          @if (auth.canWrite()) {
            <button type="button" class="btn primary" (click)="record()" [disabled]="!canRecord()"
              title="Opens the transaction dialog with this sale filled in">Record this sale</button>
          }
        </div>
      } @else {
        <p class="notice"><app-icon name="info" [size]="16" /> This holding isn't in the portfolio you're viewing.</p>
        <div class="form-actions" style="margin-top:14px"><button type="button" class="btn" (click)="closed.emit()">Close</button></div>
      }
    </app-modal>`,
  styles: [`
    .wi-run { display: flex; justify-content: flex-end; margin-top: -4px; }
    .wi-error { margin-top: 12px; }
    .wi-result { display: flex; flex-direction: column; gap: 12px; margin-top: 14px; }
    .wi-result.stale { opacity: .6; }
    .wi-answer { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: 10px; background: var(--surface-2);
      border-left: var(--stripe) solid var(--st); }
    .wi-label { font-size: var(--t-label); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .wi-big { font-size: var(--t-num); font-weight: 650; font-variant-numeric: tabular-nums; }
    .wi-line { font-size: var(--t-meta); color: var(--text-2); }
    .wi-wait { align-items: flex-start; }
    .wi-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 16px; margin: 0; }
    .wi-facts div { min-width: 0; }
    .wi-facts dt { font-size: var(--t-label); color: var(--muted); }
    .wi-facts dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .wi-facts dd small { display: block; font-weight: 400; font-size: var(--t-label); color: var(--muted); }
    .wi-lots summary { cursor: pointer; font-size: var(--t-meta); font-weight: 600; color: var(--text-2); }
    .wi-lots .table-wrap { margin-top: 8px; }
    .wi-note { margin: 0; }
    .wi-actions { margin-top: 16px; }
    @media (max-width: 560px) { .wi-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `],
})
export class WhatIfSaleComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private dialog = inject(TxnDialogService);
  auth = inject(AuthService);

  readonly state = input.required<WhatIfState>();
  readonly closed = output<void>();

  readonly todayIso = today();
  readonly maxDate = addDays(this.todayIso, MAX_AHEAD_DAYS);

  /** The holding, from the portfolio on screen; null when it is not in this scope. */
  readonly pos = computed<Position | null>(() => this.store.positions().find(p => p.id === this.state().instrumentId) ?? null);
  readonly usd = computed(() => this.pos()?.currency === 'USD');

  readonly result = signal<WhatIfSale | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  qty: number | null = null;
  price: number | null = null;
  date = this.todayIso;

  private seq = 0;
  private applied: WhatIfState | null = null;
  private hadPos = false;

  constructor() {
    // A new open (another holding while this one is showing) or the portfolio arriving late resets the form.
    // A store reload after a save does not: the user's values stay.
    effect(() => {
      const s = this.state();
      const p = this.pos();
      untracked(() => {
        if (s === this.applied && (this.hadPos || !p)) return;
        this.applied = s;
        this.hadPos = !!p;
        this.reset(s, p);
      });
    });
  }

  private reset(s: WhatIfState, p: Position | null) {
    this.seq++;
    this.qty = s.qty ?? p?.quantity ?? null;
    this.price = s.price ?? (p?.has_price && p.price ? p.price : null);
    this.date = s.date ?? this.todayIso;
    this.result.set(null);
    this.error.set(null);
    this.loading.set(false);
    if (p && this.qty && this.qty > 0) void this.run();
  }

  /** "Record this sale" needs only a quantity and a date; the tax figure is not required. */
  canRecord(): boolean { return !!this.pos() && Number(this.qty) > 0 && !!this.date; }

  async run() {
    const p = this.pos();
    if (!p) return;
    const qty = Number(this.qty);
    if (!(qty > 0)) { this.error.set('Enter how many units to sell'); return; }
    const price = this.price === null || (this.price as unknown) === '' ? null : Number(this.price);
    if (price !== null && !(price > 0)) { this.error.set('The price must be more than 0'); return; }
    const mine = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const r = await firstValueFrom(this.api.whatIf({ instrument_id: p.id, qty, price, date: this.date || null }));
      if (mine !== this.seq) return;
      this.result.set(r);
    } catch (e) {
      if (mine !== this.seq) return;
      this.result.set(null);
      this.error.set(errorMessage(e));
    } finally {
      if (mine === this.seq) this.loading.set(false);
    }
  }

  /** Closes the modal and opens the add dialog on a SELL; saving it marks the action done (`actionId`). */
  record() {
    const p = this.pos();
    if (!p || !this.canRecord() || !this.auth.canWrite()) return;
    const s = this.state();
    const kind = kindFor(p.asset_class, 'SELL');
    this.dialog.closeWhatIf();
    this.dialog.add(kind, { instrumentId: p.id, type: 'SELL', quantity: Number(this.qty), date: this.date || this.todayIso, actionId: s.actionId });
  }

  /** The later sale is priced as today's (tax.what_if_sale re-runs the same price on the wait date). */
  waitBasis(r: WhatIfSale): string { return `Assumes the price is still the same on that date. ${r.note ?? ''}`.trim(); }

  termLabel(t: string): string { return t === 'LTCG' ? 'Long-term' : t === 'STCG' ? 'Short-term' : t; }

  /** The engine's note always names its basis; D12 is added when an older payload lacks it. */
  note(r: WhatIfSale): string { return r.note?.includes('Brokerage') ? r.note : `${r.note ?? ''} ${CHARGES_NOTE}`.trim(); }
}
