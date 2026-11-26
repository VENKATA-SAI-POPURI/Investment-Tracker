import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { errorMessage } from '../../core/http';
import { money } from '../../core/format';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { Router } from '@angular/router';
import { AddKind, TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../icon.component';

interface Tile { label: string; icon: string; color: string; kind: AddKind; market?: string; }

/** "What would you like to add?": pick the kind first, then the familiar form opens on it. */
@Component({
  selector: 'v-add-sheet',
  standalone: true,
  imports: [IconComponent, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="v-dim" (click)="dialog.closePicker()"></div>
    <section class="v-sheet center" role="dialog" aria-modal="true" aria-labelledby="add-title">
      <div class="grab"></div>
      <button class="close" (click)="dialog.closePicker()" aria-label="Close"><app-icon name="close" [size]="16" /></button>
      @if (mode() === 'wallet') {
        <h2 id="add-title">P2P wallet</h2>
        <p class="v-mut sub">Money between your bank and the lending platform's wallet. Lending uses the wallet; repayments go to your bank.</p>
        <div class="v-seg soft" style="margin-bottom:12px">
          <button [class.on]="dir() === 'in'" (click)="dir.set('in')">Add money</button>
          <button [class.on]="dir() === 'out'" (click)="dir.set('out')">Withdraw to bank</button>
        </div>
        <label class="fld"><span>Amount (₹)</span><input class="v-input" type="number" min="1" step="100" [(ngModel)]="amount" name="amount" /></label>
        <label class="fld"><span>Date</span><input class="v-input" type="date" [(ngModel)]="date" name="date" /></label>
        <label class="fld"><span>Platform</span><input class="v-input" [(ngModel)]="platform" name="platform" /></label>
        @if (balance() !== null) { <p class="v-mut hint">Wallet now: {{ money(balance()) }}</p> }
        <div class="row2"><button class="v-btn" (click)="mode.set('pick')">Back</button>
          <button class="v-btn primary" (click)="saveWallet()" [disabled]="saving() || !validAmount() || !date">{{ dir() === 'in' ? 'Add money' : 'Withdraw' }}</button></div>
      } @else {
      <h2 id="add-title">Add an entry</h2>
      <p class="v-mut sub">What would you like to add?</p>
      <div class="tiles">
        @for (t of tiles; track t.label) {
          <button class="tile" [style.--c]="t.color" (click)="pick(t)"><span class="bi"><app-icon [name]="t.icon" [size]="17" [stroke]="2" /></span>{{ t.label }}</button>
        }
      </div>
      <div class="more">
        <button class="v-btn sm" (click)="mode.set('wallet')">P2P wallet top-up / withdrawal</button>
        @for (m of more; track m.label) { <button class="v-btn sm" (click)="dialog.add(m.kind)">{{ m.label }}</button> }
      </div>
      <button class="import" (click)="importIt()">
        <span class="v-tone brand"><app-icon name="upload" [size]="16" /></span>
        <span class="grow"><b>Import a statement</b><small>CAS · Kite · EPF passbook · LenDenClub · CSV</small></span>
        <app-icon name="chevronRight" [size]="16" [stroke]="2.4" />
      </button>
      }
    </section>
  `,
  styles: [`
    h2 { margin: 0; font-size: 17px; font-weight: 800; letter-spacing: -.02em; }
    .sub { font-size: 12.5px; font-weight: 500; margin: 2px 0 16px; }
    .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .tile { border-radius: 18px; padding: 14px 6px 12px; text-align: center; font: inherit; font-size: 12.5px; font-weight: 700; border: 0; cursor: pointer;
      background: color-mix(in srgb, var(--c) 10%, var(--surface-2)); border: 1px solid color-mix(in srgb, var(--c) 28%, transparent); color: var(--text); display: flex;
      transition: transform .2s var(--ease), border-color .2s ease; flex-direction: column; align-items: center; }
    .bi { width: 44px; height: 44px; border-radius: 14px; margin-bottom: 9px; display: grid; place-items: center; color: var(--c);
      background: color-mix(in srgb, var(--c) 18%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 30%, transparent); }
    .tile:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--c) 55%, transparent); }
    .more { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .import { display: flex; align-items: center; gap: 12px; width: 100%; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.16) !important; border-radius: 18px; padding: 13px;
      margin-top: 12px; border: 0; cursor: pointer; font: inherit; text-align: left; color: var(--accent); }
    .fld { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; font-weight: 600; color: var(--muted); margin-bottom: 10px; }
    .hint { font-size: 12.5px; margin: 0 0 10px; }
    .row2 { display: flex; gap: 8px; justify-content: flex-end; }
    .import .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; color: var(--text); }
    .import small { color: var(--muted); font-size: 12.5px; font-weight: 500; }
  `],
})
export class AddSheetComponent {
  dialog = inject(TxnDialogService);
  private router = inject(Router);

  tiles: Tile[] = [
    { label: 'India stock', icon: 'trendUp', color: 'var(--g-equity_india)', kind: 'equity', market: 'India' },
    { label: 'Global stock', icon: 'globe', color: 'var(--g-equity_global)', kind: 'equity', market: 'USA' },
    { label: 'Mutual fund', icon: 'pieChart', color: 'var(--g-mutual_funds)', kind: 'mutual_fund' },
    { label: 'P2P loan', icon: 'handshake', color: 'var(--g-p2p)', kind: 'p2p_loan' },
    { label: 'Commodity', icon: 'gem', color: 'var(--g-commodities)', kind: 'commodity' },
    { label: 'EPF', icon: 'piggy', color: 'var(--g-epf)', kind: 'epf' },
    { label: 'Fixed deposit', icon: 'landmark', color: 'var(--g-others)', kind: 'fixed_deposit' },
    { label: 'NPS', icon: 'shieldCheck', color: 'var(--g-others)', kind: 'nps' },
    { label: 'USD transfer', icon: 'arrowLeftRight', color: 'var(--g-others)', kind: 'forex' },
  ];
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);
  money = money;
  mode = signal<'pick' | 'wallet'>(this.dialog.picker() === 'wallet' ? 'wallet' : 'pick');
  dir = signal<'in' | 'out'>('in');
  amount: number | null = this.dialog.wallet()?.amount ?? null;
  date = new Date().toISOString().slice(0, 10);
  platform = 'LenDenClub';
  saving = signal(false);
  validAmount = () => (this.amount ?? 0) > 0;
  balance = computed(() => {
    const w = this.store.positions().filter(p => p.status === 'wallet');
    return w.length ? w.reduce((s, p) => s + p.value, 0) : null;
  });

  async saveWallet() {
    this.saving.set(true);
    try {
      const out = this.dir() === 'out';
      await firstValueFrom(this.api.addCash({ account: 'p2p_escrow', date: this.date, direction: out ? 'out' : 'in', amount: +this.amount!,
        category: this.platform || null, kind: out ? 'Withdrawal' : 'Deposit', notes: out ? 'Withdrawn to bank' : 'Added from bank' }));
      this.toast.ok(`${out ? 'Withdrawal' : 'Top-up'} of ${money(+this.amount!)} saved`);
      const done = this.dialog.wallet()?.onSaved;
      await this.store.changed();
      this.dialog.closePicker();
      done?.();
    } catch (e) { this.toast.error(errorMessage(e)); } finally { this.saving.set(false); }
  }
  more: { label: string; kind: AddKind }[] = [
    { label: 'Dividend', kind: 'dividend' }, { label: 'P2P repayment', kind: 'p2p_repayment' }, { label: 'Bonus / split', kind: 'corporate_action' },
  ];

  pick(t: Tile) { this.dialog.add(t.kind, t.market ? { market: t.market } : {}); }

  importIt() { this.dialog.closePicker(); void this.router.navigateByUrl('/import'); }

  @HostListener('document:keydown.escape') esc() { this.dialog.closePicker(); }
}
