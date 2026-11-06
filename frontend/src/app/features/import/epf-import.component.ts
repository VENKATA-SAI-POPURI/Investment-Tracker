import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fileToBase64 } from '../../core/format';
import { errorMessage } from '../../core/http';
import { EpfPreview } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';

const KIND_LABEL: Record<string, string> = {
  opening: 'Opening balance', contribution: 'Contribution', withdrawal: 'Withdrawal', interest: 'Interest credited',
  transfer_in: 'Transfer in', transfer_out: 'Transfer out',
};

/** EPFO passbooks: every year and member ID of a UAN into one EPF holding, checked against each closing balance. */
@Component({
  selector: 'app-epf-import',
  standalone: true,
  imports: [RouterLink, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <div class="card-head"><div><h2>Upload EPF passbooks</h2>
        <span class="hint">passbook.epfindia.gov.in → choose each member ID and financial year → Download. Upload them all at once; old and new employers' member IDs under the same UAN are combined.</span></div></div>
      @if (!auth.canWrite()) { <div class="notice"><app-icon name="info" [size]="16" /> Read-only access: imports are not available for guests.</div> }
      @else {
        <label class="drop">
          <input type="file" accept="application/pdf,.pdf" multiple (change)="onFiles($event)" [disabled]="busy()" aria-label="Choose EPF passbook PDFs" />
          <app-icon name="upload" [size]="20" />
          <span>{{ busy() && !preview() ? 'Reading…' : names() || 'Choose passbook PDFs' }}</span>
        </label>
        <p class="small muted" style="margin-top:10px"><app-icon name="shield" [size]="13" /> Read on the server and not stored. Transfers between your own member IDs are left out so nothing is counted twice.</p>
      }
      @if (error()) { <div class="notice bad" style="margin-top:12px"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }
    </section>

    @if (preview(); as p) {
      <section class="kpis">
        <div class="kpi"><span class="label">UAN</span><span class="value" style="font-size:20px">{{ p.uan ?? '—' }}</span><span class="meta">{{ p.statements.length }} statement{{ p.statements.length === 1 ? '' : 's' }} · {{ members() }} member ID{{ members() === 1 ? '' : 's' }}</span></div>
        <div class="kpi"><span class="label">Balance per EPFO</span><span class="value">{{ p.closing_balance | inr }}</span><span class="meta">latest closing balance, before this year's interest</span></div>
        <div class="kpi"><span class="label">To add</span><span class="value">{{ p.new_count }}</span><span class="meta">{{ p.transactions.length - p.new_count }} already in the app</span></div>
        <div class="kpi"><span class="label">Statements</span><span class="value" [class.pos]="allOk()" [class.neg]="!allOk()">{{ allOk() ? 'All add up' : 'Check below' }}</span><span class="meta">each statement's rows vs its closing balance</span></div>
      </section>

      <section class="card flush">
        <div class="card-head"><div><h2>Statements</h2><span class="hint">Opening + contributions + interest − withdrawals and transfers, checked against EPFO's closing balance</span></div></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Employer</th><th>Member ID</th><th>Year</th><th class="num">Rows</th><th class="num">Closing balance</th><th>Check</th></tr></thead>
          <tbody>
            @for (s of p.statements; track s.member_id + s.fy) {
              <tr><td>{{ s.establishment }}</td><td class="small muted">{{ s.member_id }}</td><td>FY {{ s.fy }}</td><td class="num">{{ s.entries }}</td>
                <td class="num">{{ s.closing | inr }}</td>
                <td>@if (s.check.ok) { <span class="badge good">Adds up</span> }
                  @else { <span class="badge bad" [title]="'Employee ' + s.check.employee.computed + ' vs ' + s.check.employee.statement + '; employer ' + s.check.employer.computed + ' vs ' + s.check.employer.statement">Off by {{ off(s.check) | inr }}</span> }</td></tr>
            }
          </tbody>
        </table></div>
      </section>

      <section class="card flush">
        <div class="card-head"><div><h2>What gets recorded</h2>
          <span class="hint">{{ p.account ? 'Added to your ' + p.account.name + ' holding' : 'A new EPF holding is created' }} · {{ counts().contribution }} contributions · {{ counts().withdrawal }} withdrawals · {{ counts().interest }} interest credits</span></div></div>
        @for (n of p.notes; track $index) { <div class="notice warn" style="margin:0 22px 10px"><app-icon name="info" [size]="15" /> {{ n }}</div> }
        <div class="table-wrap" style="max-height:420px"><table class="table">
          <thead><tr><th>Date</th><th>What</th><th class="num">Amount</th><th class="hide-sm">Details</th><th></th></tr></thead>
          <tbody>
            @for (t of p.transactions; track $index) {
              <tr [class.muted]="t.duplicate">
                <td>{{ t.date | dt }}</td>
                <td><span class="badge" [class.good]="t.type === 'BUY'" [class.info]="t.type === 'CREDIT'" [class.warn]="t.type === 'SELL'">{{ label[t.kind] }}</span></td>
                <td class="num" [class.neg]="t.type === 'SELL'">{{ t.type === 'SELL' ? '−' : '' }}{{ t.amount | inr }}</td>
                <td class="hide-sm small muted ellipsis" style="max-width:420px">{{ t.notes }}</td>
                <td class="small muted">{{ t.duplicate ? 'already in app' : '' }}</td>
              </tr>
            }
          </tbody>
        </table></div>
      </section>

      <div class="row" style="justify-content:flex-end;gap:10px">
        <button class="btn" (click)="reset()">Cancel</button>
        <button class="btn primary" (click)="apply()" [disabled]="busy() || !p.new_count">{{ busy() ? 'Importing…' : p.new_count ? 'Import ' + p.new_count + ' entries' : 'Nothing new to import' }}</button>
      </div>
    }

    @if (done(); as d) {
      <section class="card">
        <div class="card-head"><h2>EPF imported</h2><span class="hint">{{ d.imported }} entries added · {{ d.skipped }} already there · balance {{ d.balance | inr }} per EPFO</span></div>
        <div class="row"><a class="btn" routerLink="/epf">View EPF</a></div>
      </section>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 22px; }
    .drop { position: relative; display: flex; align-items: center; gap: 10px; height: 64px; padding: 0 16px; border-radius: 10px;
      border: 1.5px dashed var(--border-strong); background: var(--surface-2); color: var(--text-2); cursor: pointer; font-size: 13.5px; }
    .drop:hover { border-color: var(--primary); color: var(--text); }
    .drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  `],
})
export class EpfImportComponent {
  auth = inject(AuthService);
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);

  label = KIND_LABEL;
  names = signal('');
  busy = signal(false);
  error = signal<string | null>(null);
  preview = signal<EpfPreview | null>(null);
  done = signal<{ imported: number; skipped: number; balance: number } | null>(null);
  private files: { name: string; file_data: string }[] = [];

  members = computed(() => new Set(this.preview()?.statements.map(s => s.member_id)).size);
  allOk = computed(() => (this.preview()?.statements ?? []).every(s => s.check.ok));
  counts = computed(() => {
    const out = { contribution: 0, withdrawal: 0, interest: 0 };
    for (const t of this.preview()?.transactions ?? []) {
      if (!t.duplicate && (t.kind === 'contribution' || t.kind === 'withdrawal' || t.kind === 'interest')) out[t.kind]++;
    }
    return out;
  });
  off(c: EpfPreview['statements'][number]['check']) {
    return Math.abs(c.employee.computed - (c.employee.statement ?? c.employee.computed)) + Math.abs(c.employer.computed - (c.employer.statement ?? c.employer.computed));
  }

  async onFiles(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const picked = [...(input.files ?? [])];
    input.value = '';
    if (!picked.length) return;
    this.names.set(picked.map(f => f.name).join(', '));
    this.busy.set(true); this.error.set(null); this.done.set(null); this.preview.set(null);
    try {
      this.files = await Promise.all(picked.map(async f => ({ name: f.name, file_data: await fileToBase64(f) })));
      this.preview.set(await firstValueFrom(this.api.epfPreview(this.files)));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  reset() { this.preview.set(null); this.names.set(''); this.files = []; this.error.set(null); }

  async apply() {
    this.busy.set(true); this.error.set(null);
    try {
      const r = await firstValueFrom(this.api.epfCommit(this.files));
      this.done.set(r);
      this.toast.ok(`EPF: ${r.imported} entries imported`);
      this.reset();
      await this.store.changed();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
