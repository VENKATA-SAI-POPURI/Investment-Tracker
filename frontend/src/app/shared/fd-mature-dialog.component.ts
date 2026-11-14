import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ActionService } from '../core/action.service';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { FORMAT_PIPES, today } from '../core/format';
import { errorMessage } from '../core/http';
import { StoreService } from '../core/store.service';
import { ToastService } from '../core/toast.service';
import { IconComponent } from './icon.component';
import { ModalComponent } from './ui';

/**
 * Global "Mark matured" dialog for a fixed deposit (A19), hosted by the shell.
 * Posts the existing `/fixed-deposits/<id>/mature`; when it was opened from an action, marks that action done.
 */
@Component({
  selector: 'app-fd-mature-dialog',
  standalone: true,
  imports: [FormsModule, ModalComponent, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal [title]="fd() ? 'Close FD at ' + fd()!.name : 'Mark FD matured'" [width]="440" (close)="closed.emit()">
      @if (fd(); as p) {
        @if (!p.is_open) {
          <p class="notice"><app-icon name="checkCircle" [size]="16" /> This FD is already closed.</p>
          <div class="form-actions" style="margin-top:14px"><button type="button" class="btn" (click)="closed.emit()">Close</button></div>
        } @else if (!auth.canWrite()) {
          <p class="notice"><app-icon name="eye" [size]="16" /> You can view this portfolio but not change it.</p>
          <div class="form-actions" style="margin-top:14px"><button type="button" class="btn" (click)="closed.emit()">Close</button></div>
        } @else {
          <form class="form" (ngSubmit)="save()">
            <p class="small muted">Deposit {{ p.invested | inr }} · {{ p.rate !== null ? p.rate + '% · ' : '' }}matures {{ p.maturity_date | dt }}</p>
            <div class="cols">
              <div class="field"><label for="fdm-date">Date received</label>
                <input id="fdm-date" class="input" type="date" name="date" [max]="todayIso" [(ngModel)]="date" /></div>
              <div class="field"><label for="fdm-amt">Amount received (₹)</label>
                <input id="fdm-amt" class="input num" type="number" step="0.01" min="0" name="amount" [(ngModel)]="amount" /></div>
            </div>
            <p class="small muted">Interest = amount received − deposit. It is reported as income on the Tax page.</p>
            @if (error()) { <div class="notice bad"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }
            <div class="form-actions">
              <button type="button" class="btn" (click)="closed.emit()">Cancel</button>
              <button type="submit" class="btn primary" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Mark matured' }}</button>
            </div>
          </form>
        }
      } @else {
        <p class="notice"><app-icon name="info" [size]="16" /> This fixed deposit isn't in the portfolio you're viewing.</p>
        <div class="form-actions" style="margin-top:14px"><button type="button" class="btn" (click)="closed.emit()">Close</button></div>
      }
    </app-modal>`,
})
export class FdMatureDialogComponent implements OnInit {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);
  private actions = inject(ActionService);
  auth = inject(AuthService);

  instrumentId = input.required<number>();
  /** The action this fulfils (`fd:matured-unrecorded:<iid>`); it is marked done after the save. */
  actionId = input<string | undefined>(undefined);
  closed = output<void>();

  readonly todayIso = today();
  fd = computed(() => this.store.positions().find(p => p.id === this.instrumentId() && p.asset_class === 'fixed_deposit') ?? null);
  saving = signal(false);
  error = signal<string | null>(null);
  date = '';
  amount: number | null = null;

  ngOnInit() {
    const p = this.fd();
    const due = p?.maturity_date ?? null;
    this.date = due && due <= this.todayIso ? due : this.todayIso;
    // after maturity the engine stops projecting maturity_value; the value then holds principal + accrued (A28)
    this.amount = p ? (p.maturity_value ?? p.value) : null;
  }

  async save() {
    this.error.set(null);
    if (!this.date) { this.error.set('Pick the date the money arrived'); return; }
    if (!(Number(this.amount) > 0)) { this.error.set('Enter the amount received'); return; }
    this.saving.set(true);
    try {
      const r = await firstValueFrom(this.api.matureFd(this.instrumentId(), { date: this.date, amount: Number(this.amount) }));
      this.toast.ok('FD closed');
      const id = this.actionId();
      if (id) {
        const ids = this.txnIds(r);
        void this.actions.setStatus(id, ids.length ? { status: 'done', txn_ids: ids, evidence: { txn_ids: ids } } : { status: 'done' });
      }
      await this.store.changed();
      this.closed.emit();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  /** The endpoint answers `{message}` today; use its transaction ids if it ever returns them. */
  private txnIds(r: unknown): number[] {
    const o = (r ?? {}) as { txn_ids?: unknown; id?: unknown };
    if (Array.isArray(o.txn_ids)) return o.txn_ids.filter((x): x is number => typeof x === 'number');
    return [];
  }
}
