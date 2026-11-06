import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fileToBase64 } from '../../core/format';
import { errorMessage } from '../../core/http';
import { KiteBlock, KiteDay, KitePreview, KiteStock } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';

const signed = (r: { type: string; quantity: number }) => r.type === 'SELL' ? -r.quantity : r.quantity;
const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);

/** Zerodha tradebook: reconciles Kite's trades with what the app already holds, stock by stock. */
@Component({
  selector: 'app-tradebook-import',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, RouterLink, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <div class="card-head"><div><h2>Upload a Kite tradebook</h2>
        <span class="hint">Console → Reports → Tradebook → Equity, for one financial year at a time (.xlsx or .csv). Several years at once is fine.</span></div></div>
      @if (!auth.canWrite()) { <div class="notice"><app-icon name="info" [size]="16" /> Read-only access: imports are not available for guests.</div> }
      @else {
        <label class="drop">
          <input type="file" accept=".xlsx,.csv" multiple (change)="onFiles($event)" [disabled]="busy()" aria-label="Choose tradebook files" />
          <app-icon name="upload" [size]="20" />
          <span>{{ busy() && !preview() ? 'Reading…' : files() || 'Choose tradebook files' }}</span>
        </label>
        <p class="small muted" style="margin-top:10px"><app-icon name="shield" [size]="13" /> Trades already in the app are recognised, including ones you entered as one combined row. Nothing changes until you apply.</p>
      }
      @if (error()) { <div class="notice bad" style="margin-top:12px"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }
    </section>

    @if (preview(); as p) {
      @let c = counts();
      <section class="kpis" style="--kpi-cols:4">
        <div class="kpi"><span class="label">Tradebook</span><span class="value">{{ p.trades }} trades</span><span class="meta">{{ p.from_date | dt }} – {{ p.to_date | dt }}{{ p.client_ids.length ? ' · ' + p.client_ids.join(', ') : '' }}</span></div>
        <div class="kpi"><span class="label">Already in the app</span><span class="value">{{ c.matched }}</span><span class="meta">trading days across {{ p.stocks.length }} stocks</span></div>
        <div class="kpi"><span class="label">To add</span><span class="value">{{ c.add }}</span><span class="meta">{{ c.split }} combined entr{{ c.split === 1 ? 'y' : 'ies' }} to split</span></div>
        <div class="kpi"><span class="label">To check</span><span class="value">{{ c.corrections + c.review }}</span><span class="meta">{{ c.corrections }} amount difference{{ c.corrections === 1 ? '' : 's' }} · {{ c.review }} unexplained</span></div>
      </section>

      <section class="card flush">
        <div class="card-head"><div><h2>Stock by stock</h2><span class="hint">Net shares bought in this period: Kite vs the app, after the changes ticked below</span></div></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Stock</th><th class="num">Kite</th><th class="num hide-sm">App now</th><th class="num">After import</th><th class="hide-sm">Changes</th></tr></thead>
            <tbody>
              @for (s of p.stocks; track s.symbol) {
                @let a = after(s);
                <tr>
                  <td class="name-cell"><div style="font-weight:500">{{ s.name }}</div><div class="sub">{{ s.symbol }}{{ s.new_instrument ? ' · new holding' : '' }}</div></td>
                  <td class="num">{{ s.kite_net | qty }}</td>
                  <td class="num hide-sm">{{ s.app_net | qty }}</td>
                  <td class="num"><b>{{ a.net | qty }}</b> @if (a.ok) { <app-icon name="checkCircle" [size]="14" class="pos" /> } @else { <app-icon name="alert" [size]="14" class="neg" /> }
                    @if (a.kept) { <div class="sub">incl. {{ a.kept | qty }} not in Kite</div> }</td>
                  <td class="hide-sm"><div class="row wrap" style="gap:4px">
                    @if (s.matched) { <span class="badge">{{ s.matched }} recorded</span> }
                    @if (s.add.length) { <span class="badge good">+{{ s.add.length }} to add</span> }
                    @if (s.split.length) { <span class="badge info">{{ s.split.length }} combined</span> }
                    @if (s.corrections.length) { <span class="badge warn">{{ s.corrections.length }} amount differs</span> }
                    @if (s.review.length) { <span class="badge bad">check</span> }
                    @if (s.kept.length) { <span class="badge">{{ s.kept.length }} kept</span> }
                  </div></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      @if (adds().length) {
        <section class="card flush">
          <div class="card-head"><div><h2>Trades to add</h2><span class="hint">In Kite but not in the app; fills on the same day are combined, as the app records them</span></div>
            <label class="check small"><input type="checkbox" [checked]="allAdds()" (change)="setAll(adds(), $event)" /> Select all</label></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th></th><th>Date</th><th>Stock</th><th>Type</th><th class="num">Qty</th><th class="num hide-sm">Avg price</th><th class="num">Amount</th><th class="hide-sm">Exchange</th></tr></thead>
            <tbody>
              @for (r of adds(); track r.stock.symbol + r.row.date + r.row.type) {
                <tr><td><input type="checkbox" [(ngModel)]="r.row.selected" (ngModelChange)="bump()" [attr.aria-label]="'Add ' + r.stock.symbol + ' ' + r.row.date" /></td>
                  <td>{{ r.row.date | dt }}</td><td>{{ r.stock.name }}</td>
                  <td><span class="badge" [attr.data-type]="r.row.type">{{ r.row.type === 'BUY' ? 'Buy' : 'Sell' }}</span></td>
                  <td class="num">{{ r.row.quantity | qty }}</td><td class="num hide-sm">{{ r.row.price | inr: 2 }}</td><td class="num">{{ r.row.amount | inr: 2 }}</td>
                  <td class="hide-sm small muted">{{ r.row.exchanges.join(', ') }}{{ r.row.fills > 1 ? ' · ' + r.row.fills + ' fills' : '' }}</td></tr>
              }
            </tbody>
          </table></div>
        </section>
      }

      @if (blocks('split').length) {
        <section class="card">
          <div class="card-head"><div><h2>Combined entries</h2><span class="hint">One app entry covers several Kite trades with exactly the same total. Splitting keeps your holding and cost as they are and gives each lot its real date.</span></div></div>
          @for (b of blocks('split'); track $index) { <ng-container *ngTemplateOutlet="block; context: { $implicit: b }" /> }
        </section>
      }

      @if (fixes().length) {
        <section class="card flush">
          <div class="card-head"><div><h2>Amount differences</h2><span class="hint">Same day and quantity, different amount. Left as recorded unless you tick it.</span></div></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th></th><th>Date</th><th>Stock</th><th class="num">Qty</th><th class="num">In the app</th><th class="num">In Kite</th><th class="num">Difference</th></tr></thead>
            <tbody>
              @for (f of fixes(); track f.row.txn_id) {
                <tr><td><input type="checkbox" [(ngModel)]="f.row.selected" (ngModelChange)="bump()" [attr.aria-label]="'Use Kite amount for ' + f.stock.symbol" /></td>
                  <td>{{ f.row.date | dt }}</td><td>{{ f.stock.name }} <span class="sub">{{ f.row.type === 'BUY' ? 'buy' : 'sell' }}</span></td>
                  <td class="num">{{ f.row.quantity | qty }}</td><td class="num">{{ f.row.app_amount | inr: 2 }}</td><td class="num">{{ f.row.kite_amount | inr: 2 }}</td>
                  <td class="num" [class]="f.row.kite_amount - f.row.app_amount | sign">{{ f.row.kite_amount - f.row.app_amount | inr: 2 : true }}</td></tr>
              }
            </tbody>
          </table></div>
        </section>
      }

      @if (blocks('review').length) {
        <section class="card">
          <div class="card-head"><div><h2>Doesn't line up</h2><span class="hint">The app's entries and Kite's trades differ in total. Tick to replace the app's entries with Kite's, or leave them and fix by hand.</span></div></div>
          @for (b of blocks('review'); track $index) { <ng-container *ngTemplateOutlet="block; context: { $implicit: b }" /> }
        </section>
      }

      @if (keptCount()) {
        <details class="more"><summary>{{ keptCount() }} app entr{{ keptCount() === 1 ? 'y' : 'ies' }} not in Kite, kept as is (e.g. IPO allotments)</summary>
          <div class="card" style="margin-top:8px">
            @for (s of p.stocks; track s.symbol) { @for (k of s.kept; track k.id) {
              <div class="small" style="padding:4px 0">{{ s.name }} · {{ k.type === 'BUY' ? 'bought' : 'sold' }} {{ k.quantity | qty }} on {{ k.date | dt }} for {{ k.amount | inr: 2 }}{{ k.notes ? ' · ' + k.notes : '' }}</div>
            } }
          </div>
        </details>
      }

      <div class="row" style="justify-content:flex-end;gap:10px;margin-top:4px">
        <button class="btn" (click)="reset()">Cancel</button>
        <button class="btn primary" (click)="apply()" [disabled]="busy() || !c.selected">{{ busy() ? 'Applying…' : c.selected ? 'Apply ' + c.selected + ' change' + (c.selected === 1 ? '' : 's') : 'Nothing to apply' }}</button>
      </div>
    }

    @if (done(); as d) {
      <section class="card">
        <div class="card-head"><h2>Tradebook applied</h2><span class="hint">{{ d.added }} trades added · {{ d.removed }} combined entries replaced · {{ d.corrected }} amounts corrected</span></div>
        @for (x of d.failed; track x.symbol) { <div class="notice bad" style="margin-bottom:6px">{{ x.symbol }}: {{ x.error }}</div> }
        <div class="row"><a class="btn" routerLink="/holdings/equity">View stocks</a><a class="btn" routerLink="/transactions">View transactions</a></div>
      </section>
    }

    <ng-template #block let-b>
      <div class="blk">
        <label class="check"><input type="checkbox" [(ngModel)]="b.block.selected" (ngModelChange)="bump()" />
          <b>{{ b.stock.name }}</b>&nbsp;<span class="muted">{{ b.block.type === 'BUY' ? 'buys' : 'sells' }}{{ b.block.message ? ' · ' + b.block.message : '' }}</span></label>
        <div class="cmp">
          <div><small>In the app now</small>
            @for (r of b.block.remove; track r.id) { <div class="ln"><span>{{ r.date | dt }}</span><span>{{ r.quantity | qty }}</span><span>{{ r.amount | inr: 2 }}</span></div> }</div>
          <app-icon name="chevronRight" [size]="16" class="muted" />
          <div><small>Kite's trades</small>
            @for (r of b.block.add; track r.date) { <div class="ln"><span>{{ r.date | dt }}</span><span>{{ r.quantity | qty }}</span><span>{{ r.amount | inr: 2 }}</span></div> }</div>
        </div>
      </div>
    </ng-template>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; }
    .drop { position: relative; display: flex; align-items: center; gap: 10px; height: 64px; padding: 0 16px; border-radius: 10px;
      border: 1.5px dashed var(--border-strong); background: var(--surface-2); color: var(--text-2); cursor: pointer; font-size: 13.5px; }
    .drop:hover { border-color: var(--primary); color: var(--text); }
    .drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .blk { padding: 12px 0; border-top: 1px solid var(--border); }
    .blk:first-of-type { border-top: 0; padding-top: 0; }
    .cmp { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 14px; align-items: start; margin: 8px 0 0 26px; }
    .cmp > app-icon { margin-top: 22px; }
    .cmp small { display: block; color: var(--muted); font-size: 11.5px; margin-bottom: 4px; }
    .ln { display: grid; grid-template-columns: 1fr 60px 100px; gap: 8px; font-size: 12.5px; padding: 2px 0; font-variant-numeric: tabular-nums; }
    .ln span:not(:first-child) { text-align: right; }
    @media (max-width: 700px) { .cmp { grid-template-columns: minmax(0, 1fr); margin-left: 0; } .cmp > app-icon { transform: rotate(90deg); justify-self: center; margin-top: 0; } }
  `],
})
export class TradebookImportComponent {
  auth = inject(AuthService);
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);

  files = signal('');
  busy = signal(false);
  error = signal<string | null>(null);
  preview = signal<KitePreview | null>(null);
  done = signal<{ added: number; removed: number; corrected: number; failed: { symbol: string; error?: string }[] } | null>(null);
  tick = signal(0);  // checkboxes mutate the preview in place; this re-runs everything that counts them

  adds = computed(() => (this.tick(), (this.preview()?.stocks ?? []).flatMap(stock => stock.add.map(row => ({ stock, row })))));
  fixes = computed(() => (this.tick(), (this.preview()?.stocks ?? []).flatMap(stock => stock.corrections.map(row => ({ stock, row })))));
  allAdds = computed(() => this.adds().every(r => r.row.selected));
  keptCount = computed(() => sum(this.preview()?.stocks ?? [], s => s.kept.length));
  counts = computed(() => {
    this.tick();
    const st = this.preview()?.stocks ?? [];
    const picked = (rows: { selected: boolean }[]) => rows.filter(r => r.selected).length;
    return {
      matched: sum(st, s => s.matched), add: sum(st, s => s.add.length), split: sum(st, s => s.split.length),
      corrections: sum(st, s => s.corrections.length), review: sum(st, s => s.review.length),
      selected: sum(st, s => picked(s.add) + picked(s.split) + picked(s.corrections) + picked(s.review)),
    };
  });

  blocks(kind: 'split' | 'review') {
    return (this.preview()?.stocks ?? []).flatMap(stock => stock[kind].map(block => ({ stock, block })));
  }

  /** Net shares for the period once the ticked changes are applied; app entries Kite doesn't list are shown apart. */
  after(s: KiteStock) {
    this.tick();
    const blocks = [...s.split, ...s.review].filter(b => b.selected);
    const kept = sum(s.kept, signed);
    const net = s.app_net + sum(s.add.filter(r => r.selected), signed)
      + sum(blocks, (b: KiteBlock) => sum(b.add, signed) - sum(b.remove, signed));
    return { net, kept, ok: Math.abs(net - kept - s.kite_net) < 1e-6 };
  }

  bump() { this.tick.update(v => v + 1); }
  setAll(rows: { row: KiteDay & { selected: boolean } }[], ev: Event) {
    const on = (ev.target as HTMLInputElement).checked;
    rows.forEach(r => r.row.selected = on);
    this.bump();
  }

  async onFiles(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const picked = [...(input.files ?? [])];
    input.value = '';
    if (!picked.length) return;
    this.files.set(picked.map(f => f.name).join(', '));
    this.busy.set(true); this.error.set(null); this.done.set(null); this.preview.set(null);
    try {
      const files = await Promise.all(picked.map(async f => ({ name: f.name, file_data: await fileToBase64(f) })));
      this.preview.set(await firstValueFrom(this.api.tradebookPreview(files)));
      this.bump();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  reset() { this.preview.set(null); this.files.set(''); this.error.set(null); }

  async apply() {
    const p = this.preview();
    if (!p) return;
    const stocks = p.stocks.map(s => ({
      symbol: s.symbol, instrument_id: s.instrument_id, new_instrument: s.new_instrument,
      add: s.add.filter(r => r.selected), split: s.split.filter(b => b.selected),
      corrections: s.corrections.filter(c => c.selected), review: s.review.filter(b => b.selected),
    })).filter(s => s.add.length || s.split.length || s.corrections.length || s.review.length);
    this.busy.set(true); this.error.set(null);
    try {
      const r = await firstValueFrom(this.api.tradebookCommit(stocks));
      const failed = r.results.filter(x => !x.ok);
      this.done.set({ added: r.added, removed: r.removed, corrected: r.corrected, failed });
      this.toast.ok(`Tradebook applied: ${r.added} trades added`);
      if (failed.length) this.toast.error(`${failed.length} stock(s) skipped`);
      this.preview.set(null);
      this.files.set('');
      await this.store.changed();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
