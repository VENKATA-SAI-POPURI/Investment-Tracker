import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { money } from '../../core/format';
import { GROUP_HEX, GroupKey, groupMeta } from '../../core/groups';
import { errorMessage } from '../../core/http';
import { linkPath, linkQuery, toneClass } from '../../core/links';
import { GroupRebalance, GroupRebalanceRow, GroupRow, Position, TodoItem } from '../../core/models';
import { OverviewService } from '../../core/overview.service';
import { StoreService } from '../../core/store.service';
import { AddKind, TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';

type Step = 'amount' | 'plan' | 'record' | 'done';
const STEPS: { key: Step; label: string }[] = [
  { key: 'amount', label: 'Amount' }, { key: 'plan', label: 'Plan' }, { key: 'record', label: 'Record' }, { key: 'done', label: 'Done' },
];

/** How new money reaches each group: the add-entry form it opens (P2P goes to the wallet first, Global stocks to the
 *  US account first, Others as a new FD). EPF never appears: it can't be topped up by hand. */
const KIND: Record<string, { kind: AddKind | 'wallet'; market?: string; label: string }> = {
  equity_india: { kind: 'equity', market: 'India', label: 'Buy shares' },
  equity_global: { kind: 'forex', label: 'Send money to your US account' },
  mutual_funds: { kind: 'mutual_fund', label: 'Buy a fund' },
  p2p: { kind: 'wallet', label: 'Top up the P2P wallet' },
  commodities: { kind: 'commodity', label: 'Buy gold / silver' },
  others: { kind: 'fixed_deposit', label: 'Open an FD' },
};

interface Leg { row: GroupRebalanceRow; holding: number | null; done: boolean; skipped: boolean; }

/** The guided "Put new money to work" flow (`/flow/invest?amount=&from=`): Amount → Plan (GET /overview/rebalance,
 *  buys only) → Record (each buy opens the add-entry form pre-filled; saving ticks it off) → Done (the mix before and
 *  after, the gap to the targets, and the next job). Reached from Home's To do, an FD maturing and Analysis › Mix. */
@Component({
  selector: 'app-invest-flow',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="v2 flow">
    <div class="bar"><button class="x" (click)="exit()" aria-label="Close"><app-icon name="close" [size]="20" [stroke]="2.2" /></button>
      <span class="ttl">Put new money to work</span></div>
    <ol class="stepper" aria-label="Steps">
      @for (s of steps; track s.key; let i = $index) {
        <li [class.d]="i < stepIndex()" [class.c]="i === stepIndex()" [attr.aria-current]="i === stepIndex() ? 'step' : null">{{ s.label }}</li>
      }
    </ol>

    @switch (step()) {
    @case ('amount') {
      @if (fromName()) { <div class="v-note info"><app-icon name="calendarClock" [size]="18" /><span><b>{{ fromName() }}</b> pays back {{ money(+(route.snapshot.queryParamMap.get('amount') ?? 0)) }}. Put it where it fills your gaps.</span></div> }
      <h1 class="q">How much are you adding?</h1>
      <label class="money"><span>₹</span><input type="number" min="0" step="1000" [(ngModel)]="amount" aria-label="Amount to invest" /></label>
      <div class="chips">@for (q of quick(); track q) { <button class="v-btn sm" [class.dark]="amount === q" (click)="amount = q">{{ money(q) }}</button> }</div>
      @if (usual()) { <p class="v-mut hint">You usually add about {{ money(usual()) }} a month (EPF left out).</p> }
      <button class="v-btn primary big" [disabled]="!(amount > 0) || loading()" (click)="toPlan()">{{ loading() ? 'Working it out…' : 'See where it should go' }} <app-icon name="chevronRight" [size]="16" [stroke]="2.4" /></button>
    }

    @case ('plan') {
      <div class="picked"><span class="ck"><app-icon name="check" [size]="16" [stroke]="2.6" /></span>
        <div class="grow"><small>You're adding</small><b>{{ money(amount) }}</b></div><button class="v-link" (click)="step.set('amount')">Change</button></div>
      <h1 class="q">Split it across {{ buys().length }} group{{ buys().length === 1 ? '' : 's' }}</h1>
      <p class="sub">Buys only, no selling. The money goes to the groups furthest below {{ plan()?.target_set === 'mine' ? 'your targets' : 'the suggested mix' }}.</p>
      <section class="v-card tight">
        @for (r of buys(); track r.key) {
          <div class="v-row" [style.--c]="hex(r.key)">
            <span class="v-ic"><app-icon [name]="meta(r.key).icon" [size]="18" /></span>
            <div class="grow"><div class="t">{{ r.label }}</div><div class="s">{{ r.current_pct.toFixed(1) }}% → {{ r.after_pct.toFixed(1) }}% · target {{ r.target_pct }}%</div></div>
            <b class="v-gain amt">{{ money(r.amount) }}</b>
          </div>
        } @empty { <p class="v-empty">Everything is already on target. Nothing to buy.</p> }
      </section>
      @if (epfOver()) { <div class="v-note info"><app-icon name="info" [size]="18" /><span>EPF stays over target: it can't be sold, and its share shrinks as you add elsewhere.</span></div> }
      @if (!plan()?.target_set || plan()?.target_set === 'suggested') { <p class="v-mut hint">No targets of your own yet, so this uses the suggested mix. <a routerLink="/analysis" [queryParams]="{ q: 'mix' }">Set yours</a></p> }
      @if (buys().length) { <button class="v-btn primary big" (click)="toRecord()">Next: record the buys <app-icon name="chevronRight" [size]="16" [stroke]="2.4" /></button> }
    }

    @case ('record') {
      <h1 class="q">Record each buy</h1>
      <p class="sub">Tap Record once you've bought it. The form opens with the amount filled in; change it to what you actually paid.</p>
      <section class="v-card tight">
        @for (l of legs(); track l.row.key) {
          <div class="v-row leg" [class.done]="l.done" [class.skip]="l.skipped" [style.--c]="hex(l.row.key)">
            <span class="v-ic">@if (l.done) { <app-icon name="check" [size]="18" [stroke]="2.6" /> } @else { <app-icon [name]="meta(l.row.key).icon" [size]="18" /> }</span>
            <div class="grow"><div class="t">{{ l.row.label }} · {{ money(l.row.amount) }}</div>
              <div class="s">{{ l.done ? 'Recorded' : l.skipped ? 'Skipped' : how(l.row.key) }}</div>
              @if (!l.done && !l.skipped && options(l.row.key).length) {
                <select class="v-input pick" [ngModel]="l.holding" (ngModelChange)="setHolding(l, $event)" [attr.aria-label]="'Holding for ' + l.row.label">
                  @for (p of options(l.row.key); track p.id) { <option [ngValue]="p.id">{{ p.name }}</option> }
                  <option [ngValue]="null">Something new…</option>
                </select>
              }
            </div>
            @if (!l.done && !l.skipped) {
              <div class="acts"><button class="v-btn sm primary" (click)="record(l)">Record</button><button class="v-link" (click)="skip(l)">Skip</button></div>
            } @else if (l.skipped) { <button class="v-link" (click)="unskip(l)">Undo</button> }
          </div>
        }
      </section>
      <button class="v-btn primary big" [disabled]="!anyDone() || finishing()" (click)="finish()">{{ finishing() ? 'Updating…' : allSettled() ? 'Finish' : 'Finish with what I recorded' }}</button>
    }

    @case ('done') {
      <div class="okay"><span><app-icon name="circleCheck" [size]="34" /></span>
        <h1 class="q">{{ recorded() }} entr{{ recorded() === 1 ? 'y' : 'ies' }} saved</h1><p class="sub">{{ money(recordedAmount()) }} put to work</p></div>
      <section class="v-card">
        <div class="v-ch"><h2>What changed</h2></div>
        @for (c of changes(); track c.key) {
          <div class="chrow" [style.--c]="hex(c.key)"><span class="nm">{{ c.label }}</span>
            <div class="v-track"><b [style.width.%]="c.reach"></b><i style="left:100%"></i></div>
            <span class="v">{{ c.after.toFixed(1) }}% <small [class.v-gain]="c.after > c.before" [class.v-mut]="c.after <= c.before">{{ c.after > c.before ? '+' : '' }}{{ (c.after - c.before).toFixed(1) }}</small></span></div>
        }
        <p class="v-mut hint">Bar = how much of the target is reached.</p>
      </section>
      @if (gap(); as g) {
        <section class="v-card gap"><div class="grow"><small>Gap to your targets</small><b>{{ money(g.before) }} → {{ money(g.after) }}</b></div>
          @if (g.before > 0) { <span class="v-pill" [class.ok]="g.after < g.before">{{ g.after <= g.before ? '−' : '+' }}{{ Math.abs((1 - g.after / g.before) * 100).toFixed(0) }}%</span> }</section>
      }
      @if (next(); as n) {
        <div class="v-sec"><h2>Next</h2></div>
        <section class="v-card tight"><div class="v-row v-todo"><span [class]="toneClass(n.tone)"><app-icon [name]="n.icon" [size]="20" /></span>
          <div class="grow"><div class="tt">{{ n.title }}</div>@if (n.detail) { <div class="td">{{ n.detail }}</div> }</div>
          <a class="v-btn sm" [routerLink]="path(n.link)" [queryParams]="query(n.link)">{{ n.cta }}</a></div></section>
      }
      <a class="v-btn big" routerLink="/">Back to Home</a>
    }
    }
    @if (error()) { <div class="v-note warn"><app-icon name="alert" [size]="18" /><span>{{ error() }}</span></div> }
  </div>
  `,
  styles: [`
    .flow { max-width: 640px; }
    .bar { display: flex; align-items: center; gap: 10px; }
    .x { width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); display: grid; place-items: center; cursor: pointer; }
    .x:hover { color: var(--text); }
    .ttl { font-weight: 700; color: var(--text-2); }
    .stepper { list-style: none; padding: 0; margin: 4px 0 6px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .stepper li { font-size: 12px; font-weight: 700; color: var(--muted); }
    .stepper li::before { content: ""; display: block; height: 5px; border-radius: 3px; background: var(--surface-3); margin-bottom: 6px; transition: background .3s ease; }
    .stepper li.d { color: var(--text-2); } .stepper li.d::before { background: var(--accent); }
    .stepper li.c { color: var(--text); } .stepper li.c::before { background: linear-gradient(90deg, #6366f1, #a78bfa); }
    .q { font-size: clamp(22px, 3vw, 26px); font-weight: 800; letter-spacing: -.025em; margin: 6px 2px 0; line-height: 1.2; }
    .sub { color: var(--text-2); margin: 0 2px; font-size: 15px; }
    .hint { font-size: var(--fs-small); margin: 0 2px; }
    .money { display: flex; align-items: center; gap: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 14px 18px; font-size: 30px; font-weight: 800; }
    .money:focus-within { border-color: var(--accent); }
    .money input { font: inherit; color: var(--text); background: none; border: 0; outline: none; width: 100%; min-width: 0; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .big { width: 100%; padding: 15px 18px; font-size: 15.5px; }
    .picked { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 12px 16px; }
    .picked .ck { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: var(--pos-soft); color: var(--pos); }
    .picked small { display: block; color: var(--muted); font-size: 12.5px; font-weight: 600; } .picked b { font-size: 18px; }
    .picked .grow { flex: 1; }
    .amt { font-size: 16px; white-space: nowrap; }
    .leg { align-items: flex-start; }
    .leg .pick { margin-top: 8px; padding: 8px 10px; font-size: 13.5px; max-width: 100%; }
    .leg .acts { display: flex; flex-direction: column; align-items: center; gap: 6px; flex: none; }
    .leg.done .v-ic { background: var(--pos-soft); color: var(--pos); border-color: transparent; }
    .leg.done .t, .leg.skip .t { color: var(--text-2); }
    .leg.skip { opacity: .6; }
    .okay { text-align: center; margin: 10px 0 4px; }
    .okay > span { width: 68px; height: 68px; border-radius: 50%; margin: 0 auto 10px; display: grid; place-items: center; background: var(--pos-soft); color: var(--pos); animation: pop .5s cubic-bezier(.2,.9,.3,1.3); }
    @keyframes pop { from { transform: scale(.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .okay > span { animation: none; } }
    .chrow { display: grid; grid-template-columns: 110px minmax(0, 1fr) 96px; gap: 12px; align-items: center; padding: 7px 0; font-size: 14px; }
    .chrow .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-2); font-weight: 600; }
    .chrow .v { text-align: right; font-weight: 700; white-space: nowrap; } .chrow small { font-size: 12px; margin-left: 2px; }
    .gap { display: flex; flex-direction: row; align-items: center; gap: 10px; }
    .gap .grow { flex: 1; } .gap small { display: block; color: var(--muted); font-size: 13px; font-weight: 600; } .gap b { font-size: 18px; }
  `],
})
export class InvestFlowComponent {
  private api = inject(ApiService);
  private router = inject(Router);
  private store = inject(StoreService);
  private dialog = inject(TxnDialogService);
  private ovs = inject(OverviewService);
  route = inject(ActivatedRoute);

  money = money; Math = Math; meta = groupMeta; steps = STEPS; toneClass = toneClass; path = linkPath; query = linkQuery;
  hex = (k: string) => GROUP_HEX[k as GroupKey] ?? '#94a3b8';

  step = signal<Step>('amount');
  stepIndex = computed(() => STEPS.findIndex(s => s.key === this.step()));
  amount = +(this.route.snapshot.queryParamMap.get('amount') ?? 0) || 25000;
  usual = computed(() => Math.round((this.ovs.data()?.totals?.monthly_in ?? 0) / 1000) * 1000);
  quick = computed(() => [...new Set([this.usual(), 10000, 25000, 50000, 100000].filter(v => v > 0))].sort((a, b) => a - b));
  fromName = computed(() => {
    const id = +(this.route.snapshot.queryParamMap.get('from') ?? 0);
    return id ? this.store.positions().find(p => p.id === id)?.name ?? null : null;
  });
  loading = signal(false);
  finishing = signal(false);
  error = signal<string | null>(null);
  plan = signal<GroupRebalance | null>(null);
  buys = computed(() => (this.plan()?.rows ?? []).filter(r => r.action === 'buy' && r.amount > 0 && KIND[r.key]));
  epfOver = computed(() => (this.plan()?.rows ?? []).some(r => r.key === 'epf' && r.current_pct > r.target_pct + 1));
  legs = signal<Leg[]>([]);
  anyDone = computed(() => this.legs().some(l => l.done));
  allSettled = computed(() => this.legs().every(l => l.done || l.skipped));
  recorded = signal(0);
  recordedAmount = computed(() => this.legs().filter(l => l.done).reduce((s, l) => s + l.row.amount, 0));
  private before: GroupRow[] = [];
  after = signal<GroupRow[]>([]);

  options(key: string): Position[] {
    return this.store.positions()
      .filter(p => p.group === key && p.is_open && p.status !== 'wallet' && p.asset_class !== 'cash' && (key !== 'p2p'))
      .filter(p => key !== 'others' || p.asset_class === 'fixed_deposit')
      .sort((a, b) => b.value - a.value);
  }
  how = (key: string) => KIND[key]?.label ?? '';

  async toPlan() {
    this.loading.set(true);
    this.error.set(null);
    try {
      const mine = !!this.ovs.data()?.targets?.has_mine;
      this.plan.set(await firstValueFrom(this.api.groupRebalance(this.amount, false, mine ? 'mine' : 'suggested')));
      this.step.set('plan');
    } catch (e) { this.error.set(errorMessage(e)); } finally { this.loading.set(false); }
  }

  toRecord() {
    this.before = (this.ovs.data()?.groups ?? []).map(g => ({ ...g }));
    this.legs.set(this.buys().map(row => ({ row, holding: this.options(row.key)[0]?.id ?? null, done: false, skipped: false })));
    this.step.set('record');
  }

  setHolding(l: Leg, id: number | null) { this.patch(l, { holding: id }); }
  skip(l: Leg) { this.patch(l, { skipped: true }); }
  unskip(l: Leg) { this.patch(l, { skipped: false }); }
  private patch(l: Leg, p: Partial<Leg>) { this.legs.update(ls => ls.map(x => x.row.key === l.row.key ? { ...x, ...p } : x)); }

  record(l: Leg) {
    const k = KIND[l.row.key];
    const amount = Math.round(l.row.amount);
    const done = () => { this.patch(l, { done: true }); this.recorded.update(n => n + 1); };
    if (k.kind === 'wallet') { this.dialog.openWallet({ amount, onSaved: done }); return; }
    this.dialog.add(k.kind, {
      amount, instrumentId: l.holding ?? undefined, market: k.market, notes: 'Put new money to work',
      onSaved: ids => { if (ids.length) done(); },
    });
  }

  async finish() {
    this.finishing.set(true);
    try {
      await this.store.changed();
      await this.ovs.reload();
      this.after.set(this.ovs.data()?.groups ?? []);
      this.step.set('done');
    } finally { this.finishing.set(false); }
  }

  changes = computed(() => {
    const after = this.after();
    return this.legs().filter(l => l.done).map(l => {
      const b = this.before.find(g => g.key === l.row.key), a = after.find(g => g.key === l.row.key);
      const target = a?.target ?? l.row.target_pct;
      const pct = a?.pct ?? l.row.after_pct;
      return { key: l.row.key, label: l.row.label, before: b?.pct ?? l.row.current_pct, after: pct,
        reach: target ? Math.min(100, (pct / target) * 100) : 100 };
    });
  });

  /** Money still needed to bring every group up to its target, before and after. */
  gap = computed(() => {
    const total = (gs: GroupRow[]) => gs.reduce((s, g) => s + g.value, 0);
    const short = (gs: GroupRow[]) => {
      const t = total(gs);
      return gs.reduce((s, g) => s + (g.target !== null ? Math.max(g.target - g.pct, 0) / 100 * t : 0), 0);
    };
    const a = this.after();
    if (!a.length || !this.before.some(g => g.target !== null)) return null;
    return { before: short(this.before), after: short(a) };
  });

  next = computed<TodoItem | null>(() => (this.ovs.answers()?.todo ?? []).find(t => t.flow !== 'invest') ?? null);

  exit() {
    if (history.length > 1) history.back(); else void this.router.navigateByUrl('/');
  }
}
