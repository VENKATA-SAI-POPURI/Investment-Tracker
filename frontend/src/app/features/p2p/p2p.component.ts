import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fileToBase64 } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Position } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { SectionTabsComponent } from '../../shared/section-tabs.component';
import { ModalComponent, SortState } from '../../shared/ui';

type Tab = 'active' | 'overdue' | 'closed' | 'defaulted' | 'all';

@Component({
  selector: 'app-p2p',
  standalone: true,
  imports: [FormsModule, TitleCasePipe, IconComponent, SectionTabsComponent, ModalComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './p2p.component.html',
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
  sort = new SortState<Position>('first_date');

  importKind = signal<'order' | 'statement' | null>(null);
  importBusy = signal(false);
  importError = signal<string | null>(null);
  preview = signal<any | null>(null);

  loans = computed(() => this.store.positions().filter(p => p.asset_class === 'p2p'));
  seg = computed(() => this.store.portfolio()?.segments.find(s => s.segment === 'P2P'));
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
  counts = computed(() => ({
    active: this.loans().filter(p => p.status === 'active').length,
    overdue: this.stats().overdue,
    closed: this.loans().filter(p => p.status === 'closed').length,
    defaulted: this.stats().defaulted,
    all: this.loans().length,
  }));
  rows = computed(() => {
    const t = this.tab(), q = this.q().toLowerCase().trim();
    const rows = this.loans().filter(p =>
      (t === 'all' || (t === 'overdue' ? (p.overdue_days ?? 0) > 7 : p.status === t)) &&
      (!q || `${p.name} ${p.ref} ${p.ref2}`.toLowerCase().includes(q)));
    return this.sort.apply(rows);
  });
  cohorts = computed(() => {
    const m = new Map<string, { month: string; count: number; lent: number; back: number; interest: number; defaulted: number; closed: number }>();
    for (const p of this.loans()) {
      const k = (p.first_date ?? '').slice(0, 7);
      const c = m.get(k) ?? { month: k, count: 0, lent: 0, back: 0, interest: 0, defaulted: 0, closed: 0 };
      c.count++; c.lent += p.invested; c.back += p.principal_repaid ?? 0; c.interest += p.interest ?? 0;
      if (p.status === 'defaulted') c.defaulted++;
      if (p.status === 'closed') c.closed++;
      m.set(k, c);
    }
    return [...m.values()].sort((a, b) => b.month.localeCompare(a.month));
  });

  open(p: Position) { this.router.navigate(['/holding', p.id]); }

  startImport(kind: 'order' | 'statement') {
    this.importKind.set(kind);
    this.preview.set(null);
    this.importError.set(null);
  }

  async onFile(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.importBusy.set(true);
    this.importError.set(null);
    try {
      const data = await fileToBase64(file);
      const res = this.importKind() === 'order'
        ? await firstValueFrom(this.api.orderReportPreview(data))
        : await firstValueFrom(this.api.statementPreview(data));
      if (this.importKind() === 'statement') {
        for (const w of res.warnings) if (w.type === 'status_change') w.apply = true;
      }
      this.preview.set(res);
    } catch (e) {
      this.importError.set(errorMessage(e));
    } finally {
      this.importBusy.set(false);
    }
  }

  selectedCount() {
    const p = this.preview();
    if (!p) return 0;
    return (this.importKind() === 'order' ? p.rows : p.suggested).filter((r: any) => r.selected).length;
  }

  async commit() {
    const p = this.preview();
    this.importBusy.set(true);
    try {
      let res: any;
      if (this.importKind() === 'order') {
        res = await firstValueFrom(this.api.orderReportCommit(p.rows.filter((r: any) => r.selected && !r.already_exists)));
        this.toast.ok(`Imported ${res.imported} loan(s)`);
      } else {
        const updates = p.warnings.filter((w: any) => w.type === 'status_change' && w.apply)
          .map((w: any) => ({ instrument_id: w.instrument_id, new_status: w.new_status, loan_id: w.loan_id }));
        res = await firstValueFrom(this.api.statementCommit(p.suggested.filter((r: any) => r.selected), updates));
        this.toast.ok(`Posted ${res.imported} repayment(s)${res.status_updated ? `, updated ${res.status_updated} status(es)` : ''}`);
      }
      const failed = (res.results ?? []).filter((r: any) => !r.ok);
      if (failed.length) this.toast.error(`${failed.length} row(s) skipped: ${failed[0].error}`);
      this.importKind.set(null);
      await this.store.changed();
    } catch (e) {
      this.importError.set(errorMessage(e));
    } finally {
      this.importBusy.set(false);
    }
  }

  toggleAll(rows: any[], v: boolean) { rows.forEach(r => { if (!r.already_exists) r.selected = v; }); }
}
