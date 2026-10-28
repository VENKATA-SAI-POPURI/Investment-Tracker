import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../core/api.service';
import { FORMAT_PIPES, inr, today } from '../core/format';
import { errorMessage } from '../core/http';
import { AssetClass, Position, SymbolHit, TXN_LABEL, TxnType } from '../core/models';
import { StoreService } from '../core/store.service';
import { ToastService } from '../core/toast.service';
import { AddKind, TxnDialogState } from '../core/txn-dialog.service';
import { IconComponent } from './icon.component';
import { ModalComponent } from './ui';

const KINDS: { kind: AddKind; label: string; hint: string; icon: string }[] = [
  { kind: 'equity', label: 'Stock', hint: 'Buy or sell shares (India or US)', icon: 'trend' },
  { kind: 'mutual_fund', label: 'Mutual fund', hint: 'SIP instalment, lump sum or redemption', icon: 'layers' },
  { kind: 'commodity', label: 'Commodity / ETF', hint: 'Gold, silver and other ETFs', icon: 'coins' },
  { kind: 'dividend', label: 'Dividend', hint: 'Dividend received on a holding', icon: 'wallet' },
  { kind: 'p2p_loan', label: 'P2P loan', hint: 'New loan given on a P2P platform', icon: 'users' },
  { kind: 'p2p_repayment', label: 'P2P repayment', hint: 'Principal and interest received', icon: 'refresh' },
  { kind: 'fixed_deposit', label: 'Fixed deposit', hint: 'Open a new FD', icon: 'bank' },
  { kind: 'forex', label: 'USD transfer', hint: 'Move money to or from your US account', icon: 'globe' },
];

const SECTORS = ['Information Technology', 'Financials', 'Health Care', 'Consumer Discretionary', 'Consumer Staples', 'Industrials',
  'Energy', 'Materials', 'Utilities', 'Real Estate', 'Communication Services', 'Diversified'];
const CAPS = ['Mega Cap', 'Large Cap', 'Mid Cap', 'Small Cap'];
const MF_CATEGORIES = ['Equity', 'ELSS', 'Index', 'Hybrid', 'Sectoral', 'Debt', 'Liquid', 'International'];

@Component({
  selector: 'app-txn-form',
  standalone: true,
  imports: [FormsModule, ModalComponent, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './txn-form.component.html',
  styles: [`
    .kinds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .kind { display: flex; gap: 12px; align-items: flex-start; text-align: left; padding: 12px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface); cursor: pointer; }
    .kind:hover { border-color: var(--accent); background: var(--surface-2); }
    .kind .ic { display: inline-flex; width: 32px; height: 32px; border-radius: 8px; background: var(--accent-soft); color: var(--accent-strong); align-items: center; justify-content: center; flex: none; }
    .kind b { display: block; font-weight: 600; }
    .kind span.h { font-size: 12.5px; color: var(--text-2); }
    .hits { max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
    .hit { display: flex; justify-content: space-between; gap: 10px; width: 100%; text-align: left; padding: 8px 10px; border: 0; border-bottom: 1px solid var(--border); background: none; cursor: pointer; }
    .hit:hover { background: var(--surface-2); }
    .calc { font-size: 12.5px; color: var(--text-2); background: var(--surface-2); border-radius: 8px; padding: 8px 10px; }
    @media (max-width: 480px) { .kinds { grid-template-columns: minmax(0, 1fr); } }
  `],
})
export class TxnFormComponent implements OnInit {
  state = input.required<TxnDialogState>();
  done = output<void>();

  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);

  kinds = KINDS; sectors = SECTORS; caps = CAPS; mfCategories = MF_CATEGORIES;
  kind = signal<AddKind | null>(null);
  saving = signal(false);
  error = signal<string | null>(null);
  hits = signal<SymbolHit[] | null>(null);
  searching = signal(false);
  addAnother = false;

  f: any = this.blank();

  private blank() {
    return { type: 'BUY', date: today(), name: '', instrument_id: null, quantity: null, amount: null, amount_fc: null, notes: '',
      market: 'India', sector: '', market_cap: '', category: '', sub_category: '', symbol: '', principal: null, interest: null,
      fees: null, platform: 'LenDen', ref2: '', rate: null, tenure_months: null, maturity_date: '', direction: 'FX_IN' };
  }

  isEdit = computed(() => this.state().mode === 'edit');
  title = computed(() => {
    if (this.isEdit()) return 'Edit transaction';
    const k = KINDS.find(x => x.kind === this.kind());
    return k ? `Add ${k.label.toLowerCase()}` : 'Add transaction';
  });
  assetClass = computed<AssetClass | null>(() => {
    const k = this.kind();
    if (k === 'equity' || k === 'mutual_fund' || k === 'commodity') return k;
    if (k === 'dividend') return 'equity';
    return null;
  });
  holdings = computed(() => {
    const ac = this.assetClass();
    const pos = this.store.positions();
    if (this.kind() === 'dividend') return pos.filter(p => p.asset_class === 'equity' || p.asset_class === 'mutual_fund');
    return pos.filter(p => p.asset_class === ac);
  });
  loans = computed(() => this.store.positions().filter(p => p.asset_class === 'p2p' && (p.is_open || p.id === this.f.instrument_id))
    .sort((a, b) => (a.ref ?? '').localeCompare(b.ref ?? '')));

  ngOnInit() {
    const s = this.state();
    if (s.mode === 'edit' && s.txn) {
      const t = s.txn;
      const ac = t.asset_class;
      this.kind.set(ac === 'p2p' ? (t.type === 'BUY' ? 'p2p_loan' : 'p2p_repayment') : ac === 'fixed_deposit' ? 'fixed_deposit'
        : ac === 'cash' ? 'forex' : t.type === 'DIVIDEND' ? 'dividend' : (ac as AddKind));
      Object.assign(this.f, {
        type: t.type, date: t.date, name: t.instrument_name, instrument_id: t.instrument_id, quantity: t.quantity, amount: t.amount,
        amount_fc: t.amount_fc, notes: t.notes ?? '', principal: t.principal, fees: t.fees, direction: t.type,
        interest: t.type === 'REPAYMENT' && t.principal !== null ? +(t.amount - t.principal).toFixed(2) : null,
      });
      return;
    }
    if (s.kind) this.kind.set(s.kind);
    if (s.instrumentId) {
      const p = this.store.positions().find(x => x.id === s.instrumentId);
      if (p) { this.f.instrument_id = p.id; this.f.name = p.name; this.f.market = p.market || 'India'; }
    }
    if (s.type) this.f.type = s.type;
    if (s.kind === 'dividend') this.f.type = 'DIVIDEND';
  }

  pick(k: AddKind) {
    this.kind.set(k);
    this.f.type = k === 'dividend' ? 'DIVIDEND' : 'BUY';
  }

  /** The existing holding matching the typed name, if any. */
  existing(): Position | undefined {
    if (this.f.instrument_id) return this.store.positions().find(p => p.id === this.f.instrument_id);
    const n = (this.f.name || '').trim().toLowerCase();
    return n ? this.holdings().find(p => p.name.toLowerCase() === n) : undefined;
  }
  onName() {
    this.f.instrument_id = null;
    const e = this.existing();
    if (e) this.f.market = e.market || 'India';
  }
  isUsd() { return (this.existing()?.market ?? this.f.market) === 'USA'; }
  typeLabel(t: string) { return TXN_LABEL[t as TxnType] ?? t; }
  unitPrice() {
    const q = +this.f.quantity, a = +this.f.amount;
    return q > 0 && a > 0 ? a / q : null;
  }
  fxRate() { return this.store.portfolio()?.usd_inr ?? null; }
  fillInr() {
    const fx = this.fxRate();
    if (fx && this.f.amount_fc) this.f.amount = +(this.f.amount_fc * fx).toFixed(2);
  }
  repaymentTotal() { return (+this.f.principal || 0) + (+this.f.interest || 0); }

  async searchSymbol() {
    const q = (this.f.name || '').trim();
    if (q.length < 2) return;
    this.searching.set(true);
    try {
      this.hits.set(await firstValueFrom(this.api.searchSymbols(q, this.assetClass() ?? undefined)));
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.searching.set(false);
    }
  }
  chooseHit(h: SymbolHit) {
    this.f.symbol = h.symbol;
    if (h.symbol.endsWith('.NS') || h.symbol.endsWith('.BO') || h.source === 'amfi') this.f.market = 'India';
    else if (!h.symbol.includes('.')) this.f.market = 'USA';
    this.hits.set(null);
  }

  private require(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

  async save() {
    this.error.set(null);
    const f = this.f, k = this.kind();
    try {
      this.require(!!f.date, 'Pick a date');
      let msg = 'Saved';
      this.saving.set(true);
      if (this.isEdit()) {
        const t = this.state().txn!;
        const body: any = { date: f.date, notes: f.notes, quantity: f.quantity, amount: f.amount, amount_fc: f.amount_fc, fees: f.fees };
        if (t.type === 'REPAYMENT') { body.principal = +f.principal || 0; body.amount = this.repaymentTotal(); }
        if (t.type === 'FX_IN' || t.type === 'FX_OUT') body.type = f.direction;
        if (t.type === 'BUY' || t.type === 'SELL') body.type = f.type;
        await firstValueFrom(this.api.updateTransaction(t.id, body));
        msg = 'Transaction updated';
      } else if (k === 'equity' || k === 'mutual_fund' || k === 'commodity' || k === 'dividend') {
        this.require(!!f.name?.trim(), 'Enter the holding name');
        this.require(+f.amount > 0, 'Enter the amount');
        if (f.type !== 'DIVIDEND') this.require(+f.quantity > 0, 'Enter the quantity');
        const ex = this.existing();
        if (k === 'dividend') this.require(!!ex, 'Choose one of your holdings');
        const body: any = { type: f.type, date: f.date, quantity: f.type === 'DIVIDEND' ? null : f.quantity, amount: f.amount,
          amount_fc: this.isUsd() ? f.amount_fc : null, notes: f.notes };
        if (ex) body.instrument_id = ex.id;
        else body.instrument = { asset_class: this.assetClass(), name: f.name.trim(), market: f.market, sector: f.sector,
          market_cap: f.market_cap, category: f.category, sub_category: f.sub_category, symbol: f.symbol };
        await firstValueFrom(this.api.addTransaction(body));
        msg = `${this.typeLabel(f.type)} of ${f.name.trim()} saved · ${inr(+f.amount)}`;
      } else if (k === 'p2p_loan') {
        this.require(+f.amount > 0, 'Enter the loan amount');
        this.require(!!(f.name || f.ref2), 'Enter the borrower name or loan id');
        const inst = await firstValueFrom(this.api.addLoan({ name: f.name || f.ref2, ref2: f.ref2, platform: f.platform, date: f.date,
          amount: f.amount, tenure_months: f.tenure_months, rate: f.rate, notes: f.notes }));
        msg = `Loan ${inst.ref} added`;
      } else if (k === 'p2p_repayment') {
        this.require(!!f.instrument_id, 'Choose the loan');
        this.require(this.repaymentTotal() > 0, 'Enter principal and/or interest');
        await firstValueFrom(this.api.addTransaction({ instrument_id: f.instrument_id, type: 'REPAYMENT', date: f.date,
          amount: this.repaymentTotal(), principal: +f.principal || 0, fees: f.fees, notes: f.notes }));
        msg = `Repayment of ${inr(this.repaymentTotal())} saved`;
      } else if (k === 'fixed_deposit') {
        this.require(!!f.name?.trim(), 'Enter the bank');
        this.require(+f.amount > 0, 'Enter the deposit amount');
        await firstValueFrom(this.api.addFd({ name: f.name, platform: f.platform === 'LenDen' ? '' : f.platform, date: f.date,
          amount: f.amount, rate: f.rate, maturity_date: f.maturity_date, notes: f.notes }));
        msg = `FD at ${f.name} added`;
      } else if (k === 'forex') {
        this.require(+f.amount > 0 && +f.amount_fc > 0, 'Enter both the rupee and dollar amounts');
        await firstValueFrom(this.api.addForex({ type: f.direction, date: f.date, amount: f.amount, amount_fc: f.amount_fc, notes: f.notes }));
        msg = 'USD transfer saved';
      }
      this.toast.ok(msg);
      await this.store.changed();
      if (this.addAnother && !this.isEdit()) {
        const keep = { kind: this.kind(), date: f.date, type: f.type, market: f.market, platform: f.platform };
        this.f = { ...this.blank(), ...keep };
      } else {
        this.done.emit();
      }
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }
}
