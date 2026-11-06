import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { fmtDate, inr, pct, qty, signClass } from '../../core/format';
import { errorMessage } from '../../core/http';
import { CLASS_LABEL, AssetClass, Report, ReportColumn, ReportMeta } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';

const GROUP_ICON: Record<string, string> = { Portfolio: 'layers', Performance: 'chart', Tax: 'receipt', Transactions: 'list' };
const SIGNED = /gain|unrealized|realized|total|xirr|ret|twr|change|balance_diff|day_change/;
const UNSIGNED_PCT = /share|weight|rate/;
const PRICE = /price|avg_cost|nav/;
const GROUP_OPTIONS: Record<string, [string, string][]> = {
  summary: [['asset', 'By asset class'], ['member', 'By family member']],
  xirr: [['holding', 'By holding'], ['asset', 'By asset class']],
};
const VIEWS: [string, string][] = [['periods', 'Periods'], ['monthly', 'Month on month'], ['quarterly', 'Quarter on quarter'], ['yearly', 'Year on year']];

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page reports">
      <div class="page-head no-print">
        <div><h1>Reports</h1><p class="sub">{{ auth.portfolioLabel() === 'Family' ? 'Family portfolio' : auth.portfolioLabel() + "'s portfolio" }} · export any report to Excel or PDF</p></div>
      </div>

      <div class="layout">
        <aside class="catalog card flush no-print">
          @for (g of groups(); track g.name) {
            <div class="cat-group"><app-icon [name]="g.icon" [size]="14" /> {{ g.name }}</div>
            @for (r of g.items; track r.key) {
              <button class="cat-item" [class.on]="r.key === key()" (click)="open(r.key)">
                <b>{{ r.title }}</b><small>{{ r.description }}</small>
              </button>
            }
          }
        </aside>

        <section class="viewer">
          @if (meta(); as m) {
            <div class="card head-card no-print">
              <div class="rh">
                <div><h2>{{ m.title }}</h2><p class="small muted">{{ m.description }}</p></div>
                <div class="row">
                  <button class="btn sm" (click)="download()" [disabled]="!report() || exporting()"><app-icon name="download" [size]="14" /> Excel</button>
                  <button class="btn sm" (click)="print()" [disabled]="!report()"><app-icon name="printer" [size]="14" /> Print / PDF</button>
                </div>
              </div>
              @if (m.filters.length) {
                <div class="filters">
                  @if (m.filters.includes('fy')) {
                    <label class="f"><span>Financial year</span>
                      <select class="input" [ngModel]="params()['fy'] || years()[0]" (ngModelChange)="set('fy', $event)">@for (y of years(); track y) { <option [value]="y">{{ y }}</option> }</select></label>
                  }
                  @if (m.filters.includes('period')) {
                    <label class="f"><span>From</span><input class="input" type="date" [ngModel]="params()['from'] || defaultFrom()" (ngModelChange)="set('from', $event)" /></label>
                    <label class="f"><span>To</span><input class="input" type="date" [ngModel]="params()['to'] || today" (ngModelChange)="set('to', $event)" /></label>
                    <div class="f"><span>Quick</span><div class="seg">
                      <button (click)="preset('fy')">This FY</button><button (click)="preset('lastfy')">Last FY</button><button (click)="preset('all')">All time</button></div></div>
                  }
                  @if (m.filters.includes('asset')) {
                    <label class="f"><span>Asset class</span>
                      <select class="input" [ngModel]="params()['asset'] || ''" (ngModelChange)="set('asset', $event)">
                        <option value="">All</option>@for (a of assetClasses(); track a) { <option [value]="a">{{ classLabel(a) }}</option> }
                      </select></label>
                  }
                  @if (m.filters.includes('group') && groupOptions().length) {
                    <div class="f"><span>Group</span><div class="seg">
                      @for (o of groupOptions(); track o[0]) { <button [class.on]="(params()['group'] || groupOptions()[0][0]) === o[0]" (click)="set('group', o[0])">{{ o[1] }}</button> }
                    </div></div>
                  }
                  @if (m.filters.includes('view')) {
                    <div class="f"><span>View</span><div class="seg">
                      @for (o of views; track o[0]) { <button [class.on]="(params()['view'] || 'periods') === o[0]" (click)="set('view', o[0])">{{ o[1] }}</button> }
                    </div></div>
                  }
                </div>
              }
            </div>

            <div class="card flush sheet" [class.loading-fade]="loading()">
              @if (report(); as r) {
                <div class="print-head">
                  <div class="ph-brand">Investments · Shubh Labh</div>
                  <h2>{{ r.title }}</h2>
                  <p>{{ r.portfolio }}{{ r.subtitle ? ' · ' + r.subtitle : '' }} · generated {{ r.generated_at.slice(0, 16).replace('T', ' ') }}</p>
                </div>
                <div class="sheet-meta no-print"><span>{{ r.rows.length }} row{{ r.rows.length === 1 ? '' : 's' }}{{ r.subtitle ? ' · ' + r.subtitle : '' }}</span></div>
                <div class="table-wrap">
                  <table class="table report-table">
                    <thead><tr>@for (c of r.columns; track c.key) { <th [class.num]="isNum(c)">{{ c.label }}</th> }</tr></thead>
                    <tbody>
                      @for (row of r.rows; track $index) {
                        <tr [class.clickable]="!!row['id']" (click)="row['id'] && openHolding(row['id'])">
                          @for (c of r.columns; track c.key) { <td [class.num]="isNum(c)" [class]="tone(c, row[c.key])">{{ cell(c, row[c.key]) }}</td> }
                        </tr>
                      } @empty { <tr><td [attr.colspan]="r.columns.length"><div class="empty"><h3>Nothing to show</h3><p>No data for these filters.</p></div></td></tr> }
                    </tbody>
                    @if (r.totals && r.rows.length) {
                      <tfoot><tr>@for (c of r.columns; track c.key) { <td [class.num]="isNum(c)" [class]="tone(c, r.totals![c.key])">{{ cell(c, r.totals![c.key]) }}</td> }</tr></tfoot>
                    }
                  </table>
                </div>
                @if (r.note) { <p class="note"><app-icon name="info" [size]="14" /> {{ r.note }}</p> }
              } @else if (error()) {
                <div class="notice bad" style="margin:16px"><app-icon name="alert" [size]="16" /> {{ error() }}</div>
              } @else { <div class="skeleton" style="height:320px;margin:16px"></div> }
            </div>
          }
        </section>
      </div>
    </div>`,
  styles: [`
    .layout { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 20px; align-items: start; }
    .catalog { position: sticky; top: 84px; padding: 8px; max-height: calc(100vh - 110px); overflow-y: auto; }
    .cat-group { display: flex; align-items: center; gap: 7px; padding: 12px 10px 6px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    .cat-item { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 9px 10px 9px 12px; border: 0; border-radius: 8px; background: none;
      text-align: left; cursor: pointer; color: var(--text); border-left: 3px solid transparent; }
    .cat-item:hover { background: var(--surface-hover); }
    .cat-item.on { background: var(--accent-soft); border-left-color: var(--primary); }
    .cat-item b { font-size: 13.5px; font-weight: 600; }
    .cat-item small { font-size: 11.5px; color: var(--muted); line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .viewer { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .head-card { padding: 18px 20px; }
    .rh { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
    .rh h2 { font-size: 17px; }
    .filters { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: flex-end; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
    .f { display: flex; flex-direction: column; gap: 5px; }
    .f > span { font-size: 11.5px; font-weight: 600; color: var(--muted); }
    .f .input { height: 32px; font-size: 13px; width: auto; min-width: 150px; }
    .sheet-meta { padding: 12px 20px; font-size: 12.5px; color: var(--muted); border-bottom: 1px solid var(--border); }
    .report-table th { white-space: normal; min-width: 70px; vertical-align: bottom; }
    .report-table td { font-size: 13px; }
    .report-table tfoot td { font-weight: 650; }
    .note { display: flex; gap: 8px; align-items: flex-start; padding: 12px 20px; font-size: 12.5px; color: var(--text-2); border-top: 1px solid var(--border); background: var(--surface-2); }
    .print-head { display: none; }
    @media (max-width: 1000px) {
      .layout { grid-template-columns: minmax(0, 1fr); }
      .catalog { position: static; max-height: none; display: flex; overflow-x: auto; gap: 6px; padding: 8px; }
      .cat-group { display: none; }
      .cat-item { flex: 0 0 200px; border-left: 0; border-bottom: 3px solid transparent; }
      .cat-item.on { border-bottom-color: var(--primary); }
    }
    @media print {
      .layout { display: block; }
      .sheet { border: 0; box-shadow: none; }
      .print-head { display: block; padding: 0 0 12px; }
      .ph-brand { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #8a5a12; }
      .print-head h2 { font-size: 18px; margin: 2px 0; }
      .print-head p { font-size: 11px; color: #555; }
      .report-table th, .report-table td { padding: 5px 6px; font-size: 9.5px; }
      .table-wrap { overflow: visible; }
    }
  `],
})
export class ReportsComponent {
  auth = inject(AuthService);
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  catalog = signal<ReportMeta[]>([]);
  years = signal<string[]>([]);
  assetClasses = signal<string[]>([]);
  key = signal<string>(this.route.snapshot.queryParamMap.get('r') || 'summary');
  params = signal<Record<string, string>>({});
  report = signal<Report | null>(null);
  loading = signal(false);
  exporting = signal(false);
  error = signal<string | null>(null);
  views = VIEWS;
  today = new Date().toISOString().slice(0, 10);

  meta = computed(() => this.catalog().find(r => r.key === this.key()) ?? null);
  groups = computed(() => {
    const out: { name: string; icon: string; items: ReportMeta[] }[] = [];
    for (const r of this.catalog()) {
      let g = out.find(x => x.name === r.group);
      if (!g) out.push(g = { name: r.group, icon: GROUP_ICON[r.group] ?? 'file', items: [] });
      g.items.push(r);
    }
    return out;
  });
  groupOptions = computed(() => GROUP_OPTIONS[this.key()] ?? []);
  defaultFrom = computed(() => {
    const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return `${y}-04-01`;
  });

  constructor() {
    void this.loadCatalog();
    effect(() => {
      const k = this.key(), p = this.params(), v = this.store.version();
      queueMicrotask(() => this.load(k, p, v));
    });
  }

  private async loadCatalog() {
    try {
      const c = await firstValueFrom(this.api.reportCatalog());
      this.catalog.set(c.reports); this.years.set(c.years); this.assetClasses.set(c.asset_classes);
    } catch (e) { this.error.set(errorMessage(e)); }
  }

  private seq = 0;
  private async load(key: string, params: Record<string, string>, _v: number) {
    const n = ++this.seq;
    this.loading.set(true);
    try {
      const r = await firstValueFrom(this.api.report(key, params));
      if (n === this.seq) { this.report.set(r); this.error.set(null); }
    } catch (e) {
      if (n === this.seq) { this.report.set(null); this.error.set(errorMessage(e)); }
    } finally {
      if (n === this.seq) this.loading.set(false);
    }
  }

  open(key: string) {
    this.report.set(null);
    this.params.set({});
    this.key.set(key);
    this.router.navigate([], { queryParams: { r: key }, replaceUrl: true });
  }
  set(k: string, v: string) { this.params.update(p => ({ ...p, [k]: v })); }
  preset(which: 'fy' | 'lastfy' | 'all') {
    const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    if (which === 'fy') this.params.update(p => ({ ...p, from: `${y}-04-01`, to: this.today }));
    if (which === 'lastfy') this.params.update(p => ({ ...p, from: `${y - 1}-04-01`, to: `${y}-03-31` }));
    if (which === 'all') this.params.update(p => ({ ...p, from: '2000-01-01', to: this.today }));
  }

  classLabel = (a: string) => CLASS_LABEL[a as AssetClass] ?? a;
  isNum = (c: ReportColumn) => c.type !== 'text' && c.type !== 'date';
  cell(c: ReportColumn, v: any): string {
    if (v === null || v === undefined || v === '') return c.type === 'text' ? '' : '—';
    switch (c.type) {
      case 'inr': return inr(v, PRICE.test(c.key) ? 2 : 0, SIGNED.test(c.key));
      case 'pct': return pct(v, UNSIGNED_PCT.test(c.key) ? 1 : 2, !UNSIGNED_PCT.test(c.key));
      case 'qty': return qty(v);
      case 'num': return Number(v).toLocaleString('en-IN');
      case 'date': return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? fmtDate(String(v)) : String(v);
      default: return String(v);
    }
  }
  tone(c: ReportColumn, v: any) { return (c.type === 'inr' || c.type === 'pct') && SIGNED.test(c.key) && typeof v === 'number' ? signClass(v) : ''; }

  openHolding(id: number) { this.router.navigate(['/holding', id]); }
  print() { window.print(); }

  async download() {
    this.exporting.set(true);
    try {
      const blob = await firstValueFrom(this.api.reportXlsx(this.key(), this.params()));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.key()}-${this.today}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.exporting.set(false);
    }
  }
}
