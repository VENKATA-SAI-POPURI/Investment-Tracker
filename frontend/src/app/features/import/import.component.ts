import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fileToBase64 } from '../../core/format';
import { errorMessage } from '../../core/http';
import { CasPreview } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { EpfImportComponent } from './epf-import.component';
import { TradebookImportComponent } from './tradebook-import.component';

/** One place to bring statements in: CAS PDFs, Kite tradebooks and EPF passbooks here, plus the door to the P2P importer. */
@Component({
  selector: 'app-import',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, TradebookImportComponent, EpfImportComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head"><div><h1>Import statements</h1>
        <p class="sub">Bring in history from your statements instead of typing it · importing into {{ auth.portfolioLabel() === 'Family' ? 'your own portfolio' : auth.portfolioLabel() + "'s portfolio" }}</p></div></div>

      <section class="sources">
        <button class="src" [class.on]="source() === 'cas'" (click)="source.set('cas')"><span class="chip green"><app-icon name="file" [size]="18" /></span>
          <div><b>CAS statement (PDF)</b><small>Mutual funds from CAMS / KFintech; NPS and demat holdings from NSDL / CDSL</small></div></button>
        <button class="src" [class.on]="source() === 'kite'" (click)="source.set('kite')"><span class="chip blue"><app-icon name="table" [size]="18" /></span>
          <div><b>Kite tradebook</b><small>Zerodha equity and ETF trades (.xlsx or .csv), reconciled with what you have</small></div></button>
        <button class="src" [class.on]="source() === 'epf'" (click)="source.set('epf')"><span class="chip amber"><app-icon name="shield" [size]="18" /></span>
          <div><b>EPF passbook</b><small>EPFO passbooks (PDF) for every year and employer under your UAN</small></div></button>
        <a class="src" routerLink="/p2p" [queryParams]="{ import: 'lenden' }"><span class="chip violet"><app-icon name="users" [size]="18" /></span>
          <div><b>P2P lending reports</b><small>LenDenClub investment reports (Manual, Lumpsum) and order report</small></div><app-icon name="chevronRight" [size]="16" /></a>
      </section>
      <p class="small muted" style="margin:-6px 0 0">Using the app's own CSV template? Import it on <a routerLink="/transactions" [queryParams]="{ import: 1 }">Transactions</a>.</p>

      @if (source() === 'kite') { <app-tradebook-import /> } @else if (source() === 'epf') { <app-epf-import /> } @else {
      <section class="card">
        <div class="card-head"><div><h2>Upload a CAS</h2>
          <span class="hint">Request a detailed CAS (with transactions) from camsonline.com or kfintech.com, or download the NSDL/CDSL CAS from your email</span></div></div>
        @if (!auth.canWrite()) { <div class="notice"><app-icon name="info" [size]="16" /> Read-only access: imports are not available for guests.</div> }
        @else {
          <div class="up">
            <label class="drop" [class.has]="!!fileName()">
              <input type="file" accept="application/pdf,.pdf" (change)="onFile($event)" />
              <app-icon name="upload" [size]="20" />
              <span>{{ fileName() || 'Choose the CAS PDF' }}</span>
            </label>
            <div class="field pw"><label for="cas-pw">PDF password</label>
              <input id="cas-pw" class="input" type="password" [(ngModel)]="password" placeholder="Usually your PAN in capitals" autocomplete="off" /></div>
            <button class="btn primary" (click)="read()" [disabled]="!file || busy()">{{ busy() ? 'Reading…' : 'Read statement' }}</button>
          </div>
          <p class="small muted" style="margin-top:10px"><app-icon name="shield" [size]="13" /> The file is read on the server to extract transactions and is not stored.</p>
        }
        @if (error()) { <div class="notice bad" style="margin-top:12px"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }
      </section>

      @if (preview(); as p) {
        <section class="kpis" style="--kpi-cols:4">
          <div class="kpi"><span class="label">Statement</span><span class="value">{{ p.file_type || 'CAS' }}</span><span class="meta">{{ p.cas_type === 'DETAILED' ? 'with transaction history' : p.cas_type === 'SUMMARY' ? 'summary (closing units only)' : 'holdings' }}</span></div>
          <div class="kpi"><span class="label">Investor</span><span class="value" style="font-size:18px">{{ p.investor || '—' }}</span><span class="meta">{{ p.period.from ? (p.period.from | dt) + ' – ' + (p.period.to | dt) : '' }}</span></div>
          <div class="kpi"><span class="label">New transactions</span><span class="value">{{ newTxns() }}</span><span class="meta">{{ dupTxns() }} already in the app</span></div>
          <div class="kpi"><span class="label">Schemes</span><span class="value">{{ p.funds.length + p.nps.length }}</span><span class="meta">{{ p.funds.length }} mutual funds · {{ p.nps.length }} NPS</span></div>
        </section>

        @if (p.funds.length) {
          <section class="card flush">
            <div class="card-head"><h2>Mutual funds</h2><label class="check small"><input type="checkbox" [checked]="allFunds()" (change)="toggleAll($event)" /> Select all</label></div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th></th><th>Scheme</th><th class="hide-sm">Folio</th><th class="num">Units (CAS)</th><th class="num">New</th><th class="num hide-sm">Already in app</th><th>Goes into</th></tr></thead>
                <tbody>
                  @for (f of p.funds; track f.key) {
                    <tr>
                      <td><input type="checkbox" [(ngModel)]="f.selected" (ngModelChange)="bump()" [disabled]="!f.new_count" [attr.aria-label]="'Import ' + f.name" /></td>
                      <td class="name-cell"><div style="font-weight:500">{{ f.name }}</div><div class="sub">{{ f.amc }}{{ f.opening_only ? ' · summary statement: one opening entry at cost' : '' }}</div></td>
                      <td class="hide-sm small muted">{{ f.folio }}</td>
                      <td class="num">{{ f.closing_units | qty }}</td>
                      <td class="num"><b>{{ f.new_count }}</b></td>
                      <td class="num hide-sm muted">{{ f.duplicate_count }}</td>
                      <td>@if (f.matched_name) { <span class="badge info">{{ f.matched_name }}</span> } @else { <span class="badge good">New holding</span> }</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        @if (p.nps.length) {
          <section class="card flush">
            <div class="card-head"><h2>NPS schemes</h2><span class="hint">Units and NAV from NSDL</span></div>
            <div class="table-wrap"><table class="table">
              <thead><tr><th></th><th>Scheme</th><th class="num">Units</th><th class="num">NAV</th><th class="num">Value</th><th>Action</th></tr></thead>
              <tbody>
                @for (n of p.nps; track n.key) {
                  <tr><td><input type="checkbox" [(ngModel)]="n.selected" (ngModelChange)="bump()" [attr.aria-label]="'Import ' + n.name" /></td>
                    <td class="name-cell"><div style="font-weight:500">{{ n.name }}</div><div class="sub">{{ n.tier }}{{ n.fund_manager ? ' · ' + n.fund_manager : '' }}</div></td>
                    <td class="num">{{ n.units | qty }}</td><td class="num">{{ n.nav | inr: 4 }}</td><td class="num">{{ n.value | inr }}</td>
                    <td>@if (n.action === 'update_nav') { <span class="badge info">Update NAV</span> } @else { <span class="badge good">Add scheme</span> }</td></tr>
                }
              </tbody>
            </table></div>
            <p class="small muted" style="padding:10px 22px 14px">New schemes start with one opening entry at today's value (NSDL doesn't list contributions); add your contributions on the NPS page for accurate returns.</p>
          </section>
        }

        @if (p.demat.length) {
          <section class="card flush">
            <div class="card-head"><h2>Demat holdings check</h2><span class="hint">Compared with your app holdings; nothing is changed</span></div>
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Security</th><th class="hide-sm">ISIN</th><th class="num">In demat</th><th class="num">In app</th><th>Status</th></tr></thead>
              <tbody>
                @for (h of p.demat; track h.isin + h.name) {
                  <tr><td class="name-cell">{{ h.name }}@if (h.app_name && h.app_name !== h.name) { <div class="sub">app: {{ h.app_name }}</div> }</td>
                    <td class="hide-sm small muted">{{ h.isin }}</td><td class="num">{{ h.units | qty }}</td><td class="num">{{ h.app_units === null ? '—' : (h.app_units | qty) }}</td>
                    <td><span class="badge" [class.good]="h.status === 'match'" [class.warn]="h.status === 'differs'" [class.bad]="h.status === 'missing'">
                      {{ h.status === 'match' ? 'Matches' : h.status === 'differs' ? 'Units differ' : 'Not in app' }}</span></td></tr>
                }
              </tbody>
            </table></div>
          </section>
        }

        @if (p.warnings.length) { <div class="notice warn"><app-icon name="alert" [size]="16" /> <div>@for (w of p.warnings; track $index) { <div>{{ w }}</div> }</div></div> }

        @if (p.funds.length || p.nps.length) {
          <div class="row" style="justify-content:flex-end;gap:10px">
            <button class="btn" (click)="reset()">Cancel</button>
            <button class="btn primary" (click)="commit()" [disabled]="busy() || !selectedCount()">{{ busy() ? 'Importing…' : 'Import ' + selectedCount() + ' item' + (selectedCount() === 1 ? '' : 's') }}</button>
          </div>
        }
      }

      @if (results(); as r) {
        <section class="card">
          <div class="card-head"><h2>Import finished</h2><span class="hint">{{ r.imported }} transactions added</span></div>
          @for (x of r.results; track $index) {
            <div class="res"><app-icon [name]="x.ok ? 'checkCircle' : 'alert'" [size]="15" [class]="x.ok ? 'pos' : 'neg'" />
              <span>{{ x.name }}</span><span class="muted small">{{ x.ok ? (x.updated ? 'NAV updated' : x.imported + ' added') : x.error }}</span></div>
          }
          <div class="row" style="margin-top:12px"><a class="btn" routerLink="/holdings/mutual_fund">View mutual funds</a><a class="btn" routerLink="/nps">View NPS</a></div>
        </section>
      }
      }
    </div>`,
  styles: [`
    .sources { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .src { display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 12px; background: var(--surface); border: 1px solid var(--border);
      box-shadow: var(--shadow); color: var(--text); text-decoration: none; text-align: left; font: inherit; cursor: pointer; }
    .src:hover { text-decoration: none; border-color: var(--border-strong); box-shadow: var(--shadow-md); }
    .src.on { border-color: var(--primary); box-shadow: 0 0 0 3px var(--accent-soft); }
    .src > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .src b { font-size: 14px; }
    .src small { font-size: 12px; color: var(--muted); }
    .up { display: flex; gap: 14px; align-items: flex-end; flex-wrap: wrap; }
    .drop { position: relative; flex: 1; min-width: 240px; display: flex; align-items: center; gap: 10px; height: 64px; padding: 0 16px; border-radius: 10px;
      border: 1.5px dashed var(--border-strong); background: var(--surface-2); color: var(--text-2); cursor: pointer; font-size: 13.5px; }
    .drop:hover, .drop.has { border-color: var(--primary); color: var(--text); }
    .drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .pw { width: 240px; }
    .res { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .res span:nth-child(2) { flex: 1; }
    @media (max-width: 900px) { .sources { grid-template-columns: minmax(0, 1fr); } .pw { width: 100%; } }
  `],
})
export class ImportComponent {
  auth = inject(AuthService);
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);

  file: File | null = null;
  password = '';
  fileName = signal('');
  busy = signal(false);
  error = signal<string | null>(null);
  preview = signal<CasPreview | null>(null);
  results = signal<{ imported: number; results: { name: string; ok: boolean; imported?: number; error?: string; updated?: string }[] } | null>(null);
  tick = signal(0);  // checkbox edits mutate the preview in place; this re-runs the counts
  source = signal<'cas' | 'kite' | 'epf'>((['kite', 'epf'] as const).find(s => s === inject(ActivatedRoute).snapshot.queryParamMap.get('source')) ?? 'cas');

  newTxns = computed(() => (this.tick(), (this.preview()?.funds ?? []).reduce((a, f) => a + f.new_count, 0)));
  dupTxns = computed(() => (this.preview()?.funds ?? []).reduce((a, f) => a + f.duplicate_count, 0));
  allFunds = computed(() => (this.tick(), (this.preview()?.funds ?? []).filter(f => f.new_count).every(f => f.selected)));
  selectedCount = computed(() => (this.tick(), (this.preview()?.funds ?? []).filter(f => f.selected && f.new_count).length
    + (this.preview()?.nps ?? []).filter(n => n.selected).length));

  onFile(ev: Event) {
    this.file = (ev.target as HTMLInputElement).files?.[0] ?? null;
    this.fileName.set(this.file?.name ?? '');
    this.error.set(null);
  }

  async read() {
    if (!this.file) return;
    this.busy.set(true); this.error.set(null); this.results.set(null);
    try {
      const data = await fileToBase64(this.file);
      this.preview.set(await firstValueFrom(this.api.casPreview(data, this.password)));
    } catch (e) {
      this.preview.set(null);
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  toggleAll(ev: Event) {
    const on = (ev.target as HTMLInputElement).checked;
    for (const f of this.preview()?.funds ?? []) if (f.new_count) f.selected = on;
    this.tick.update(v => v + 1);
  }

  bump() { this.tick.update(v => v + 1); }

  reset() { this.preview.set(null); this.file = null; this.fileName.set(''); this.password = ''; }

  async commit() {
    const p = this.preview();
    if (!p) return;
    this.busy.set(true);
    try {
      const funds = p.funds.filter(f => f.selected && f.new_count)
        .map(f => ({ ...f, transactions: f.transactions.filter(t => !t.duplicate) }));
      const nps = p.nps.filter(n => n.selected);
      const r = await firstValueFrom(this.api.casCommit({ funds, nps, as_of: p.period.to }));
      this.results.set(r);
      this.preview.set(null);
      this.toast.ok(`${r.imported} transactions imported`);
      await this.store.changed();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
