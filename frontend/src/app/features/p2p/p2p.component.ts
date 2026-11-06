import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fileToBase64 } from '../../core/format';
import { errorMessage } from '../../core/http';
import { LendenFile, LendenPreview, Position } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { SectionTabsComponent } from '../../shared/section-tabs.component';
import { ModalComponent, SortState } from '../../shared/ui';

type Tab = 'active' | 'overdue' | 'closed' | 'defaulted' | 'all';
type ImportTab = 'repayments' | 'new' | 'status' | 'details' | 'check';
interface Group { key: string; label: string; sub: string; latest: string; count: number; lent: number; back: number; interest: number;
  outstanding: number; defaulted: number; closed: number; }

@Component({
  selector: 'app-p2p',
  standalone: true,
  imports: [FormsModule, TitleCasePipe, IconComponent, SectionTabsComponent, ModalComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './p2p.component.html',
  styles: [`
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
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private router = inject(Router);

  tab = signal<Tab>('active');
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

  // Tools → Import links here with ?import=lenden
  private importParam = (() => {
    const k = inject(ActivatedRoute).snapshot.queryParamMap.get('import');
    if (k) queueMicrotask(() => this.startImport());
    return k;
  })();

  open(p: Position) { this.router.navigate(['/holding', p.id]); }

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
      this.importing.set(false);
      await this.store.changed();
    } catch (e) {
      this.importError.set(errorMessage(e));
    } finally {
      this.importBusy.set(false);
    }
  }
}
