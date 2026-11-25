import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom, map } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { errorMessage } from '../../core/http';
import { fmtDate, inr, qty } from '../../core/format';
import { AssetClass, CashRule, DataCheck, Trace, Transaction } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { HoldingSheetComponent } from '../../shared/v2/holding-sheet.component';

type Tab = 'entries' | 'flow' | 'checks' | 'rules';
const TYPE: Record<string, { label: string; icon: string; tone: string }> = {
  BUY: { label: 'Buy', icon: 'plus', tone: 'brand' }, SELL: { label: 'Sell', icon: 'arrowUpRight', tone: 'good' },
  DIVIDEND: { label: 'Dividend', icon: 'sparkles', tone: 'good' }, INTEREST: { label: 'Interest', icon: 'sparkles', tone: 'good' },
  REPAYMENT: { label: 'Repayment', icon: 'repeat', tone: 'good' }, MATURITY: { label: 'Matured', icon: 'calendarClock', tone: 'info' },
  FX_IN: { label: 'To US account', icon: 'arrowLeftRight', tone: 'info' }, FX_OUT: { label: 'From US account', icon: 'arrowLeftRight', tone: 'info' },
  CREDIT: { label: 'Interest credited', icon: 'sparkles', tone: 'good' }, BONUS: { label: 'Bonus', icon: 'layers', tone: 'info' },
  SPLIT: { label: 'Split', icon: 'layers', tone: 'info' },
};
const CLASSES: { key: AssetClass | null; label: string }[] = [
  { key: null, label: 'All' }, { key: 'equity', label: 'Stocks' }, { key: 'mutual_fund', label: 'Funds' }, { key: 'commodity', label: 'Commodities' },
  { key: 'p2p', label: 'P2P' }, { key: 'fixed_deposit', label: 'FDs' }, { key: 'epf', label: 'EPF' }, { key: 'nps', label: 'NPS' }, { key: 'cash', label: 'USD' },
];
const CLASS_LABEL: Record<string, string> = { equity: 'Stocks', mutual_fund: 'Mutual funds', commodity: 'Commodities', p2p: 'P2P loans',
  fixed_deposit: 'Fixed deposits', cash: 'USD wallet', epf: 'EPF', nps: 'NPS' };
const ACCOUNT: Record<string, string> = { capital: 'Money invested', p2p_escrow: 'P2P escrow' };

/** Activity: every entry, how one entry flows through the numbers, what in the data needs fixing, and the rules. */
@Component({
  selector: 'app-activity',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, HoldingSheetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="v2">
    <nav class="v-seg" role="tablist" aria-label="Activity">
      @for (t of tabs; track t.key) {
        <button role="tab" [class.on]="tab() === t.key" [attr.aria-selected]="tab() === t.key" (click)="go({ tab: t.key, txn: null, instrument: null })">
          {{ t.label }}@if (t.key === 'checks' && checkCount()) { <b class="cnt">{{ checkCount() }}</b> }</button>
      }
    </nav>

    @switch (tab()) {
    <!-- ══ ENTRIES ══ -->
    @case ('entries') {
      <div class="bar">
        <label class="search"><app-icon name="search" [size]="16" /><input type="search" placeholder="Search name, type or note" [ngModel]="q()" (ngModelChange)="q.set($event)" aria-label="Search entries" /></label>
        @if (auth.canWrite()) { <a class="v-btn sm" routerLink="/import"><app-icon name="upload" [size]="15" /> Import</a> }
      </div>
      <div class="v-filters">
        @for (c of classes; track c.label) { <button [class.on]="cls() === c.key" (click)="cls.set(c.key)">{{ c.label }}</button> }
      </div>
      <section class="v-card tight">
        @for (t of rows(); track t.id; let i = $index) {
          @if (i === 0 || month(t.date) !== month(rows()[i - 1].date)) { <div class="mhd">{{ monthLabel(t.date) }}</div> }
          <button class="v-row" (click)="go({ tab: 'flow', txn: t.id })">
            <span class="v-tone sm" [class]="type(t.type).tone"><app-icon [name]="type(t.type).icon" [size]="16" [stroke]="2.2" /></span>
            <div class="grow"><div class="t">{{ t.instrument_name }}</div>
              <div class="s">{{ type(t.type).label }} · {{ fmtDate(t.date) }}{{ t.quantity && t.type !== 'SPLIT' ? ' · ' + qty(t.quantity) : '' }}{{ t.source !== 'manual' ? ' · ' + t.source : '' }}</div></div>
            <div class="r"><b>{{ inr(t.amount) }}</b><span class="v-link sm">Flow <app-icon name="chevronRight" [size]="12" [stroke]="2.4" /></span></div>
          </button>
        } @empty { <p class="v-empty">{{ loading() ? 'Loading…' : 'No entries match.' }}</p> }
      </section>
      @if (rows().length < total()) { <button class="v-btn" style="align-self:center" (click)="more()" [disabled]="loading()">Show more ({{ total() - rows().length }} left)</button> }
      <a class="v-link" style="align-self:center" routerLink="/transactions">Open the full table (edit many, export)</a>
    }

    <!-- ══ ENTRY FLOW ══ -->
    @case ('flow') {
      @if (trace(); as tr) {
        <section class="v-card head">
          <span class="v-tone" [class]="type(tr.txn.type).tone"><app-icon [name]="type(tr.txn.type).icon" [size]="18" [stroke]="2.2" /></span>
          <div class="grow"><div class="t">{{ tr.txn.type_label }} · {{ tr.instrument.name }}</div>
            <div class="s">{{ tr.txn.quantity ? qty(tr.txn.quantity) + ' · ' : '' }}{{ inr(tr.txn.amount) }} · {{ fmtDate(tr.txn.date) }} · {{ tr.txn.source }}</div></div>
          @if (auth.canWrite()) { <button class="v-link" (click)="edit(tr.txn.id)"><app-icon name="edit" [size]="14" /> Edit</button> }
        </section>
        <section class="v-card">
          @for (s of tr.steps; track s.key; let last = $last) {
            <div class="step" [class.last]="last">
              <span class="v-tone sic" [class]="s.tone"><app-icon [name]="s.icon" [size]="17" /></span>
              <div class="body">
                <div class="st">{{ s.title }}</div>
                <div class="sd">{{ s.text }}</div>
                @if (s.formula) { <span class="fx">{{ s.formula }}</span> }
                @for (it of s.items; track $index) { <div class="it">{{ it }}</div> }
                @if (s.code) { <div class="code"><app-icon name="gitBranch" [size]="12" /> {{ s.code }}</div> }
              </div>
            </div>
          }
          <div class="foot"><button class="v-link" (click)="go({ tab: 'rules', txn: null })"><app-icon name="fileText" [size]="14" /> All cash rules</button>
            <button class="v-link" (click)="holding.set(tr.instrument.id)">Open {{ tr.instrument.name }} <app-icon name="chevronRight" [size]="14" [stroke]="2.4" /></button></div>
        </section>
      } @else if (traceError()) {
        <section class="v-card v-empty">{{ traceError() }}</section>
      } @else if (txnId()) {
        <div class="v-skel" style="height:420px"></div>
      } @else {
        <section class="v-card">
          <div class="v-ch"><h2>Pick an entry</h2><span class="hint">to see each step it goes through</span></div>
          @for (t of pickList(); track t.id) {
            <button class="v-row" (click)="go({ tab: 'flow', txn: t.id })">
              <span class="v-tone sm" [class]="type(t.type).tone"><app-icon [name]="type(t.type).icon" [size]="16" [stroke]="2.2" /></span>
              <div class="grow"><div class="t">{{ t.instrument_name }}</div><div class="s">{{ type(t.type).label }} · {{ fmtDate(t.date) }}</div></div>
              <div class="r"><b>{{ inr(t.amount) }}</b></div>
            </button>
          } @empty { <p class="v-empty">{{ loading() ? 'Loading…' : 'No entries yet.' }}</p> }
        </section>
      }
    }

    <!-- ══ CHECKS ══ -->
    @case ('checks') {
      @if (checks(); as cs) {
        @if (!cs.length) {
          <section class="v-card v-empty"><span class="v-tone good"><app-icon name="circleCheck" [size]="22" /></span>
            <b style="color:var(--text)">Your data looks consistent</b><span>No unmatched sales, missing prices, stale FDs or duplicates.</span></section>
        }
        @for (c of cs; track c.id) {
          <section class="v-card chk">
            <div class="ch-top"><span class="v-tone" [class]="c.severity === 'bad' ? 'bad' : c.severity === 'warn' ? 'warn' : 'info'"><app-icon [name]="c.severity === 'info' ? 'info' : 'triangleAlert'" [size]="19" /></span>
              <div class="grow"><div class="t">{{ c.title }}</div><div class="s">{{ c.detail }}</div></div><span class="v-pill eq">{{ c.count }}</span></div>
            @for (it of c.items.slice(0, openCheck() === c.id ? 30 : 4); track $index) {
              <button class="v-row" (click)="it.txn_id ? go({ tab: 'flow', txn: it.txn_id }) : holding.set(it.instrument_id)">
                <div class="grow"><div class="t sm">{{ it.name }}</div><div class="s">{{ it.detail }}</div></div><app-icon name="chevronRight" [size]="16" [stroke]="2.2" /></button>
            }
            @if (c.items.length > 4 && openCheck() !== c.id) { <button class="v-link" (click)="openCheck.set(c.id)">Show all {{ c.items.length }}</button> }
            <div class="fix"><b>Fix:</b> {{ c.fix }}@if (c.link) { <a class="v-link" [routerLink]="c.link"> Open</a> }</div>
          </section>
        }
      } @else { <div class="v-skel" style="height:240px"></div> }
    }

    <!-- ══ RULES ══ -->
    @case ('rules') {
      <p class="v-mut lead">What each kind of entry records as money in or out. This table is produced by running the app's own code on a sample of each entry.</p>
      <div class="v-grid cols-2">
      @for (g of ruleGroups(); track g.cls) {
        <section class="v-card">
          <div class="v-ch"><h2>{{ g.label }}</h2></div>
          @for (r of g.rules; track r.id) {
            <div class="rule">
              <div class="rh"><span class="rid">{{ r.id }}</span><b>{{ type(r.type).label }}</b></div>
              @if (r.entries.length) {
                @for (e of r.entries; track $index) { <div class="re"><span class="v-pill" [class.ok]="e.direction === 'in'" [class.warn]="e.direction === 'out'">{{ e.direction }}</span> {{ account(e.account) }}{{ e.category ? ' · ' + e.category : '' }}</div> }
              } @else { <div class="re v-mut">No cash entry</div> }
              @if (r.import_entries && r.import_entries.length !== r.entries.length) { <div class="re v-mut">Imported: also {{ account(r.import_entries[r.import_entries.length - 1].account) }} {{ r.import_entries[r.import_entries.length - 1].direction }}</div> }
              @if (r.note) { <div class="rn">{{ r.note }}</div> }
            </div>
          }
        </section>
      }
      </div>
      <p class="v-mut lead">Code: <code>backend/tracker/ledger.py · Ledger._auto_cash</code>. Change a rule there and this page follows.</p>
    }
    }
  </div>
  @if (holding(); as id) { <v-holding-sheet [id]="id" (closed)="holding.set(null)" /> }
  `,
  styles: [`
    .cnt { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; margin-left: 5px; border-radius: 99px;
      background: var(--warn); color: #fff; font-size: 11px; }
    .bar { display: flex; gap: 8px; align-items: center; }
    .search { flex: 1; display: flex; align-items: center; gap: 8px; background: var(--surface); border-radius: 14px; padding: 0 12px; box-shadow: var(--shadow); color: var(--muted); }
    .search input { flex: 1; border: 0; background: none; font: inherit; padding: 11px 0; outline: none; color: var(--text); min-width: 0; }
    .mhd { font-size: 11.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); padding: 14px 0 2px; }
    .v-tone.sm { width: 34px; height: 34px; border-radius: 11px; }
    .v-link.sm { font-size: 12px; }
    .t.sm { font-size: 13.5px; }
    .head { display: flex; align-items: center; gap: 12px; }
    .head .grow, .chk .grow { min-width: 0; flex: 1; }
    .head .t, .chk .t { font-weight: 800; font-size: 15px; }
    .head .s, .chk .s { font-size: 12.5px; color: var(--muted); font-weight: 500; }
    .step { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 12px; position: relative; padding-bottom: 16px; }
    .step::before { content: ""; position: absolute; left: 17px; top: 40px; bottom: 2px; width: 2px; background: var(--border); }
    .step.last::before { display: none; }
    .sic { width: 36px; height: 36px; border-radius: 12px; z-index: 1; }
    .st { font-weight: 800; font-size: 14px; }
    .sd { font-size: 13px; color: var(--text-2); font-weight: 500; }
    .fx { display: inline-block; font-size: 12.5px; font-weight: 700; background: var(--bg); border-radius: 9px; padding: 5px 9px; margin-top: 6px; }
    .it { font-size: 12.5px; color: var(--text-2); margin-top: 4px; padding-left: 10px; border-left: 2px solid var(--border); }
    .code { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--muted); margin-top: 6px; display: flex; align-items: center; gap: 4px; }
    .foot { display: flex; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border); padding-top: 12px; flex-wrap: wrap; }
    .ch-top { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 6px; }
    .fix { font-size: 12.5px; color: var(--text-2); margin-top: 8px; background: var(--bg); border-radius: 12px; padding: 9px 11px; }
    .lead { font-size: 13px; font-weight: 500; margin: 0 4px; }
    .rule { padding: 10px 0; border-top: 1px solid var(--border); }
    .rule:first-of-type { border-top: 0; padding-top: 0; }
    .rh { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .rid { font-size: 11px; font-weight: 800; color: var(--muted); background: var(--bg); border-radius: 6px; padding: 1px 6px; }
    .re { font-size: 13px; margin-top: 5px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .rn { font-size: 12px; color: #8a5207; background: var(--warn-soft); border-radius: 10px; padding: 7px 9px; margin-top: 6px; }
    code { font-size: 12px; }
  `],
})
export class ActivityComponent {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private store = inject(StoreService);
  private dialog = inject(TxnDialogService);
  auth = inject(AuthService);

  inr = inr; qty = qty; fmtDate = fmtDate; classes = CLASSES;
  tabs: { key: Tab; label: string }[] = [{ key: 'entries', label: 'Entries' }, { key: 'flow', label: 'Entry flow' }, { key: 'checks', label: 'Checks' }, { key: 'rules', label: 'Rules' }];
  type = (t: string) => TYPE[t] ?? { label: t, icon: 'info', tone: 'info' };
  account = (a: string) => ACCOUNT[a] ?? a;
  month = (d: string) => d.slice(0, 7);
  monthLabel = (d: string) => new Date(d.slice(0, 7) + '-01T00:00:00').toLocaleString('en-IN', { month: 'long', year: 'numeric' });

  private qp = toSignal(this.route.queryParamMap.pipe(map(q => ({ tab: q.get('tab'), txn: q.get('txn'), instrument: q.get('instrument') }))),
    { initialValue: { tab: null as string | null, txn: null as string | null, instrument: null as string | null } });
  tab = computed<Tab>(() => (['entries', 'flow', 'checks', 'rules'].includes(this.qp().tab ?? '') ? this.qp().tab : 'entries') as Tab);
  txnId = computed(() => { const n = Number(this.qp().txn); return n > 0 ? n : null; });
  instrumentId = computed(() => { const n = Number(this.qp().instrument); return n > 0 ? n : null; });
  holding = signal<number | null>(null);

  // entries
  q = signal('');
  cls = signal<AssetClass | null>(null);
  rows = signal<Transaction[]>([]);
  total = signal(0);
  loading = signal(false);
  private page = 1;
  private seq = 0;
  pickList = signal<Transaction[]>([]);

  // flow, checks, rules
  trace = signal<Trace | null>(null);
  traceError = signal<string | null>(null);
  checks = signal<DataCheck[] | null>(null);
  checkCount = computed(() => (this.checks() ?? []).filter(c => c.severity !== 'info').reduce((s, c) => s + c.count, 0));
  openCheck = signal<string | null>(null);
  rules = signal<CashRule[]>([]);
  ruleGroups = computed(() => {
    const out: { cls: string; label: string; rules: CashRule[] }[] = [];
    for (const r of this.rules()) {
      let g = out.find(x => x.cls === r.asset_class);
      if (!g) out.push(g = { cls: r.asset_class, label: CLASS_LABEL[r.asset_class] ?? r.asset_class, rules: [] });
      g.rules.push(r);
    }
    return out;
  });

  constructor() {
    effect(() => {
      const q = this.q(), cls = this.cls();
      this.store.version();
      if (this.tab() !== 'entries') return;
      untracked(() => { this.page = 1; void this.loadPage(q, cls, false); });
    });
    effect(() => {
      const id = this.txnId(), tab = this.tab();
      this.store.version();
      if (tab !== 'flow') return;
      untracked(() => {
        if (id) void this.loadTrace(id);
        else { this.trace.set(null); void this.loadPick(this.instrumentId()); }
      });
    });
    effect(() => {
      this.store.version();
      untracked(() => void firstValueFrom(this.api.checks()).then(c => this.checks.set(c)).catch(() => this.checks.set([])));
    });
    effect(() => {
      if (this.tab() === 'rules' && !this.rules().length) untracked(() => void firstValueFrom(this.api.cashRules()).then(r => this.rules.set(r)).catch(() => {}));
    });
  }

  private async loadPage(q: string, cls: AssetClass | null, append: boolean) {
    const n = ++this.seq;
    this.loading.set(true);
    try {
      const r = await firstValueFrom(this.api.transactionsPage({ page: this.page, size: 50, q, sort: '-date', asset_class: cls }));
      if (n !== this.seq) return;
      this.rows.set(append ? [...this.rows(), ...r.rows] : r.rows);
      this.total.set(r.total);
    } catch { if (!append) this.rows.set([]); } finally { if (n === this.seq) this.loading.set(false); }
  }

  more() { this.page++; void this.loadPage(this.q(), this.cls(), true); }

  private async loadTrace(id: number) {
    this.traceError.set(null);
    if (this.trace()?.txn.id !== id) this.trace.set(null);
    try { this.trace.set(await firstValueFrom(this.api.trace(id))); } catch (e) { this.traceError.set(errorMessage(e)); }
  }

  private async loadPick(instrument: number | null) {
    this.loading.set(true);
    try {
      const r = await firstValueFrom(this.api.transactionsPage({ page: 1, size: 20, sort: '-date', instrument_id: instrument }));
      this.pickList.set(r.rows);
    } catch { this.pickList.set([]); } finally { this.loading.set(false); }
  }

  go(p: { tab: Tab; txn?: number | null; instrument?: number | null }) {
    void this.router.navigate([], { queryParams: { tab: p.tab, txn: p.txn ?? null, instrument: p.instrument ?? null } });
  }

  async edit(id: number) {
    try {
      const t = (await firstValueFrom(this.api.transactions({ instrument_id: this.trace()?.instrument.id }))).find(x => x.id === id);
      if (t) this.dialog.edit(t);
    } catch { /* the form simply doesn't open */ }
  }
}
