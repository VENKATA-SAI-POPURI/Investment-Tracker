import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ActionService } from '../../core/action.service';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, downloadCsv } from '../../core/format';
import { errorMessage } from '../../core/http';
import { AssetClass, CLASS_LABEL, Transaction, TransactionsPage, TXN_LABEL, TxnType } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { DropZoneComponent, ImportRefusal, ImportRowResult, completeImportDue, refusedRows, showRefusal } from '../../shared/drop-zone.component';
import { IconComponent } from '../../shared/icon.component';
import { SectionTabsComponent } from '../../shared/section-tabs.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';

const TEMPLATE = 'date,type,asset_class,name,symbol,quantity,amount,amount_usd,market,sector,market_cap,category,notes\n'
  + '2026-01-15,BUY,equity,HDFC Bank,HDFCBANK.NS,10,16500,,India,Financials,Large Cap,,\n'
  + '2026-01-20,BUY,mutual_fund,Parag Parikh Flexi Cap,AMFI:122639,120.5,10000,,,,,Equity,SIP\n';

/** Rows per page (R21). */
export const PAGE_SIZE = 50;
/** The search box waits this long after the last keystroke before it asks the server (R21). */
export const SEARCH_DEBOUNCE_MS = 300;

export type TxnSort = 'date' | '-date' | 'amount' | '-amount' | 'name' | '-name';
export type TxnSortKey = 'date' | 'amount' | 'name';
const SORTS: TxnSort[] = ['date', '-date', 'amount', '-amount', 'name', '-name'];
const DEFAULT_SORT: TxnSort = '-date';
/** A header's first click: newest and largest first, names A to Z. */
const FIRST_DIR: Record<TxnSortKey, TxnSort> = { date: '-date', amount: '-amount', name: 'name' };

/** The next sort when a header is pressed: the same key flips direction, a new key starts at its first direction. */
export function nextSort(current: TxnSort, key: TxnSortKey): TxnSort {
  const cur = current.replace('-', '');
  if (cur !== key) return FIRST_DIR[key];
  return (current.startsWith('-') ? key : `-${key}`) as TxnSort;
}

/** `aria-sort` for a sortable header under the current server sort (P2.9). */
export function ariaSortOf(current: TxnSort, key: TxnSortKey): 'ascending' | 'descending' | 'none' {
  if (current.replace('-', '') !== key) return 'none';
  return current.startsWith('-') ? 'descending' : 'ascending';
}

/** "2026-11" → "November 2026". */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

/** Consecutive rows of one month, in server order (used when the page is sorted by date). */
export function groupByMonth(rows: Transaction[]): { month: string; rows: Transaction[] }[] {
  const out: { month: string; rows: Transaction[] }[] = [];
  for (const t of rows) {
    const m = (t.date ?? '').slice(0, 7);
    const last = out[out.length - 1];
    if (last && last.month === m) last.rows.push(t); else out.push({ month: m, rows: [t] });
  }
  return out;
}

const isClass = (v: string | null): v is AssetClass => !!v && v in CLASS_LABEL;
const isType = (v: string | null): v is TxnType => !!v && v in TXN_LABEL;
const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Activity › Transactions (§5.11, P2.11, R21).
 * - T0: hero "Net put to work" = the server's `sums.net` for every filtered row; tiles Transactions, Money out, Money in.
 * - T2: search (debounced), class, type and from–to filters.
 * - T3: one page (50 rows) from `GET /transactions?page=`, grouped by month under the server's month subtotals
 *   when sorted by date; date, holding and amount headers sort on the server; a pager; the CSV import modal.
 * Every input lives in the query string (replaceUrl), so a reload or a shared link reopens the same view.
 * Any write (add, edit, delete, import) bumps the store's version, which refetches the current page.
 */
@Component({
  selector: 'app-transactions',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, SectionTabsComponent, ModalComponent, DropZoneComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './transactions.component.html',
  styles: [`
    .tx-skel { height: 132px; border-radius: 14px; }
    .tx-kpis { grid-template-columns: minmax(0, 1.5fr) repeat(3, minmax(0, 1fr)); }
    @media (max-width: 900px) {
      .tx-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .tx-kpis .kpi:last-child { grid-column: span 2; border-left: 0; }
    }
    .filters .f-q { flex: 1 1 220px; max-width: 280px; }
    .filters .f-sel { width: auto; }
    .filters .f-range { display: inline-flex; align-items: center; gap: 6px; }
    .filters .f-date { width: auto; }
    .sort-btn { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; font: inherit; color: inherit;
      text-transform: inherit; letter-spacing: inherit; cursor: pointer; }
    .sort-btn .arr { font-size: 11px; color: var(--muted); min-width: 10px; }
    th[aria-sort="ascending"] .sort-btn, th[aria-sort="descending"] .sort-btn { color: var(--text); }
    th[aria-sort="ascending"] .arr, th[aria-sort="descending"] .arr { color: var(--accent); }
    th.num .sort-btn { flex-direction: row-reverse; }
    tr.month-row th { background: var(--surface-2); text-align: left; font-weight: 600; font-size: var(--t-meta); color: var(--text);
      text-transform: none; letter-spacing: 0; padding: 8px 14px; white-space: normal; position: static; }
    .m-row { display: flex; align-items: baseline; gap: 6px 14px; flex-wrap: wrap; }
    .m-row .m-name { font-weight: 650; }
    .m-row .m-sums { font-weight: 500; color: var(--text-2); font-variant-numeric: tabular-nums; font-size: var(--t-label); }
    .pager { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 12px 16px; border-top: 1px solid var(--border); }
    .pager .pg-btns { display: inline-flex; align-items: center; gap: 8px; }
    .pager .pg-of { font-weight: 600; font-size: var(--t-meta); }
    .tx-err { margin: 0 16px 12px; }
    .sm-type { display: none; }
    .d-short { display: none; }
    .acts { display: inline-flex; gap: 2px; }
    .refused { margin-top: 12px; }
    .refused .table-wrap { max-height: 280px; margin-top: 8px; }
    @media (max-width: 760px) {
      .filters .f-q { max-width: none; flex-basis: 100%; }
      .filters .f-sel { flex: 1 1 40%; }
      .filters .f-range { display: flex; flex: 1 1 100%; min-width: 0; }
      .filters .f-date { flex: 1 1 0; width: 0; min-width: 0; }
      .sm-type { display: inline; }
      .d-full { display: none; }
      .d-short { display: inline; }
      .d-short .sub { display: block; font-size: var(--t-label); color: var(--muted); }
      .tx-table th, .tx-table td { padding: 10px 8px; }
      .tx-table th:first-child, .tx-table td:first-child { padding-left: 14px; }
      .tx-table th:last-child, .tx-table td:last-child { padding-right: 10px; }
      .tx-table td.tx-name { white-space: normal; overflow-wrap: anywhere; }
      .acts { flex-direction: column; }
      tr.month-row th { padding: 8px 12px; }
      .pager { justify-content: center; }
      .pager .pg-range { width: 100%; text-align: center; }
    }
  `],
})
export class TransactionsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private actions = inject(ActionService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  txnLabel = TXN_LABEL;
  classLabel = CLASS_LABEL;
  classes = Object.entries(CLASS_LABEL);
  types = Object.entries(TXN_LABEL);
  monthLabel = monthLabel;
  ariaSort = (k: TxnSortKey) => ariaSortOf(this.sort(), k);

  // ---- the view, seeded from the query string
  private readonly qp = this.route.snapshot.queryParamMap;
  /** What is typed in the search box. */
  qText = signal(this.qp.get('q') ?? '');
  /** The search the server was asked for (qText after the debounce, trimmed). */
  q = signal((this.qp.get('q') ?? '').trim());
  cls = signal<AssetClass | ''>(isClass(this.qp.get('class')) ? this.qp.get('class') as AssetClass : '');
  type = signal<TxnType | ''>(isType(this.qp.get('type')) ? this.qp.get('type') as TxnType : '');
  from = signal(isDate(this.qp.get('from')) ? this.qp.get('from')! : '');
  to = signal(isDate(this.qp.get('to')) ? this.qp.get('to')! : '');
  sort = signal<TxnSort>((SORTS as string[]).includes(this.qp.get('sort') ?? '') ? this.qp.get('sort') as TxnSort : DEFAULT_SORT);
  page = signal(Math.max(1, Math.floor(Number(this.qp.get('page'))) || 1));

  // ---- the data
  data = signal<TransactionsPage | null>(null);
  loading = signal(true);
  /** A load that failed (not a 400): the page keeps the last data it had and offers a retry. */
  loadError = signal<string | null>(null);
  /** A 400 from a bad parameter: the view went back to page 1 and says why (R21). Cleared by the next change. */
  paramError = signal<string | null>(null);
  private seq = 0;

  filtersOn = computed(() => !!(this.q() || this.cls() || this.type() || this.from() || this.to()));
  byDate = computed(() => this.sort().endsWith('date'));
  rows = computed(() => this.data()?.rows ?? []);
  /** Month groups under a date sort; one unlabelled group under an amount or name sort, so the order holds. */
  groups = computed(() => this.byDate() ? groupByMonth(this.rows()) : [{ month: '', rows: this.rows() }]);
  months = computed(() => new Map((this.data()?.months ?? []).map(m => [m.month, m])));
  range = computed(() => {
    const d = this.data();
    if (!d || !d.rows.length) return null;
    const start = (d.page - 1) * d.size + 1;
    return { start, end: start + d.rows.length - 1 };
  });

  // ---- CSV import
  importing = signal(this.qp.has('import'));
  csv = '';
  csvName = signal('');
  preview = signal<{ format: string; rows: any[]; errors: { line: number; error: string }[] } | null>(null);
  busy = signal(false);
  importError = signal<string | null>(null);
  /** The rows an all-or-nothing commit refused (K5/K6), shown as a table; the L2 line is the toast. */
  refused = signal<ImportRefusal | null>(null);
  exporting = signal(false);

  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => { if (this.debounce) clearTimeout(this.debounce); });
    // one fetch per view or data change: any write bumps the store version, which refetches this page
    effect(() => {
      this.store.version();
      const params = this.params();
      untracked(() => queueMicrotask(() => this.load(params)));
    });
    // the view lives in the query string; replaceUrl keeps Back for leaving the page
    effect(() => {
      const qp = {
        q: this.q() || null, class: this.cls() || null, type: this.type() || null, from: this.from() || null, to: this.to() || null,
        sort: this.sort() === DEFAULT_SORT ? null : this.sort(), page: this.page() > 1 ? this.page() : null,
        import: this.importing() ? (this.qp.get('import') || '1') : null,
      };
      untracked(() => void this.router.navigate([], { relativeTo: this.route, queryParams: qp, queryParamsHandling: 'merge', replaceUrl: true }));
    });
  }

  private params = computed(() => ({
    page: this.page(), size: PAGE_SIZE, q: this.q() || null, sort: this.sort(),
    asset_class: this.cls() || null, type: this.type() || null, from: this.from() || null, to: this.to() || null,
  }));

  async load(p = this.params()) {
    const seq = ++this.seq;
    this.loading.set(true);
    try {
      const d = await firstValueFrom(this.api.transactionsPage(p));
      if (seq !== this.seq) return;
      // a page past the end (the last row of the last page was deleted, or an old link): go to the last page
      if (!d.rows.length && d.total > 0 && d.page > d.pages) { this.page.set(d.pages); return; }
      this.data.set(d);
      this.loadError.set(null);
    } catch (e) {
      if (seq !== this.seq) return;
      if (e instanceof HttpErrorResponse && e.status === 400) {
        this.paramError.set(errorMessage(e));
        this.loadError.set(null);
        if (this.page() !== 1) { this.page.set(1); return; }
        if (this.sort() !== DEFAULT_SORT) { this.sort.set(DEFAULT_SORT); return; }
      } else {
        this.loadError.set(errorMessage(e));
      }
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }

  // ---- inputs: every change but paging goes back to page 1
  private changed() { this.paramError.set(null); this.page.set(1); }
  onSearch(v: string) {
    this.qText.set(v);
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const q = v.trim().slice(0, 100);
      if (q !== this.q()) { this.q.set(q); this.changed(); }
    }, SEARCH_DEBOUNCE_MS);
  }
  setClass(v: AssetClass | '') { this.cls.set(v); this.changed(); }
  setType(v: TxnType | '') { this.type.set(v); this.changed(); }
  setFrom(v: string) { this.from.set(v ?? ''); this.changed(); }
  setTo(v: string) { this.to.set(v ?? ''); this.changed(); }
  sortBy(k: TxnSortKey) { this.sort.set(nextSort(this.sort(), k)); this.changed(); }
  clear() {
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
    this.qText.set(''); this.q.set(''); this.cls.set(''); this.type.set(''); this.from.set(''); this.to.set('');
    this.changed();
  }
  go(page: number) {
    const pages = this.data()?.pages ?? 1;
    const to = Math.min(Math.max(1, page), pages);
    if (to === this.page()) return;
    this.paramError.set(null);
    this.page.set(to);
    const top = document.getElementById('tx-ledger');
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' });
  }

  async remove(t: Transaction) {
    if (!(await this.confirm.ask('Delete transaction?', `${TXN_LABEL[t.type]} · ${t.instrument_name} · ${t.date}. Linked capital-flow entries are removed too.`, 'Delete'))) return;
    try {
      await firstValueFrom(this.api.deleteTransaction(t.id));
      this.toast.ok('Transaction deleted');
      await this.store.changed();
    } catch (e) { this.toast.error(errorMessage(e)); }
  }

  /** Every filtered row (not just this page), fetched 200 at a time in the current sort. */
  async export() {
    this.exporting.set(true);
    try {
      const all: Transaction[] = [];
      const base = { ...this.params(), size: 200 };
      for (let page = 1; ; page++) {
        const d = await firstValueFrom(this.api.transactionsPage({ ...base, page }));
        all.push(...d.rows);
        if (page >= d.pages || !d.rows.length) break;
      }
      downloadCsv('transactions.csv', [
        ['date', 'type', 'asset_class', 'name', 'quantity', 'amount', 'amount_usd', 'principal', 'fees', 'notes', 'source'],
        ...all.map(t => [t.date, t.type, t.asset_class, t.instrument_name, t.quantity, t.amount, t.amount_fc, t.principal, t.fees, t.notes, t.source]),
      ]);
    } catch (e) { this.toast.error(`Couldn't export · ${errorMessage(e)}`); }
    finally { this.exporting.set(false); }
  }

  // ---- CSV import modal
  openImport() { this.importing.set(true); }
  closeImport() {
    this.importing.set(false); this.preview.set(null); this.refused.set(null); this.importError.set(null);
    this.csv = ''; this.csvName.set('');
  }

  downloadTemplate() {
    const blob = new Blob([TEMPLATE], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'transactions-template.csv';
    a.click();
  }

  async onFiles(files: File[]) {
    const f = files[0];
    if (!f) return;
    this.csvName.set(f.name);
    this.csv = await f.text();
    await this.runPreview();
  }

  async runPreview() {
    this.busy.set(true);
    this.importError.set(null);
    this.refused.set(null);
    try { this.preview.set(await firstValueFrom(this.api.importPreview(this.csv))); }
    catch (e) { this.importError.set(errorMessage(e)); }
    finally { this.busy.set(false); }
  }

  selectedRows() { return (this.preview()?.rows ?? []).filter(r => r.selected); }

  backToPaste() { this.preview.set(null); this.refused.set(null); this.importError.set(null); }

  async commit() {
    this.busy.set(true);
    this.importError.set(null);
    this.refused.set(null);
    try {
      const res = await firstValueFrom(this.api.importCommit(this.selectedRows()));
      const failed = (res.results ?? []).filter((r: ImportRowResult) => !r.ok);
      this.toast.ok(`Imported ${res.imported} transaction${res.imported === 1 ? '' : 's'}`);
      if (failed.length) this.toast.error(`${failed.length} failed · first: ${failed[0].name}: ${failed[0].error}`);
      completeImportDue(this.actions);
      this.closeImport();
      await this.store.changed();
    } catch (e) {
      const r = refusedRows(e);
      if (r) { this.refused.set(r); this.toast.error(errorMessage(e)); showRefusal('csv-refused'); }
      else this.importError.set(errorMessage(e));
    } finally { this.busy.set(false); }
  }
}
