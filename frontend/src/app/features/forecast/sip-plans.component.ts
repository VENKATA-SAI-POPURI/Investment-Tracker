import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { SEGMENTS, SipFrequency, SipPlan } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';

const FREQ: { key: SipFrequency; label: string }[] = [
  { key: 'monthly', label: 'Monthly' }, { key: 'quarterly', label: 'Quarterly' }, { key: 'weekly', label: 'Weekly' }, { key: 'yearly', label: 'Yearly' }];

/** What you intend to invest on a schedule: feeds the forecasts, the cash-flow calendar and missed-instalment alerts. */
@Component({
  selector: 'app-sip-plans',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, ModalComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flush">
      <div class="card-head">
        <div><h2>SIP plans</h2><span class="hint">{{ total() | inr }} a month across {{ active().length }} active plan{{ active().length === 1 ? '' : 's' }} · used as the default SIP in Outlook and Retirement, and in the cash-flow calendar</span></div>
        @if (auth.canWrite()) { <button class="btn primary sm" (click)="startAdd()"><app-icon name="plus" [size]="14" /> New plan</button> }
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Plan</th><th class="num">Amount</th><th>Every</th><th class="num">Day</th><th class="num hide-sm">Step-up</th><th class="hide-sm">From / to</th><th>Status</th>@if (auth.canWrite()) { <th></th> }</tr></thead>
          <tbody>
            @for (s of plans(); track s.id) {
              <tr [class.off]="!s.active">
                <td class="name-cell">@if (s.instrument_id) { <a [routerLink]="['/holding', s.instrument_id]">{{ s.name }}</a> } @else { {{ s.name }} }<div class="sub">{{ s.segment || 'no asset class' }}{{ s.notes ? ' · ' + s.notes : '' }}</div></td>
                <td class="num">{{ s.amount | inr }}</td><td>{{ s.frequency }}</td><td class="num">{{ s.day_of_month }}</td>
                <td class="num hide-sm">{{ s.step_up_pct ? s.step_up_pct + '%' : '—' }}</td>
                <td class="hide-sm small">{{ s.start_date | dt }}{{ s.end_date ? ' → ' + (s.end_date | dt) : '' }}</td>
                <td><span class="badge" [class.good]="s.active">{{ s.active ? 'Active' : 'Paused' }}</span></td>
                @if (auth.canWrite()) {
                  <td class="num"><div class="row" style="justify-content:flex-end;gap:2px">
                    <button class="btn ghost sm" (click)="toggle(s)">{{ s.active ? 'Pause' : 'Resume' }}</button>
                    <button class="btn ghost icon sm" (click)="startEdit(s)" aria-label="Edit plan"><app-icon name="edit" [size]="15" /></button>
                    <button class="btn ghost icon sm danger" (click)="remove(s)" aria-label="Delete plan"><app-icon name="trash" [size]="15" /></button></div></td>
                }
              </tr>
            } @empty {
              <tr><td colspan="8"><div class="empty"><app-icon name="refresh" [size]="26" /><h3>No SIP plans yet</h3>
                <p>Add what you invest each month and the forecasts, the cash-flow calendar and the missed-instalment alerts pick it up.</p>
                @if (auth.canWrite()) { <button class="btn" (click)="startAdd()"><app-icon name="plus" [size]="15" /> Add a plan</button> }</div></td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
    <p class="small muted">A monthly plan counts as missed when its day has passed by four days with no purchase recorded in that holding (or, for a plan without a holding, in that asset class).</p>

    @if (editing() !== null) {
      <app-modal [title]="f.id ? 'Edit SIP plan' : 'New SIP plan'" [width]="540" (close)="editing.set(null)">
        <form class="form" (ngSubmit)="save()">
          <div class="field"><label for="sp-inst">Holding</label>
            <select id="sp-inst" class="input" name="inst" [(ngModel)]="f.instrument_id">
              <option [ngValue]="null">— none, just an asset class —</option>
              @for (p of holdings(); track p.id) { <option [ngValue]="p.id">{{ p.name }}</option> }
            </select></div>
          <div class="cols">
            <div class="field"><label for="sp-name">Name</label><input id="sp-name" class="input" name="name" [(ngModel)]="f.name" [placeholder]="holdingName() || 'e.g. Index fund SIP'" /></div>
            <div class="field"><label for="sp-seg">Asset class</label>
              <select id="sp-seg" class="input" name="seg" [(ngModel)]="f.segment" [disabled]="!!f.instrument_id">
                <option [ngValue]="null">—</option>@for (s of segments; track s) { <option [value]="s">{{ s }}</option> }
              </select></div>
            <div class="field"><label for="sp-amt">Amount (₹)</label><input id="sp-amt" class="input num" type="number" min="1" name="amount" [(ngModel)]="f.amount" required /></div>
            <div class="field"><label for="sp-freq">Frequency</label>
              <select id="sp-freq" class="input" name="freq" [(ngModel)]="f.frequency">@for (q of freq; track q.key) { <option [value]="q.key">{{ q.label }}</option> }</select></div>
            <div class="field"><label for="sp-day">Day of month</label><input id="sp-day" class="input num" type="number" min="1" max="28" name="day" [(ngModel)]="f.day_of_month" /></div>
            <div class="field"><label for="sp-step">Step-up each year (%)</label><input id="sp-step" class="input num" type="number" min="0" max="50" name="step" [(ngModel)]="f.step_up_pct" /></div>
            <div class="field"><label for="sp-start">Starts</label><input id="sp-start" class="input" type="date" name="start" [(ngModel)]="f.start_date" /></div>
            <div class="field"><label for="sp-end">Ends (optional)</label><input id="sp-end" class="input" type="date" name="end" [(ngModel)]="f.end_date" /></div>
          </div>
          <div class="field"><label for="sp-notes">Notes</label><input id="sp-notes" class="input" name="notes" [(ngModel)]="f.notes" /></div>
          @if (error()) { <div class="notice bad">{{ error() }}</div> }
          <div class="form-actions"><button type="button" class="btn" (click)="editing.set(null)">Cancel</button><button class="btn primary" type="submit" [disabled]="saving()">Save plan</button></div>
        </form>
      </app-modal>
    }`,
  styles: [`:host { display: flex; flex-direction: column; gap: 14px; } tr.off td { opacity: .6; }`],
})
export class SipPlansComponent {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  store = inject(StoreService);
  auth = inject(AuthService);
  plans = signal<SipPlan[]>([]);
  total = signal(0);
  editing = signal<Partial<SipPlan> | null>(null);
  saving = signal(false);
  error = signal<string | null>(null);
  f: any = {};
  segments = SEGMENTS;
  freq = FREQ;
  active = computed(() => this.plans().filter(p => p.active));
  holdings = computed(() => this.store.openPositions().filter(p => ['equity', 'mutual_fund', 'commodity', 'nps', 'epf'].includes(p.asset_class))
    .sort((a, b) => a.name.localeCompare(b.name)));
  holdingName = () => this.holdings().find(p => p.id === this.f.instrument_id)?.name ?? '';

  constructor() {
    effect(() => { this.store.version(); queueMicrotask(() => this.load()); });
  }
  async load() {
    try { const r = await firstValueFrom(this.api.sips()); this.plans.set(r.plans); this.total.set(r.monthly_total); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
  startAdd() {
    this.f = { instrument_id: null, name: '', segment: null, amount: null, frequency: 'monthly', day_of_month: 5, step_up_pct: null, start_date: today(), end_date: null, notes: '' };
    this.error.set(null);
    this.editing.set({});
  }
  startEdit(s: SipPlan) {
    this.f = { ...s, end_date: s.end_date || null, step_up_pct: s.step_up_pct || null };
    this.error.set(null);
    this.editing.set(s);
  }
  async save() {
    this.saving.set(true);
    try {
      const body = { ...this.f, name: this.f.name || this.holdingName(), active: this.f.active ?? 1 };
      if (body.instrument_id) delete body.segment;
      await firstValueFrom(this.f.id ? this.api.updateSip(this.f.id, body) : this.api.addSip(body));
      this.toast.ok(this.f.id ? 'Plan updated' : 'Plan added');
      this.editing.set(null);
      await this.store.changed();
    } catch (e) { this.error.set(errorMessage(e)); }
    finally { this.saving.set(false); }
  }
  async toggle(s: SipPlan) {
    try { await firstValueFrom(this.api.updateSip(s.id, { active: !s.active })); await this.store.changed(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
  async remove(s: SipPlan) {
    if (!(await this.confirm.ask('Delete SIP plan?', `${s.name} (${s.amount.toLocaleString('en-IN')} ${s.frequency}) will be removed. Recorded transactions are not affected.`, 'Delete'))) return;
    try { await firstValueFrom(this.api.deleteSip(s.id)); this.toast.ok('Plan deleted'); await this.store.changed(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
}
