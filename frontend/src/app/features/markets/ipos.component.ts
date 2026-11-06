import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Ipo } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';

const GROUPS: { key: Ipo['status']; label: string; hint: string }[] = [
  { key: 'open', label: 'Open now', hint: 'Bidding is on' },
  { key: 'upcoming', label: 'Upcoming', hint: 'Opening soon' },
  { key: 'closed', label: 'Closed', hint: 'Waiting for allotment and listing' },
  { key: 'listed', label: 'Listed', hint: 'How they did on listing day' },
];
interface IpoForm { id?: number; name: string; board: string; symbol: string; open_date: string; close_date: string; allotment_date: string;
  listing_date: string; price_low: number | null; price_high: number | null; lot_size: number | null; issue_size_cr: number | null;
  gmp: number | null; subscription: string; applied: boolean; lots_applied: number | null; lots_allotted: number | null;
  listing_price: number | null; notes: string; }

/** IPOs you're tracking: dates, price band, lot size, grey-market premium and how your application went. */
@Component({
  selector: 'app-ipos',
  standalone: true,
  imports: [FormsModule, IconComponent, ModalComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <div class="card-head"><div><h2>IPO tracker</h2>
        <span class="hint">Add the IPOs you're considering; you'll be reminded when they open, close, allot and list. Details are on the exchange's or your broker's IPO page.</span></div>
        @if (auth.canWrite()) { <button class="btn sm" (click)="edit()"><app-icon name="plus" [size]="14" /> Add IPO</button> }</div>
      @if (error()) { <div class="notice bad">{{ error() }}</div> }
      @if (!ipos()) { <div class="skeleton" style="height:160px"></div> }
      @else if (!ipos()!.length) {
        <div class="empty"><app-icon name="rocket" [size]="22" /><p>No IPOs yet. Add one to track its dates, price band and grey-market premium.</p></div>
      } @else {
        @for (g of groups; track g.key) {
          @if (byStatus()[g.key].length) {
            <h3 class="gh">{{ g.label }} <small class="muted">{{ g.hint }}</small></h3>
            <div class="grid">
              @for (i of byStatus()[g.key]; track i.id) {
                <article class="ipo" [class.open]="i.status === 'open'">
                  <header><div><b>{{ i.name }}</b><small class="muted">{{ i.board || 'Mainboard' }}{{ i.symbol ? ' · ' + i.symbol : '' }}</small></div>
                    @if (i.applied) { <span class="badge good">Applied{{ i.lots_applied ? ' · ' + i.lots_applied + ' lot' + (i.lots_applied > 1 ? 's' : '') : '' }}</span> }</header>
                  <dl>
                    <dt>Price band</dt><dd>{{ band(i) }}</dd>
                    <dt>Lot</dt><dd>{{ i.lot_size ? i.lot_size + ' shares' : '—' }}{{ i.min_investment ? ' · ' + (i.min_investment | inr) : '' }}</dd>
                    <dt>Bidding</dt><dd>{{ i.open_date ? (i.open_date | dt: false) : '—' }} – {{ i.close_date ? (i.close_date | dt: false) : '—' }}</dd>
                    <dt>Listing</dt><dd>{{ i.listing_date ? (i.listing_date | dt) : '—' }}</dd>
                    @if (i.issue_size_cr) { <dt>Issue size</dt><dd>₹{{ i.issue_size_cr }} cr</dd> }
                    @if (i.gmp !== null) { <dt>Grey market</dt><dd [class]="i.gmp | sign">{{ i.gmp | inr: 0 : true }} {{ i.gmp_pct !== undefined ? '(' + (i.gmp_pct | pct) + ')' : '' }}</dd> }
                    @if (i.subscription) { <dt>Subscribed</dt><dd>{{ i.subscription }}</dd> }
                    @if (i.listing_price) { <dt>Listed at</dt><dd>{{ i.listing_price | inr: 2 }} <span class="chg" [class]="i.listing_gain_pct ?? 0 | sign">{{ i.listing_gain_pct | pct }}</span></dd> }
                    @if (i.applied && i.lots_allotted !== null) { <dt>Allotted</dt><dd>{{ i.lots_allotted ? i.lots_allotted + ' lot' + (i.lots_allotted > 1 ? 's' : '') : 'Not allotted' }}</dd> }
                  </dl>
                  @if (i.notes) { <p class="small muted">{{ i.notes }}</p> }
                  @if (auth.canWrite()) {
                    <footer><button class="btn ghost sm" (click)="edit(i)"><app-icon name="edit" [size]="13" /> Edit</button>
                      <button class="btn ghost sm" (click)="remove(i)"><app-icon name="trash" [size]="13" /> Delete</button></footer>
                  }
                </article>
              }
            </div>
          }
        }
      }
    </section>

    @if (form(); as f) {
      <app-modal [title]="f.id ? 'Edit ' + f.name : 'Track an IPO'" [width]="620" (close)="form.set(null)">
        <div class="form">
          <div class="cols">
            <div class="field"><label for="i-name">Company</label><input id="i-name" class="input" [(ngModel)]="f.name" placeholder="e.g. Acme Foods Ltd" /></div>
            <div class="field"><label for="i-board">Board</label>
              <select id="i-board" class="input" [(ngModel)]="f.board"><option>Mainboard</option><option>SME</option></select></div>
          </div>
          <div class="cols">
            <div class="field"><label for="i-open">Opens</label><input id="i-open" class="input" type="date" [(ngModel)]="f.open_date" /></div>
            <div class="field"><label for="i-close">Closes</label><input id="i-close" class="input" type="date" [(ngModel)]="f.close_date" /></div>
            <div class="field"><label for="i-allot">Allotment</label><input id="i-allot" class="input" type="date" [(ngModel)]="f.allotment_date" /></div>
            <div class="field"><label for="i-list">Listing</label><input id="i-list" class="input" type="date" [(ngModel)]="f.listing_date" /></div>
          </div>
          <div class="cols">
            <div class="field"><label for="i-lo">Price from (₹)</label><input id="i-lo" class="input num" type="number" min="0" [(ngModel)]="f.price_low" /></div>
            <div class="field"><label for="i-hi">Price to (₹)</label><input id="i-hi" class="input num" type="number" min="0" [(ngModel)]="f.price_high" /></div>
            <div class="field"><label for="i-lot">Lot size (shares)</label><input id="i-lot" class="input num" type="number" min="1" [(ngModel)]="f.lot_size" /></div>
            <div class="field"><label for="i-size">Issue size (₹ cr)</label><input id="i-size" class="input num" type="number" min="0" [(ngModel)]="f.issue_size_cr" /></div>
          </div>
          <div class="cols">
            <div class="field"><label for="i-gmp">Grey-market premium (₹)</label><input id="i-gmp" class="input num" type="number" [(ngModel)]="f.gmp" /></div>
            <div class="field"><label for="i-sub">Subscription</label><input id="i-sub" class="input" [(ngModel)]="f.subscription" placeholder="e.g. 45x overall, 120x retail" /></div>
            <div class="field"><label for="i-sym">NSE symbol (after listing)</label><input id="i-sym" class="input" [(ngModel)]="f.symbol" /></div>
          </div>
          <label class="check"><input type="checkbox" [(ngModel)]="f.applied" /> I applied</label>
          @if (f.applied) {
            <div class="cols">
              <div class="field"><label for="i-la">Lots applied</label><input id="i-la" class="input num" type="number" min="1" [(ngModel)]="f.lots_applied" /></div>
              <div class="field"><label for="i-lal">Lots allotted</label><input id="i-lal" class="input num" type="number" min="0" [(ngModel)]="f.lots_allotted" /></div>
              <div class="field"><label for="i-lp">Listing price (₹)</label><input id="i-lp" class="input num" type="number" min="0" [(ngModel)]="f.listing_price" /></div>
            </div>
          }
          <div class="field"><label for="i-notes">Notes</label><input id="i-notes" class="input" [(ngModel)]="f.notes" placeholder="What you like or worry about" /></div>
          @if (formError()) { <div class="notice bad">{{ formError() }}</div> }
          <div class="form-actions"><button class="btn" (click)="form.set(null)">Cancel</button>
            <button class="btn primary" (click)="save()" [disabled]="busy() || !f.name">{{ busy() ? 'Saving…' : 'Save' }}</button></div>
        </div>
      </app-modal>
    }
  `,
  styles: [`
    .gh { font-size: 14px; margin: 18px 0 10px; display: flex; gap: 8px; align-items: baseline; }
    .gh:first-of-type { margin-top: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .ipo { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; background: var(--surface); display: flex; flex-direction: column; gap: 10px; }
    .ipo.open { border-color: var(--primary); box-shadow: 0 0 0 3px var(--accent-soft); }
    .ipo header { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    .ipo header div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .ipo header small { font-size: 12px; }
    .ipo dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 0; font-size: 12.5px; }
    .ipo dt { color: var(--muted); }
    .ipo dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .ipo footer { display: flex; gap: 6px; justify-content: flex-end; margin-top: auto; }
    .ipo p { margin: 0; }
    .empty { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; }
  `],
})
export class IposComponent {
  auth = inject(AuthService);
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  groups = GROUPS;
  ipos = signal<Ipo[] | null>(null);
  error = signal<string | null>(null);
  form = signal<IpoForm | null>(null);
  formError = signal<string | null>(null);
  busy = signal(false);

  byStatus = computed(() => {
    const out: Record<Ipo['status'], Ipo[]> = { open: [], upcoming: [], closed: [], listed: [] };
    for (const i of this.ipos() ?? []) out[i.status].push(i);
    out.upcoming.sort((a, b) => (a.open_date ?? '9').localeCompare(b.open_date ?? '9'));
    return out;
  });

  constructor() {
    effect(() => {
      this.store.scopeKey();
      if (this.auth.token()) queueMicrotask(() => this.load());
    });
  }

  async load() {
    try {
      this.ipos.set(await firstValueFrom(this.api.ipos()));
      this.error.set(null);
    } catch (e) { this.error.set(errorMessage(e)); }
  }

  band(i: Ipo) {
    if (!i.price_low && !i.price_high) return '—';
    if (!i.price_low || i.price_low === i.price_high) return `₹${i.price_high ?? i.price_low}`;
    return `₹${i.price_low} – ${i.price_high}`;
  }

  edit(i?: Ipo) {
    this.formError.set(null);
    this.form.set({
      id: i?.id, name: i?.name ?? '', board: i?.board ?? 'Mainboard', symbol: i?.symbol ?? '', open_date: i?.open_date ?? '',
      close_date: i?.close_date ?? '', allotment_date: i?.allotment_date ?? '', listing_date: i?.listing_date ?? '',
      price_low: i?.price_low ?? null, price_high: i?.price_high ?? null, lot_size: i?.lot_size ?? null, issue_size_cr: i?.issue_size_cr ?? null,
      gmp: i?.gmp ?? null, subscription: i?.subscription ?? '', applied: i?.applied ?? false, lots_applied: i?.lots_applied ?? null,
      lots_allotted: i?.lots_allotted ?? null, listing_price: i?.listing_price ?? null, notes: i?.notes ?? '',
    });
  }

  async save() {
    const f = this.form();
    if (!f) return;
    this.busy.set(true);
    this.formError.set(null);
    const { id, ...body } = f;
    try {
      if (id) await firstValueFrom(this.api.updateIpo(id, body));
      else await firstValueFrom(this.api.addIpo(body));
      this.form.set(null);
      this.toast.ok(id ? 'IPO updated' : `Tracking ${f.name}`);
      await this.load();
    } catch (e) {
      this.formError.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async remove(i: Ipo) {
    if (!await this.confirm.ask(`Delete ${i.name}?`, 'It stops being tracked and its reminders stop.', 'Delete')) return;
    try {
      await firstValueFrom(this.api.deleteIpo(i.id));
      await this.load();
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
}
