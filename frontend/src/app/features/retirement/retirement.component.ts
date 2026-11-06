import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
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

/** EPF accounts and NPS schemes: retirement savings that sit outside capital-gains tax. */
@Component({
  selector: 'app-retirement',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, SectionTabsComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" [style.--acc]="kind() === 'epf' ? 'var(--s7)' : 'var(--s8)'">
      <div class="page-head">
        <h1>Holdings</h1>
        @if (auth.canWrite()) {
          <div class="row wrap">
            @if (kind() === 'nps') { <a class="btn ghost sm" routerLink="/import"><app-icon name="upload" [size]="15" /> Import NSDL CAS</a> }
            @if (kind() === 'epf') { <button class="btn sm" (click)="add('CREDIT')">Interest credited</button> }
            <button class="btn sm" (click)="add('BUY')"><app-icon name="plus" [size]="15" /> Contribution</button>
          </div>
        }
      </div>
      <app-section-tabs group="holdings" [current]="'/' + kind()" style="margin-top:-12px" />

      @if (rows().length) {
        <section class="kpis">
          @if (kind() === 'epf') {
            <div class="kpi"><span class="chip violet sm"><app-icon name="shield" [size]="15" /></span><span class="label">EPF balance</span><span class="value">{{ t().value | inr }}</span><span class="meta">incl. interest accrued this year</span></div>
            <div class="kpi"><span class="chip blue sm"><app-icon name="wallet" [size]="15" /></span><span class="label">Contributed</span><span class="value">{{ t().invested | inr }}</span><span class="meta">{{ t().proceeds ? (t().proceeds | inr) + ' withdrawn' : 'employee + employer' }}</span></div>
            <div class="kpi"><span class="chip green sm"><app-icon name="trend" [size]="15" /></span><span class="label">Interest earned</span><span class="value pos">{{ t().credited + t().accrued | inr }}</span><span class="meta">{{ t().credited | inr }} credited · {{ t().accrued | inr }} accruing</span></div>
            <div class="kpi"><span class="chip amber sm"><app-icon name="chart" [size]="15" /></span><span class="label">Return (XIRR)</span><span class="value pos">{{ t().xirr | pct }}</span><span class="meta">tax-free · {{ t().rate }}% declared rate</span></div>
          } @else {
            <div class="kpi"><span class="chip violet sm"><app-icon name="lotus" [size]="15" /></span><span class="label">NPS value</span><span class="value">{{ t().value | inr }}</span><span class="meta">{{ rows().length }} scheme{{ rows().length === 1 ? '' : 's' }}</span></div>
            <div class="kpi"><span class="chip blue sm"><app-icon name="wallet" [size]="15" /></span><span class="label">Contributed</span><span class="value">{{ t().cost | inr }}</span><span class="meta">cost of units held</span></div>
            <div class="kpi"><span class="chip green sm"><app-icon name="trend" [size]="15" /></span><span class="label">Gain</span><span class="value" [class]="t().gain | sign">{{ t().gain | inr: 0 : true }}</span><span class="meta">{{ t().gainPct | pct }} on contributions</span></div>
            <div class="kpi"><span class="chip amber sm"><app-icon name="chart" [size]="15" /></span><span class="label">Return (XIRR)</span><span class="value" [class]="t().xirr | sign">{{ t().xirr | pct }}</span><span class="meta">NAVs as of {{ t().navDate ? (t().navDate | dt) : '—' }}</span></div>
          }
        </section>

        <section class="card flush">
          <div class="card-head"><h2>{{ kind() === 'epf' ? 'EPF accounts' : 'NPS schemes' }}</h2>
            <span class="hint">{{ kind() === 'epf' ? 'Interest is credited by EPFO once a year; until then it is estimated at the declared rate' : 'Enter the latest NAV from your statement, or import an NSDL CAS' }}</span></div>
          <div class="table-wrap">
            <table class="table">
              @if (kind() === 'epf') {
                <thead><tr><th>Account</th><th class="num">Contributed</th><th class="num hide-sm">Withdrawn</th><th class="num">Interest credited</th>
                  <th class="num hide-sm">Accruing</th><th class="num">Balance</th><th class="num hide-sm">Rate</th><th class="num">XIRR</th></tr></thead>
                <tbody>
                  @for (p of rows(); track p.id) {
                    <tr class="clickable" (click)="open(p)">
                      <td class="name-cell"><div style="font-weight:500">{{ p.name }}</div><div class="sub">since {{ p.first_date | dt }}</div></td>
                      <td class="num">{{ p.invested | inr }}</td><td class="num hide-sm">{{ p.proceeds ? (p.proceeds | inr) : '—' }}</td>
                      <td class="num pos">{{ p.interest_credited | inr }}</td><td class="num hide-sm">{{ p.accrued_interest | inr }}</td>
                      <td class="num"><b>{{ p.value | inr }}</b></td><td class="num hide-sm">{{ p.rate }}%</td><td class="num pos">{{ p.xirr | pct }}</td>
                    </tr>
                  }
                </tbody>
              } @else {
                <thead><tr><th>Scheme</th><th class="num">Units</th><th class="num hide-sm">Avg cost</th><th class="num">NAV</th>
                  <th class="num">Invested</th><th class="num">Value</th><th class="num">Gain</th><th class="num hide-sm">XIRR</th></tr></thead>
                <tbody>
                  @for (p of rows(); track p.id) {
                    <tr>
                      <td class="name-cell clickable-text" (click)="open(p)"><div style="font-weight:500">{{ p.name }}</div><div class="sub">{{ p.category || 'Tier I' }}{{ p.platform ? ' · ' + p.platform : '' }}</div></td>
                      <td class="num">{{ p.quantity | qty }}</td><td class="num hide-sm">{{ p.avg_cost | inr: 4 }}</td>
                      <td class="num">
                        @if (editing() === p.id) {
                          <span class="nav-edit"><input class="input num" type="number" step="0.0001" min="0" [(ngModel)]="nav" (keydown.enter)="saveNav(p)" aria-label="New NAV" />
                            <button class="btn sm primary" (click)="saveNav(p)">Save</button></span>
                        } @else {
                          {{ p.price ? (p.price | inr: 4) : '—' }}
                          @if (auth.canWrite()) { <button class="btn ghost sm link" (click)="startNav(p)">{{ p.price ? 'Update' : 'Set NAV' }}</button> }
                          <div class="sub">{{ p.price_at ? (p.price_at | dt) : 'valued at cost' }}</div>
                        }
                      </td>
                      <td class="num">{{ p.cost | inr }}</td><td class="num"><b>{{ p.value | inr }}</b></td>
                      <td class="num" [class]="p.unrealized | sign">{{ p.unrealized | inr: 0 : true }}<div class="sub"><span class="chg" [class]="p.unrealized_pct | sign">{{ p.unrealized_pct | pct }}</span></div></td>
                      <td class="num hide-sm" [class]="p.xirr | sign">{{ p.xirr | pct }}</td>
                    </tr>
                  }
                </tbody>
              }
            </table>
          </div>
        </section>
      } @else {
        <section class="card start">
          <span class="badge-ic"><app-icon [name]="kind() === 'epf' ? 'shield' : 'lotus'" [size]="24" /></span>
          <h3>{{ kind() === 'epf' ? 'Track your Provident Fund' : 'Track your National Pension System account' }}</h3>
          <p>{{ kind() === 'epf'
            ? 'Add your monthly contributions (employee + employer, from your EPFO passbook) and the interest EPFO credits each year. Interest for the current year is estimated at the declared rate.'
            : 'Add each contribution with the units allotted, then keep the NAV current, or import an NSDL CAS to bring in your schemes, units and NAVs in one go.' }}</p>
          @if (auth.canWrite()) {
            <div class="row" style="justify-content:center;margin-top:16px">
              <button class="btn primary" (click)="add('BUY')"><app-icon name="plus" [size]="15" /> Add first contribution</button>
              @if (kind() === 'nps') { <a class="btn" routerLink="/import"><app-icon name="upload" [size]="15" /> Import NSDL CAS</a> }
            </div>
          }
        </section>
      }
    </div>`,
  styles: [`
    .start { padding: 36px 28px; text-align: center; }
    .start h3 { font-size: 17px; margin-top: 12px; }
    .start p { color: var(--muted); max-width: 560px; margin: 8px auto 0; font-size: 13.5px; }
    .badge-ic { display: inline-flex; width: 52px; height: 52px; border-radius: 14px; align-items: center; justify-content: center; color: #fff; background: var(--acc); }
    .nav-edit { display: inline-flex; gap: 6px; align-items: center; }
    .nav-edit .input { width: 110px; height: 30px; }
    .link { height: 22px; padding: 0 6px; color: var(--primary); font-size: 12px; }
    .clickable-text { cursor: pointer; }
    .clickable-text:hover div:first-child { color: var(--primary); }
  `],
})
export class RetirementComponent {
  kind = input.required<'epf' | 'nps'>();
  store = inject(StoreService);
  auth = inject(AuthService);
  private dialog = inject(TxnDialogService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private router = inject(Router);

  editing = signal<number | null>(null);
  nav: number | null = null;

  rows = computed(() => this.store.positions().filter(p => p.asset_class === this.kind() && (p.is_open || p.txn_count > 0))
    .sort((a, b) => b.value - a.value));
  t = computed(() => {
    const r = this.rows();
    const sum = (f: (p: Position) => number | null | undefined) => r.reduce((a, p) => a + (f(p) ?? 0), 0);
    const seg = this.store.portfolio()?.segments.find(s => s.segment === (this.kind() === 'epf' ? 'EPF' : 'NPS'));
    const cost = sum(p => p.cost), value = sum(p => p.value), gain = value - cost;
    const dates = r.map(p => p.price_at).filter(Boolean).sort() as string[];
    return { value, cost, invested: sum(p => p.invested), proceeds: sum(p => p.proceeds), credited: sum(p => p.interest_credited),
      accrued: sum(p => p.accrued_interest), gain, gainPct: cost ? gain / cost * 100 : null, xirr: seg?.xirr ?? null,
      rate: r[0]?.rate ?? 8.25, navDate: dates.length ? dates[0] : null };
  });

  add(type: string) {
    const only = this.rows().length === 1 ? this.rows()[0].id : undefined;
    this.dialog.add(this.kind(), { type, instrumentId: only });
  }
  open(p: Position) { this.router.navigate(['/holding', p.id]); }
  startNav(p: Position) { this.nav = p.price ?? null; this.editing.set(p.id); }
  async saveNav(p: Position) {
    if (!this.nav || this.nav <= 0) { this.editing.set(null); return; }
    try {
      await firstValueFrom(this.api.updateInstrument(p.id, { last_price: this.nav }));
      this.toast.ok(`NAV for ${p.name} updated`);
      this.editing.set(null);
      await this.store.changed();
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
}
