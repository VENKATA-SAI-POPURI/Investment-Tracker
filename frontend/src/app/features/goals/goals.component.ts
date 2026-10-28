import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { KeyValuePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, inr, inrCompact } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Goal, SEGMENTS } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { LineChartComponent, LineSeries } from '../../shared/charts/line-chart.component';
import { IconComponent } from '../../shared/icon.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';

const STATUS = {
  achieved: { label: 'Achieved', cls: 'good', icon: 'checkCircle' },
  on_track: { label: 'On track', cls: 'good', icon: 'checkCircle' },
  at_risk: { label: 'At risk', cls: 'warn', icon: 'alert' },
  off_track: { label: 'Off track', cls: 'bad', icon: 'alert' },
};

@Component({
  selector: 'app-goals',
  standalone: true,
  imports: [FormsModule, KeyValuePipe, IconComponent, ModalComponent, LineChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './goals.component.html',
  styles: [`.goal h2 { font-size: 17px; } .alloc-row { display: grid; grid-template-columns: 1fr 110px; gap: 10px; align-items: center; }
    .start { padding: 32px; text-align: center; }
    .start h3 { font-size: 18px; margin-top: 12px; }
    .start p { color: var(--muted); max-width: 520px; margin: 6px auto 0; }
    .lotus { display: inline-flex; width: 52px; height: 52px; border-radius: 14px; align-items: center; justify-content: center; color: #fff;
      background: linear-gradient(145deg, #e3b350, #b7862c); }
    .presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-top: 26px; text-align: left; }
    .preset { display: flex; flex-direction: column; align-items: flex-start; text-align: left; gap: 4px; padding: 16px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2);
      cursor: pointer; transition: border-color .15s, box-shadow .15s, background .15s; }
    .preset:hover { border-color: var(--border-strong); background: var(--surface); box-shadow: var(--shadow-md); }
    .preset:disabled { cursor: default; }
    .preset b { font-size: 14px; margin-top: 8px; }
    .preset .amt { font-size: 13px; color: var(--text-2); }
    .preset small { font-size: 12px; color: var(--muted); }`],
})
export class GoalsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  goals = signal<Goal[]>([]);
  loading = signal(true);
  editing = signal<Partial<Goal> | null>(null);
  error = signal<string | null>(null);
  f: any = {};
  segments = SEGMENTS;
  status = STATUS;
  inrc = (v: number) => inrCompact(v);
  inrFull = (v: number) => inr(v);

  segValue = computed(() => Object.fromEntries((this.store.portfolio()?.segments ?? []).map(s => [s.segment, s.value])));
  earmarked = computed(() => {
    const used: Record<string, number> = {};
    for (const g of this.goals()) for (const [s, p] of Object.entries(g.allocation)) used[s] = (used[s] ?? 0) + p;
    return used;
  });

  constructor() {
    effect(() => { this.store.version(); queueMicrotask(() => this.load()); });
  }
  async load() {
    try { this.goals.set(await firstValueFrom(this.api.goals())); }
    catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.loading.set(false); }
  }

  series(g: Goal): LineSeries[] {
    const path = g.projection.path;
    return [
      { key: 'p', label: 'Projected value', color: 'var(--s1)', values: path.map(x => x.projected), area: true },
      { key: 'c', label: 'Money put in', color: 'var(--muted)', values: path.map(x => x.contributed), muted: true },
      { key: 't', label: 'Target', color: 'var(--s2)', values: path.map(() => g.target_amount) },
    ];
  }
  labels(g: Goal) { return g.projection.path.map(x => x.date); }

  /** Common Indian goals, so the first one takes a click instead of a blank form. */
  presets = [
    { name: 'Emergency fund', icon: 'shield', amount: 300000, years: 1, note: '6 months of expenses' },
    { name: "Child's education", icon: 'sparkle', amount: 2500000, years: 15, note: "College, at today's fees" },
    { name: 'Home down payment', icon: 'home', amount: 2000000, years: 7, note: '20% of a ₹1 crore home' },
    { name: 'Retirement', icon: 'lotus', amount: 20000000, years: 25, note: 'A ₹2 crore corpus' },
  ];

  startAdd(preset?: { name: string; amount: number; years: number }) {
    const year = new Date().getFullYear();
    this.f = { name: preset?.name ?? '', target_amount: preset?.amount ?? null, target_date: `${year + (preset?.years ?? 10)}-03-31`,
      monthly_contribution: 0, expected_return: null, notes: '',
      allocation: Object.fromEntries(SEGMENTS.map(s => [s, 0])) };
    this.error.set(null);
    this.editing.set({});
  }
  startEdit(g: Goal) {
    this.f = { ...g, allocation: Object.fromEntries(SEGMENTS.map(s => [s, g.allocation[s] ?? 0])) };
    this.error.set(null);
    this.editing.set(g);
  }
  linkedValue() {
    return Object.entries(this.f.allocation ?? {}).reduce((a, [s, p]) => a + (this.segValue()[s] ?? 0) * (+(p as number) || 0) / 100, 0);
  }
  async save() {
    try {
      const body = { ...this.f, projection: undefined };
      const e = this.editing()!;
      const res = e.id ? await firstValueFrom(this.api.updateGoal(e.id, body)) : await firstValueFrom(this.api.addGoal(body));
      this.goals.set(res);
      this.toast.ok('Goal saved');
      this.editing.set(null);
    } catch (err) { this.error.set(errorMessage(err)); }
  }
  async remove(g: Goal) {
    if (!(await this.confirm.ask(`Delete goal "${g.name}"?`, 'Your investments are not affected.', 'Delete'))) return;
    try { await firstValueFrom(this.api.deleteGoal(g.id)); this.goals.update(l => l.filter(x => x.id !== g.id)); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
}
