import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, relTime } from '../../core/format';
import { errorMessage } from '../../core/http';
import { AllowlistUser, CLASS_LABEL, Position, Role, SEGMENTS, SEGMENT_COLOR } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { InstrumentEditComponent } from '../../shared/instrument-edit.component';
import { ConfirmService } from '../../shared/ui';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, IconComponent, InstrumentEditComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.component.html',
})
export class SettingsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  segments = SEGMENTS;
  colorOf = (s: string) => SEGMENT_COLOR[s];
  classLabel = CLASS_LABEL;
  targets: Record<string, number> = {};
  slab = 30;
  autoFlows = true;
  saving = signal(false);
  editing = signal<Position | null>(null);
  priceFilter = signal<'missing' | 'all'>('missing');
  users = signal<AllowlistUser[]>([]);
  newEmail = '';
  newRole: Role = 'user';
  rel = relTime;

  targetSum = () => Object.values(this.targets).reduce((a, v) => a + (+v || 0), 0);
  current = computed(() => Object.fromEntries((this.store.portfolio()?.segments ?? []).map(s => [s.segment, s.pct])));
  tradables = computed(() => this.store.positions().filter(p => ['equity', 'mutual_fund', 'commodity'].includes(p.asset_class))
    .filter(p => this.priceFilter() === 'all' || (p.is_open && !p.has_price))
    .sort((a, b) => Number(b.is_open) - Number(a.is_open) || a.name.localeCompare(b.name)));

  constructor() {
    effect(() => {
      const s = this.store.settings();
      this.targets = Object.fromEntries(SEGMENTS.map(seg => [seg, s.targetAllocation?.[seg] ?? 0]));
      this.slab = +(s.taxSlabRate ?? 30);
      this.autoFlows = String(s.autoCapitalFlows ?? 'true') !== 'false';
    });
    if (this.auth.isAdmin()) this.loadUsers();
  }

  private async put(key: string, value: unknown, msg: string) {
    this.saving.set(true);
    try { await this.store.saveSetting(key, value); this.toast.ok(msg); }
    catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.saving.set(false); }
  }
  saveTargets() {
    const t = Object.fromEntries(Object.entries(this.targets).filter(([, v]) => +v > 0).map(([k, v]) => [k, +v]));
    return this.put('targetAllocation', t, 'Target allocation saved');
  }
  matchCurrent() {
    for (const s of SEGMENTS) this.targets[s] = Math.round(this.current()[s] ?? 0);
    const diff = 100 - this.targetSum();
    const biggest = SEGMENTS.reduce((a, b) => (this.targets[a] >= this.targets[b] ? a : b));
    this.targets[biggest] += diff;
  }
  saveSlab() { return this.put('taxSlabRate', this.slab, 'Tax slab saved'); }
  saveAuto() { return this.put('autoCapitalFlows', this.autoFlows ? 'true' : 'false', 'Saved'); }

  async loadUsers() {
    try { this.users.set((await firstValueFrom(this.api.users())).users); } catch (e) { this.toast.error(errorMessage(e)); }
  }
  async addUser() {
    try {
      await firstValueFrom(this.api.addUser(this.newEmail.trim(), this.newRole));
      this.toast.ok(`${this.newEmail} added`);
      this.newEmail = '';
      await this.loadUsers();
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
  async setRole(u: AllowlistUser, role: string) {
    try { await firstValueFrom(this.api.setRole(u.email, role)); this.toast.ok(`${u.email} is now ${role}`); await this.loadUsers(); }
    catch (e) { this.toast.error(errorMessage(e)); await this.loadUsers(); }
  }
  async removeUser(u: AllowlistUser) {
    if (!(await this.confirm.ask(`Remove ${u.email}?`, 'They will be signed out on their next request. Their data stays in the database.', 'Remove'))) return;
    try { await firstValueFrom(this.api.removeUser(u.email)); this.toast.ok('Removed'); await this.loadUsers(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
  viewAs(u: AllowlistUser) {
    this.auth.startViewAs({ email: u.email, name: u.name, picture: u.picture, role: u.role });
    this.toast.info(`Now viewing ${u.name || u.email}'s portfolio`);
  }
}
