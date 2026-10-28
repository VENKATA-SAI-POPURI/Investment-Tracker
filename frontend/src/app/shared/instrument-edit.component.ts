import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../core/api.service';
import { errorMessage } from '../core/http';
import { Position, SymbolHit } from '../core/models';
import { StoreService } from '../core/store.service';
import { ToastService } from '../core/toast.service';
import { IconComponent } from './icon.component';
import { ModalComponent } from './ui';

export const TAX_CLASSES: [string, string][] = [
  ['equity', 'Indian equity / equity MF (12-month LTCG, ₹1.25L exemption)'],
  ['foreign_equity', 'Foreign equity / overseas fund (24-month LTCG)'],
  ['listed_other', 'Gold / silver / other listed ETF (12-month LTCG)'],
  ['debt', 'Debt fund (slab rate)'],
  ['income', 'Interest income (slab rate)'],
];

@Component({
  selector: 'app-instrument-edit',
  standalone: true,
  imports: [FormsModule, ModalComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal [title]="'Edit ' + position().name" [width]="580" (close)="done.emit()">
      <form class="form" (ngSubmit)="save()" autocomplete="off">
        <div class="field"><label for="ie-name">Name</label><input id="ie-name" class="input" name="name" [(ngModel)]="f.name" /></div>
        @if (tradable) {
          <div class="field">
            <label for="ie-sym">Price ticker</label>
            <div class="input-group">
              <input id="ie-sym" class="input" name="symbol" [(ngModel)]="f.symbol" placeholder="e.g. TCS.NS, AAPL, AMFI:120503" />
              <button type="button" class="btn" (click)="search()" [disabled]="searching()"><app-icon name="search" [size]="15" /> Find</button>
            </div>
            <span class="hint">Yahoo Finance symbols (.NS / .BO for India) or AMFI:&lt;scheme code&gt; for mutual funds.</span>
          </div>
          @if (hits(); as hs) {
            <div class="hits">
              @for (h of hs; track h.symbol) {
                <button type="button" class="hit" (click)="f.symbol = h.symbol; hits.set(null)"><span class="ellipsis">{{ h.name }}</span><span class="muted nowrap">{{ h.symbol }} · {{ h.exchange }}</span></button>
              } @empty { <div class="hit muted">No matches.</div> }
            </div>
          }
          <div class="cols">
            @if (position().asset_class === 'equity') {
              <div class="field"><label for="ie-mkt">Market</label><select id="ie-mkt" class="input" name="market" [(ngModel)]="f.market"><option>India</option><option>USA</option></select></div>
              <div class="field"><label for="ie-sec">Sector</label><input id="ie-sec" class="input" name="sector" [(ngModel)]="f.sector" list="ie-sectors" />
                <datalist id="ie-sectors">@for (s of sectors; track s) { <option [value]="s"></option> }</datalist></div>
              <div class="field"><label for="ie-cap">Market cap</label><select id="ie-cap" class="input" name="cap" [(ngModel)]="f.market_cap"><option value="">—</option><option>Mega Cap</option><option>Large Cap</option><option>Mid Cap</option><option>Small Cap</option></select></div>
            } @else {
              <div class="field"><label for="ie-cat">Category</label><input id="ie-cat" class="input" name="category" [(ngModel)]="f.category" /></div>
              @if (position().asset_class === 'mutual_fund') {
                <div class="field"><label for="ie-plan">Investing via</label><select id="ie-plan" class="input" name="plan" [(ngModel)]="f.sub_category"><option value="">—</option><option>SIP</option><option>Lump Sum</option></select></div>
              }
            }
          </div>
          <div class="field"><label for="ie-tax">Tax treatment</label>
            <select id="ie-tax" class="input" name="tax" [(ngModel)]="f.tax_class">@for (t of taxClasses; track t[0]) { <option [value]="t[0]">{{ t[1] }}</option> }</select></div>
          @if (!f.symbol) {
            <div class="field"><label for="ie-px">Manual price (no ticker)</label><input id="ie-px" class="input num" type="number" step="any" name="price" [(ngModel)]="f.last_price" /></div>
          }
        } @else {
          <div class="cols">
            <div class="field"><label for="ie-plat">Platform</label><input id="ie-plat" class="input" name="platform" [(ngModel)]="f.platform" /></div>
            <div class="field"><label for="ie-rate">Interest rate (% a year)</label><input id="ie-rate" class="input num" type="number" step="0.01" name="rate" [(ngModel)]="f.rate" /></div>
            <div class="field"><label for="ie-mat">Maturity date</label><input id="ie-mat" class="input" type="date" name="maturity" [(ngModel)]="f.maturity_date" /></div>
            @if (position().asset_class === 'p2p') {
              <div class="field"><label for="ie-st">Status</label><select id="ie-st" class="input" name="status" [(ngModel)]="f.status"><option value="active">Active</option><option value="closed">Closed</option><option value="defaulted">Defaulted</option></select></div>
              <div class="field"><label for="ie-loan">Loan ID</label><input id="ie-loan" class="input" name="ref2" [(ngModel)]="f.ref2" /></div>
            }
          </div>
        }
        <div class="field"><label for="ie-notes">Notes</label><textarea id="ie-notes" class="input" rows="2" name="notes" [(ngModel)]="f.notes"></textarea></div>
        @if (error()) { <div class="notice bad">{{ error() }}</div> }
        <div class="form-actions">
          <button type="button" class="btn" (click)="done.emit()">Cancel</button>
          <button type="submit" class="btn primary" [disabled]="saving()">Save</button>
        </div>
      </form>
    </app-modal>`,
  styles: [`
    .hits { max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
    .hit { display: flex; justify-content: space-between; gap: 10px; width: 100%; text-align: left; padding: 8px 10px; border: 0; border-bottom: 1px solid var(--border); background: none; cursor: pointer; }
    .hit:hover { background: var(--surface-2); }
  `],
})
export class InstrumentEditComponent implements OnInit {
  position = input.required<Position>();
  done = output<void>();
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);
  taxClasses = TAX_CLASSES;
  sectors = ['Information Technology', 'Financials', 'Health Care', 'Consumer Discretionary', 'Consumer Staples', 'Industrials',
    'Energy', 'Materials', 'Utilities', 'Real Estate', 'Communication Services'];
  f: any = {};
  tradable = false;
  hits = signal<SymbolHit[] | null>(null);
  searching = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);

  ngOnInit() {
    const p = this.position();
    this.tradable = ['equity', 'mutual_fund', 'commodity'].includes(p.asset_class);
    this.f = { name: p.name, symbol: p.symbol ?? '', market: p.market ?? 'India', sector: p.sector ?? '', market_cap: p.market_cap ?? '',
      category: p.category ?? '', sub_category: p.sub_category ?? '', tax_class: p.tax_class ?? 'equity', notes: p.notes ?? '',
      platform: p.platform ?? '', rate: p.rate, maturity_date: p.maturity_date ?? '', status: p.status, ref2: p.ref2 ?? '',
      last_price: p.symbol ? null : p.price };
  }

  async search() {
    this.searching.set(true);
    try { this.hits.set(await firstValueFrom(this.api.searchSymbols(this.f.name, this.position().asset_class))); }
    catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.searching.set(false); }
  }

  async save() {
    this.saving.set(true);
    this.error.set(null);
    try {
      const body = { ...this.f };
      if (!this.tradable) for (const k of ['symbol', 'market', 'sector', 'market_cap', 'category', 'sub_category', 'tax_class', 'last_price']) delete body[k];
      else if (body.symbol) delete body.last_price;
      await firstValueFrom(this.api.updateInstrument(this.position().id, body));
      this.toast.ok('Details saved');
      await this.store.changed();
      if (this.tradable && body.symbol && body.symbol !== this.position().symbol) void this.store.refreshPrices(true);
      this.done.emit();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }
}
