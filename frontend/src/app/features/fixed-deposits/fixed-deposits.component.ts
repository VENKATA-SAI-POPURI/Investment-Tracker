import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Position } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { SectionTabsComponent } from '../../shared/section-tabs.component';
import { ModalComponent } from '../../shared/ui';

@Component({
  selector: 'app-fixed-deposits',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, SectionTabsComponent, ModalComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Holdings</h1>
        @if (auth.canWrite()) { <button class="btn sm" (click)="dialog.add('fixed_deposit')"><app-icon name="plus" [size]="15" /> New FD</button> }
      </div>
      <app-section-tabs group="holdings" current="/fixed-deposits" style="margin-top:-12px" />
      <section class="kpis">
        <div class="kpi"><span class="chip blue sm"><app-icon name="bank" [size]="15" /></span><span class="label">Active deposits</span><span class="value">{{ stats().principal | inr }}</span><span class="meta">{{ active().length }} FDs</span></div>
        <div class="kpi"><span class="chip green sm"><app-icon name="trend" [size]="15" /></span><span class="label">Interest accrued</span><span class="value pos">{{ stats().accrued | inr }}</span></div>
        <div class="kpi"><span class="chip violet sm"><app-icon name="wallet" [size]="15" /></span><span class="label">Value today</span><span class="value">{{ stats().value | inr }}</span></div>
        <div class="kpi"><span class="chip amber sm"><app-icon name="calendar" [size]="15" /></span><span class="label">Next maturity</span><span class="value">{{ stats().next ? (stats().next!.maturity_date | dt) : '—' }}</span>
          <span class="meta">{{ stats().next ? stats().next!.name + ' · ' + stats().next!.days_to_maturity + ' days' : '' }}</span></div>
      </section>
      <section class="card flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Bank</th><th>Started</th><th class="num">Rate</th><th class="num">Deposit</th><th class="num">Value now</th><th>Matures</th><th class="num hide-sm">At maturity</th><th></th></tr></thead>
            <tbody>
              @for (p of fds(); track p.id) {
                <tr [class.muted]="!p.is_open">
                  <td><a [routerLink]="['/holding', p.id]">{{ p.name }}</a><div class="sub">{{ p.platform || '' }}</div></td>
                  <td>{{ p.first_date | dt }}</td><td class="num">{{ p.rate ? p.rate + '%' : '—' }}</td>
                  <td class="num">{{ p.invested | inr }}</td><td class="num">{{ p.is_open ? (p.value | inr) : '—' }}</td>
                  <td>{{ p.maturity_date | dt }} @if (p.is_open && p.days_to_maturity !== null && p.days_to_maturity! <= 30) { <span class="badge warn">{{ p.days_to_maturity }}d</span> }</td>
                  <td class="num hide-sm">{{ p.is_open ? (p.maturity_value | inr) : (p.invested + p.realized | inr) }}</td>
                  <td class="right">
                    @if (p.is_open && auth.canWrite()) { <button class="btn sm" (click)="startMature(p)">Mark matured</button> }
                    @else if (!p.is_open) { <span class="badge good">Matured · {{ p.realized | inr: 0 : true }}</span> }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="8"><div class="empty"><app-icon name="bank" [size]="28" /><h3>No fixed deposits yet</h3><p>Add an FD to track accrued interest and get maturity reminders.</p></div></td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
    @if (maturing(); as m) {
      <app-modal [title]="'Close FD at ' + m.name" [width]="440" (close)="maturing.set(null)">
        <form class="form" (ngSubmit)="mature()">
          <div class="cols">
            <div class="field"><label for="fd-date">Date received</label><input id="fd-date" class="input" type="date" name="date" [(ngModel)]="mDate" /></div>
            <div class="field"><label for="fd-amt">Amount received (₹)</label><input id="fd-amt" class="input num" type="number" step="0.01" name="amount" [(ngModel)]="mAmount" /></div>
          </div>
          <p class="small muted">Interest = amount received − deposit. It is reported as income in the Tax page.</p>
          @if (error()) { <div class="notice bad">{{ error() }}</div> }
          <div class="form-actions"><button type="button" class="btn" (click)="maturing.set(null)">Cancel</button><button class="btn primary" type="submit">Save</button></div>
        </form>
      </app-modal>
    }`,
})
export class FixedDepositsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private api = inject(ApiService);
  private toast = inject(ToastService);

  fds = computed(() => this.store.positions().filter(p => p.asset_class === 'fixed_deposit')
    .sort((a, b) => Number(b.is_open) - Number(a.is_open) || (a.maturity_date ?? '').localeCompare(b.maturity_date ?? '')));
  active = computed(() => this.fds().filter(p => p.is_open));
  stats = computed(() => {
    const a = this.active();
    return { principal: a.reduce((s, p) => s + p.invested, 0), accrued: a.reduce((s, p) => s + (p.accrued_interest ?? 0), 0),
      value: a.reduce((s, p) => s + p.value, 0), next: [...a].sort((x, y) => (x.days_to_maturity ?? 1e9) - (y.days_to_maturity ?? 1e9))[0] };
  });

  maturing = signal<Position | null>(null);
  error = signal<string | null>(null);
  mDate = ''; mAmount: number | null = null;

  startMature(p: Position) {
    this.mDate = p.maturity_date ?? '';
    this.mAmount = p.maturity_value ?? p.value;
    this.error.set(null);
    this.maturing.set(p);
  }
  async mature() {
    try {
      await firstValueFrom(this.api.matureFd(this.maturing()!.id, { date: this.mDate, amount: this.mAmount }));
      this.toast.ok('FD closed');
      this.maturing.set(null);
      await this.store.changed();
    } catch (e) { this.error.set(errorMessage(e)); }
  }
}
