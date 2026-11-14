import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ActionService } from '../../core/action.service';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fileToBase64, inr } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Action, LendenFile, LendenPreview, Position, Status } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { PortfolioTabsComponent } from '../../shared/portfolio-tabs.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META } from '../../shared/priority/priority';
import { ModalComponent, SortState } from '../../shared/ui';

export type P2pTab = 'active' | 'overdue' | 'closed' | 'defaulted' | 'all';
type Tab = P2pTab;
/** The loan-table tabs, in order; `?tab=` takes one of these (anything else reads as active). */
export const P2P_TABS: readonly P2pTab[] = ['active', 'overdue', 'closed', 'defaulted', 'all'];
type ImportTab = 'repayments' | 'new' | 'status' | 'details' | 'check';

/** The brief's Money-at-risk thresholds (`brief.P2P_OVERDUE_DAYS`, `brief.MONEY_AT_RISK_ACT_PCT`). */
export const P2P_LATE_DAYS = 30;
export const MONEY_AT_RISK_ACT_PCT = 1;

export interface P2pRisk {
  status: Status;
  /** Σ `at_risk`: the outstanding principal of defaulted loans. */
  atRisk: number;
  /** Open loans more than 30 days past due that have not defaulted, and their outstanding principal. */
  late: number;
  lateAmount: number;
  /** (atRisk + lateAmount) as % of the portfolio's value; null when nothing is at risk. */
  pct: number | null;
  text: string;
}

/**
 * The P2P hero's verdict, mirroring the brief's Money-at-risk vital for this class (H19):
 * defaulted principal plus the outstanding principal of open loans over 30 days late is `act` at ≥ 1% of the
 * portfolio's value (or when there is no value to compare with), `watch` when above 0, else `good`.
 */
export function p2pRisk(loans: Position[], portfolioValue: number | null | undefined): P2pRisk {
  let atRisk = 0, late = 0, lateAmount = 0;
  for (const p of loans) {
    const r = p.at_risk ?? 0;
    if (r > 0) atRisk += r;
    else if (p.is_open && (p.overdue_days ?? 0) > P2P_LATE_DAYS) { late++; lateAmount += p.outstanding ?? 0; }
  }
  const total = atRisk + lateAmount;
  if (total <= 0) {
    return { status: 'good', atRisk: 0, late: 0, lateAmount: 0, pct: null, text: `Nothing at risk · no loan over ${P2P_LATE_DAYS} days late` };
  }
  const value = portfolioValue ?? 0;
  const pct = value > 0 ? total / value * 100 : 100;
  return {
    status: pct >= MONEY_AT_RISK_ACT_PCT ? 'act' : 'watch', atRisk, late, lateAmount, pct,
    text: `At risk ${inr(atRisk)} · ${late} overdue ${P2P_LATE_DAYS}+ days`,
  };
}

/** Outstanding-weighted average stated `rate` of open (active) loans; null when no open loan has a rate. */
export function weightedRate(loans: Position[]): number | null {
  let w = 0, sum = 0;
  for (const p of loans) {
    const o = p.outstanding ?? 0;
    if (p.status === 'active' && p.rate && o > 0) { w += o; sum += p.rate * o; }
  }
  return w > 0 ? sum / w : null;
}

interface Group { key: string; label: string; sub: string; latest: string; count: number; lent: number; back: number; interest: number;
  outstanding: number; defaulted: number; closed: number; }

/**
 * P2P lending class page (§5.7, H19). T0: Outstanding with the at-risk verdict, then Interest after fees,
 * Realised XIRR vs the stated rate and Principal back. T1: the P2P / principal-back action strip.
 * T2: where the lent money stands (stack bar, lending-type cards). T3: the loans table (tabs on `?tab=`),
 * cohorts and the LenDen import (`?import=lenden`, writers only).
 * Reads the store's portfolio and the cached `/actions` only; no extra calls.
 */
@Component({
  selector: 'app-p2p',
  standalone: true,
  imports: [FormsModule, TitleCasePipe, IconComponent, PortfolioTabsComponent, NeedsAttentionComponent, ModalComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './p2p.component.html',
  styles: [`
    .hero-skel { height: 150px; border-radius: 14px; }

    /* T0: hero + three tiles; phones keep the hero and two tiles, Principal back sits behind "More" (§1.5, W3-F1) */
    .h-kpis { grid-template-columns: minmax(0, 1.5fr) repeat(3, minmax(0, 1fr)); }
    .h-kpis .verdict-line { margin-top: 10px; font-size: 14px; align-items: flex-start; }
    .h-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .h-kpis .meta.gap { display: block; margin-top: 2px; }
    .more-stats { display: none; align-self: flex-start; margin-top: 8px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #fff; font-size: 12px; }
    @media (max-width: 900px) {
      .h-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .h-kpis .kpi.extra { grid-column: span 2; border-left: 0; border-top: 1px solid rgba(255, 255, 255, .09); }
    }
    @media (max-width: 760px) {
      .more-stats { display: inline-flex; }
      .h-kpis .kpi.extra:not(.show) { display: none; }
    }
    .explains { display: block; }
    .loan-tools .search { max-width: 220px; height: 32px; }
    @media (max-width: 760px) { .loan-tools, .loan-tools .search { flex: 1 1 100%; max-width: none; } }

    .drop { position: relative; display: flex; align-items: center; gap: 12px; min-height: 72px; padding: 12px 16px; border-radius: 10px;
      border: 1.5px dashed var(--border-strong); background: var(--surface-2); color: var(--text-2); cursor: pointer; font-size: 13.5px; }
    .drop:hover { border-color: var(--primary); color: var(--text); }
    .drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .kinds { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 4px 0 14px; }
    .kinds div { padding: 10px 12px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); font-size: 12.5px; color: var(--text-2); }
    .kinds b { display: block; color: var(--text); font-size: 13px; margin-bottom: 2px; }
    .files { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin-bottom: 12px; }
    .file { padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); }
    .file header { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin-bottom: 6px; }
    .file header b { font-size: 13px; }
    .file small { color: var(--muted); font-size: 11.5px; }
    .file table { width: 100%; font-size: 12px; border-collapse: collapse; margin-top: 6px; }
    .file th { font-weight: 500; color: var(--muted); text-align: right; padding: 2px 0; }
    .file th:first-child, .file td:first-child { text-align: left; }
    .file td { text-align: right; padding: 2px 0; font-variant-numeric: tabular-nums; }
    .file td.todo { color: var(--primary); font-weight: 600; }
    .tabs .n { display: inline-block; min-width: 18px; margin-left: 4px; padding: 0 5px; border-radius: 9px; background: var(--surface-2); font-size: 11px; color: var(--text-2); }
    .tabs .n.hot { background: var(--accent-soft); color: var(--primary); }
    .pane { padding-top: 10px; }
    .checks { display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow: auto; }
    .types { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; margin-top: 16px; }
    .type { padding: 12px 14px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); }
    .type header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
    .type dl { display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; margin: 0; font-size: 12.5px; }
    .type dt { color: var(--muted); }
    .type dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  `],
})
export class P2pComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private actions = inject(ActionService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  readonly statusMeta = STATUS_META;
  readonly tabs = P2P_TABS;
  /** T1 strip (H19). `p2p:yield` is info severity, which ranks `consider`, so that tier is passed too. */
  readonly attentionPrefixes = ['/p2p', '/cash-flows'];
  readonly attentionIds = ['p2p:', 'cash:p2p-principal:'];
  readonly attentionTiers: Action['tier'][] = ['now', 'month', 'consider'];

  private query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  /** The loans-table tab follows `?tab=` (H19), so `/p2p?tab=defaulted|overdue` from an action lands on it. */
  tab = computed<Tab>(() => {
    const t = this.query().get('tab') ?? '';
    return (P2P_TABS as readonly string[]).includes(t) ? t as Tab : 'active';
  });
  moreStats = signal(false);

  port = computed(() => this.store.portfolio());
  loading = computed(() => !this.port() && !this.store.error());
  failed = computed(() => !this.port() && !!this.store.error());

  q = signal('');
  type = signal<string>('all');
  groupBy = signal<'month' | 'order'>('month');
  sort = new SortState<Position>('first_date');

  importing = signal(false);
  importBusy = signal(false);
  importError = signal<string | null>(null);
  preview = signal<LendenPreview | null>(null);
  importTab = signal<ImportTab>('repayments');
  fillDetails = signal(true);

  loans = computed(() => this.store.positions().filter(p => p.asset_class === 'p2p'));
  seg = computed(() => this.store.portfolio()?.segments.find(s => s.segment === 'P2P'));
  /** Lending types recorded on loans (Manual / Lumpsum), shown only when there is more than one. */
  types = computed(() => [...new Set(this.loans().map(p => p.category).filter((c): c is string => !!c))].sort());
  stats = computed(() => {
    const l = this.loans();
    const active = l.filter(p => p.status === 'active');
    const rates = l.filter(p => p.rate).map(p => p.rate!);
    return {
      outstanding: active.reduce((a, p) => a + (p.outstanding ?? 0), 0),
      activeCount: active.length,
      lent: l.reduce((a, p) => a + p.invested, 0),
      interest: l.reduce((a, p) => a + (p.interest ?? 0), 0),
      fees: l.reduce((a, p) => a + (p.fees ?? 0), 0),
      atRisk: l.reduce((a, p) => a + (p.at_risk ?? 0), 0),
      defaulted: l.filter(p => p.status === 'defaulted').length,
      overdue: l.filter(p => (p.overdue_days ?? 0) > 7).length,
      avgRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    };
  });
  /** Lent money split into what came back, what is still out, and what is at risk. */
  split = computed(() => {
    const s = this.stats();
    const repaid = Math.max(s.lent - s.outstanding - s.atRisk, 0);
    const total = repaid + s.outstanding + s.atRisk || 1;
    return [
      { key: 'repaid', label: 'Principal repaid', value: repaid, pct: repaid / total * 100, color: 'var(--pos)' },
      { key: 'out', label: 'Still outstanding', value: s.outstanding, pct: s.outstanding / total * 100, color: 'var(--primary)' },
      { key: 'risk', label: 'At risk', value: s.atRisk, pct: s.atRisk / total * 100, color: 'var(--neg)' },
    ];
  });
  /** T0 verdict: defaulted plus over-30-days-late money, as the brief's Money-at-risk vital (H19). */
  risk = computed(() => p2pRisk(this.loans(), this.port()?.totals.value));
  /** What realised XIRR is compared with; the plain average across all loans when no open loan has a rate. */
  statedRate = computed(() => {
    const w = weightedRate(this.loans());
    if (w !== null) return { rate: w, basis: 'average stated rate of open loans, weighted by what is still lent' };
    const a = this.stats().avgRate;
    return a !== null ? { rate: a, basis: 'average stated rate across all loans' } : null;
  });
  /** Realised XIRR more than a point under the stated rate: defaults and platform fees explain the gap. */
  rateGap = computed(() => {
    const x = this.seg()?.xirr, r = this.statedRate()?.rate;
    return x !== null && x !== undefined && r !== undefined && r - x > 1;
  });
  principalBack = computed(() => this.loans().reduce((a, p) => a + (p.principal_repaid ?? 0), 0));
  /** `impact.amount` of the visible `cash:p2p-principal:*` action: principal back in 30 days with no plan yet. */
  idlePrincipal = computed(() => {
    const a = this.actions.actions().find(x => x.id.startsWith('cash:p2p-principal:'));
    return a?.impact?.amount ? a.impact.amount : null;
  });

  byType = computed(() => this.types().length > 1 ? this.group(p => p.category ?? '', k => `${k} lending`) : []);
  counts = computed(() => ({
    active: this.loans().filter(p => p.status === 'active').length,
    overdue: this.stats().overdue,
    closed: this.loans().filter(p => p.status === 'closed').length,
    defaulted: this.stats().defaulted,
    all: this.loans().length,
  }));
  rows = computed(() => {
    const t = this.tab(), q = this.q().toLowerCase().trim(), ty = this.type();
    const rows = this.loans().filter(p =>
      (t === 'all' || (t === 'overdue' ? (p.overdue_days ?? 0) > 7 : p.status === t)) &&
      (ty === 'all' || p.category === ty) &&
      (!q || `${p.name} ${p.ref} ${p.ref2} ${p.sub_category ?? ''}`.toLowerCase().includes(q)));
    return this.sort.apply(rows);
  });
  cohorts = computed(() => this.groupBy() === 'month'
    ? this.group(p => (p.first_date ?? '').slice(0, 7), k => k)
    : this.group(p => p.sub_category ?? '', k => k ? `Order ${k}` : 'No order recorded'));

  private group(key: (p: Position) => string, label: (k: string) => string): Group[] {
    const m = new Map<string, Group>();
    for (const p of this.loans()) {
      const k = key(p);
      const g = m.get(k) ?? { key: k, label: label(k), sub: '', latest: '', count: 0, lent: 0, back: 0, interest: 0, outstanding: 0, defaulted: 0, closed: 0 };
      g.count++; g.lent += p.invested; g.back += p.principal_repaid ?? 0; g.interest += p.interest ?? 0;
      if (p.status === 'active') g.outstanding += p.outstanding ?? 0;
      if (p.status === 'defaulted') g.defaulted++;
      if (p.status === 'closed') g.closed++;
      if (!g.sub) g.sub = [p.category, p.first_date].filter(Boolean).join(' · ');
      if ((p.first_date ?? '') > g.latest) g.latest = p.first_date ?? '';
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.latest.localeCompare(a.latest) || b.key.localeCompare(a.key));
  }

  // Tools → Import (behind writeGuard) links here with ?import=lenden; a guest opening that URL gets the page only
  private importParam = (() => {
    const k = this.route.snapshot.queryParamMap.get('import');
    if (k && this.auth.canWrite()) queueMicrotask(() => this.startImport());
    return k;
  })();

  open(p: Position) { this.router.navigate(['/holding', p.id]); }

  /** A tab click writes `?tab=` in place (replaceUrl), so Back leaves the page instead of stepping through tabs. */
  setTab(t: Tab) {
    if (t === this.tab()) return;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab: t }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Closes the import dialog and drops `?import=` from the URL, so a reload does not reopen it. */
  closeImport() {
    this.importing.set(false);
    if (this.route.snapshot.queryParamMap.has('import')) {
      void this.router.navigate([], { relativeTo: this.route, queryParams: { import: null }, queryParamsHandling: 'merge', replaceUrl: true });
    }
  }

  startImport() {
    this.importing.set(true);
    this.preview.set(null);
    this.importError.set(null);
  }

  async onFiles(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const picked = [...(input.files ?? [])];
    input.value = '';
    if (!picked.length) return;
    this.importBusy.set(true);
    this.importError.set(null);
    try {
      const files = await Promise.all(picked.map(async f => ({ name: f.name, file_data: await fileToBase64(f) })));
      const res = await firstValueFrom(this.api.lendenPreview(files));
      this.preview.set(res);
      this.fillDetails.set(true);
      this.importTab.set(res.repayments.length ? 'repayments' : res.new_loans.length ? 'new' : res.status_changes.length ? 'status'
        : res.details.length ? 'details' : 'check');
    } catch (e) {
      this.importError.set(errorMessage(e));
    } finally {
      this.importBusy.set(false);
    }
  }

  fileLabel(f: LendenFile) {
    return f.kind === 'order_report' ? 'Order report' : `Investment report${f.lending_types.length === 1 ? ' · ' + f.lending_types[0] : ''}`;
  }

  // Selections live on the preview rows (ngModel), so these are read on every change-detection pass
  picked() {
    const p = this.preview();
    if (!p) return { loans: 0, repayments: 0, status: 0, details: 0, cash: 0 };
    const rps = p.repayments.filter(r => r.selected), nl = p.new_loans.filter(r => r.selected);
    return {
      loans: nl.length, repayments: rps.length, status: p.status_changes.filter(s => s.apply).length,
      details: this.fillDetails() ? p.details.length : 0,
      cash: rps.reduce((a, r) => a + r.amount, 0) + nl.reduce((a, r) => a + (r.repayment?.amount ?? 0), 0),
    };
  }
  anyPicked() { const c = this.picked(); return c.loans + c.repayments + c.status + c.details > 0; }
  commitLabel() {
    const c = this.picked();
    const parts = [c.loans && `add ${c.loans} loan${c.loans === 1 ? '' : 's'}`, c.repayments && `post ${c.repayments} repayment${c.repayments === 1 ? '' : 's'}`,
      c.status && `update ${c.status} status${c.status === 1 ? '' : 'es'}`, c.details && `fill in ${c.details}`].filter(Boolean) as string[];
    const s = parts.join(', ');
    return s ? s[0].toUpperCase() + s.slice(1) : 'Nothing selected';
  }
  toggleAll(rows: { selected: boolean }[], v: boolean) { rows.forEach(r => r.selected = v); }
  fieldList(f: Record<string, unknown>) {
    const names: Record<string, string> = { category: 'lending type', sub_category: 'order', rate: 'rate', tenure_months: 'tenure', maturity_date: 'maturity' };
    return Object.keys(f).map(k => names[k] ?? k).join(', ');
  }

  async commit() {
    const p = this.preview();
    if (!p) return;
    this.importBusy.set(true);
    this.importError.set(null);
    try {
      const res = await firstValueFrom(this.api.lendenCommit({
        new_loans: p.new_loans.filter(r => r.selected), repayments: p.repayments.filter(r => r.selected),
        status_changes: p.status_changes.filter(s => s.apply), details: this.fillDetails() ? p.details : [],
      }));
      const done = [res.loans_added && `${res.loans_added} loan(s) added`, res.repayments && `${res.repayments} repayment(s) posted`,
        res.status_updated && `${res.status_updated} status(es) updated`, res.details_filled && `details filled for ${res.details_filled}`].filter(Boolean);
      this.toast.ok(done.length ? done.join(' · ') : 'Nothing to import');
      if (res.errors.length) this.toast.error(`${res.errors.length} row(s) skipped: ${res.errors[0].loan_id} ${res.errors[0].error}`);
      this.closeImport();
      await this.store.changed();
    } catch (e) {
      this.importError.set(errorMessage(e));
    } finally {
      this.importBusy.set(false);
    }
  }
}
