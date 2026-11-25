import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { money } from '../../core/format';
import { errorMessage } from '../../core/http';
import { GoalRow } from '../../core/models';
import { OverviewService } from '../../core/overview.service';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';

const ON = ['on_track', 'achieved'];

/** Analysis › "Am I on track for my goals?": one card per goal (and the retirement plan), on track or short by ₹ a
 *  month, with one button that raises the monthly amount to what the goal needs. Rows come from GET /answers. */
@Component({
  selector: 'v-goals',
  standalone: true,
  imports: [FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="v-grid cols-2">
    @for (g of rows(); track g.id) {
      <section class="v-card goal" [class.short]="!isOn(g)">
        <div class="top">
          <span class="v-tone" [class.good]="isOn(g)" [class.warn]="!isOn(g)"><app-icon [name]="g.kind === 'retirement' ? 'piggy' : isOn(g) ? 'flag' : 'house'" [size]="20" /></span>
          <div class="grow"><div class="nm">{{ g.name }}</div><div class="v-mut sm">{{ money(g.target) }} by {{ when(g.date) }}</div></div>
          <span class="v-pill" [class.ok]="isOn(g)" [class.warn]="g.status === 'at_risk'" [class.no]="g.status === 'off_track'">{{ label(g) }}</span>
          @if (auth.canWrite() && g.kind === 'goal') { <button class="ib" (click)="edit(g)" [attr.aria-label]="'Edit ' + g.name"><app-icon name="edit" [size]="15" /></button> }
        </div>
        @if (g.kind === 'goal' && !g.current) {
          <div class="v-mut sm zero">Counts none of what you have today. <button class="v-link" (click)="edit(g)">Set its share</button></div>
        }
        <div class="track" [attr.aria-label]="'Expected ' + money(g.projected) + ' of ' + money(g.target)">
          <i class="exp" [style.width.%]="pct(g.projected, g.target)" [class.ok]="isOn(g)"></i>
          <i class="now" [style.width.%]="pct(g.current, g.target)"></i>
        </div>
        <div class="legend"><span>Have {{ money(g.current) }} · expect {{ money(g.projected) }}</span>
          <span>{{ isOn(g) ? (g.projected > g.target ? '+' + money(g.projected - g.target) + ' spare' : 'on target') : 'need ' + money(g.target) }}</span></div>
        @if (!isOn(g) && g.extra > 0) {
          <div class="v-note warn"><app-icon name="triangleAlert" [size]="18" />
            <span>Put in <b>{{ money(g.monthly_needed) }} a month</b> ({{ money(g.extra) }} more than now) to reach it in 3 of 4 futures.</span></div>
          @if (auth.canWrite()) {
            <button class="v-btn primary wide" [disabled]="busy() === g.id" (click)="fix(g)">{{ busy() === g.id ? 'Saving…' : 'Fix it: ' + money(g.monthly_needed) + ' a month' }}</button>
          }
        } @else if (g.monthly_now) {
          <div class="v-mut sm">Putting in {{ money(g.monthly_now) }} a month.</div>
        }
      </section>
    }
    @if (auth.canWrite()) {
      <section class="v-card add">
        @if (!adding()) {
          <button class="v-btn wide" (click)="startAdd()"><app-icon name="plus" [size]="16" /> Add a goal</button>
        } @else {
          <h3>{{ editId() ? 'Edit goal' : 'New goal' }}</h3>
          <label>Name <input class="v-input" [(ngModel)]="draft.name" placeholder="e.g. House down payment" /></label>
          <div class="two"><label>Amount (₹) <input class="v-input" type="number" min="1" [(ngModel)]="draft.target_amount" /></label>
            <label>By <input class="v-input" type="date" [(ngModel)]="draft.target_date" /></label></div>
          <div class="two"><label>You'll put in a month (₹) <input class="v-input" type="number" min="0" [(ngModel)]="draft.monthly_contribution" /></label>
            <label>Share of today's money (%) <input class="v-input" type="number" min="0" max="100" [(ngModel)]="draft.share" [placeholder]="draft.custom ? 'custom' : '0'" /></label></div>
          <p class="v-mut sm hint">The share of what you own now that is set aside for this goal (the same share of each kind of holding).</p>
          <div class="row"><button class="v-btn primary" [disabled]="!valid() || busy() === 'new'" (click)="save()">Save goal</button>
            <button class="v-btn" (click)="adding.set(false)">Cancel</button>
            @if (editId(); as id) { <button class="v-btn danger" (click)="remove(id)">Delete</button> }</div>
        }
      </section>
    }
    </div>
    <p class="v-mut foot">Each goal is projected from the money it can count on today, what you put in each month and the expected return of
      your mix; "3 of 4 futures" comes from simulating 1,000 possible markets.</p>
  `,
  styles: [`
    .goal .top { display: flex; gap: 12px; align-items: center; }
    .goal .grow { flex: 1; min-width: 0; }
    .nm { font-weight: 750; font-size: 16px; color: var(--text); }
    .sm { font-size: var(--fs-small); }
    .track { position: relative; height: 10px; border-radius: 6px; background: var(--surface-3); margin: 16px 0 8px; overflow: hidden; }
    .track i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px; max-width: 100%; }
    .track .exp { background: repeating-linear-gradient(90deg, rgba(96,165,250,.5) 0 6px, transparent 6px 10px); }
    .track .exp.ok { background: var(--pos); opacity: .35; }
    .track .now { background: var(--accent); }
    .goal:not(.short) .track .now { background: var(--pos); }
    .legend { display: flex; justify-content: space-between; gap: 10px; font-size: var(--fs-small); color: var(--muted); margin-bottom: 10px; }
    .v-note { margin-bottom: 12px; }
    .wide { width: 100%; }
    .ib { width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); display: grid; place-items: center; cursor: pointer; flex: none; }
    .ib:hover { color: var(--text); border-color: var(--border-strong); }
    .zero { margin-top: 10px; } .zero .v-link { font-size: inherit; }
    .hint { margin: -4px 0 12px; font-size: 12px; }
    .v-btn.danger { margin-left: auto; color: var(--neg); }
    .add h3 { margin: 0 0 10px; font-size: 16px; }
    .add label { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-small); font-weight: 600; color: var(--text-2); margin-bottom: 10px; }
    .add .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .add .row { display: flex; gap: 8px; }
    .foot { font-size: 12px; margin: 12px 4px 0; }
  `],
})
export class GoalsViewComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(ToastService);
  private ovs = inject(OverviewService);
  auth = inject(AuthService);
  money = money;

  rows = computed<GoalRow[]>(() => this.ovs.answers()?.goals ?? []);
  busy = signal<number | 'retirement' | 'new' | null>(null);
  adding = signal(false);
  editId = signal<number | null>(null);
  draft = this.blank();
  private blank() {
    return { name: '', target_amount: null as number | null, target_date: '', monthly_contribution: null as number | null,
      share: null as number | null, custom: false };
  }

  isOn = (g: GoalRow) => ON.includes(g.status ?? '');
  pct = (v: number, of: number) => Math.max(0, Math.min(100, of ? (v / of) * 100 : 0));
  when = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  label = (g: GoalRow) => ({ on_track: 'On track', achieved: 'Reached', at_risk: 'Short', off_track: 'Far off' } as Record<string, string>)[g.status ?? ''] ?? '—';
  valid = () => !!this.draft.name.trim() && (this.draft.target_amount ?? 0) > 0 && !!this.draft.target_date;

  async fix(g: GoalRow) {
    if (!g.monthly_needed) return;
    this.busy.set(g.id);
    try {
      if (g.kind === 'retirement') {
        const plan = { ...((this.store.settings().retirementPlan as Record<string, unknown>) ?? {}), monthly_sip: Math.ceil(g.monthly_needed / 100) * 100 };
        await this.store.saveSetting('retirementPlan', plan);
      } else {
        await firstValueFrom(this.api.updateGoal(g.id as number, { monthly_contribution: Math.ceil(g.monthly_needed / 100) * 100 }));
        await this.store.changed();
      }
      this.toast.ok(`${g.name}: ${money(g.monthly_needed)} a month saved`);
    } catch (e) { this.toast.error(errorMessage(e)); } finally { this.busy.set(null); }
  }

  startAdd() { this.editId.set(null); this.draft = this.blank(); this.adding.set(true); }

  edit(g: GoalRow) {
    const vals = Object.values(g.allocation ?? {});
    const uniform = vals.length > 0 && vals.every(v => v === vals[0]);
    this.draft = { name: g.name, target_amount: g.target, target_date: g.date.slice(0, 10), monthly_contribution: g.monthly_now || null,
      share: uniform ? vals[0] : vals.length ? null : 0, custom: vals.length > 0 && !uniform };
    this.editId.set(g.id as number);
    this.adding.set(true);
    queueMicrotask(() => document.querySelector('v-goals .add')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }

  async save() {
    this.busy.set('new');
    const d = this.draft;
    const body: Record<string, unknown> = { name: d.name.trim(), target_amount: d.target_amount, target_date: d.target_date,
      monthly_contribution: d.monthly_contribution ?? 0 };
    if (d.share !== null && !(d.custom && d.share === null)) {
      const segs = (this.store.portfolio()?.segments ?? []).map(x => x.segment);
      body['allocation'] = d.share > 0 ? Object.fromEntries(segs.map(k => [k, Math.min(+d.share!, 100)])) : {};
    }
    try {
      const id = this.editId();
      await firstValueFrom(id ? this.api.updateGoal(id, body) : this.api.addGoal(body));
      await this.store.changed();
      this.adding.set(false);
      this.editId.set(null);
      this.toast.ok(id ? 'Goal saved' : 'Goal added');
    } catch (e) { this.toast.error(errorMessage(e)); } finally { this.busy.set(null); }
  }

  async remove(id: number) {
    if (!confirm('Delete this goal?')) return;
    try {
      await firstValueFrom(this.api.deleteGoal(id));
      await this.store.changed();
      this.adding.set(false);
      this.editId.set(null);
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
}
