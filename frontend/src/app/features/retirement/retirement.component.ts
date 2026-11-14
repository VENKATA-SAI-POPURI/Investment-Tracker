import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fmtDate, inrCompact, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Action, Position, Status } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { PortfolioTabsComponent } from '../../shared/portfolio-tabs.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META } from '../../shared/priority/priority';
import { StatusBadgeComponent } from '../../shared/priority/status-badge.component';

/** A hand-priced NPS NAV older than this many calendar days is stale (G10/G15 `NPS_NAV_STALE_DAYS`). */
export const NPS_NAV_STALE_DAYS = 30;

/**
 * Whole calendar days from `priceAt` to `asOf`, read from the first 10 characters of each
 * (so a time or zone suffix never shifts the date). Null when either date is unreadable.
 */
export function navAgeDays(priceAt: string | null | undefined, asOf: string): number | null {
  const parse = (s: string | null | undefined) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? '').slice(0, 10));
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return Number.isNaN(t) ? null : t;
  };
  const a = parse(priceAt), b = parse(asOf);
  return a === null || b === null ? null : Math.round((b - a) / 86_400_000);
}

/**
 * Days old when a position trips the `nps:nav-stale` rule (G10, G15), else null: an open NPS position
 * with value > 0, no `symbol` (priced by hand) and a `price_at` more than 30 calendar days before `asOf`.
 * 31 days fires, 30 does not; a missing or unreadable `price_at` never fires. Mirrors `insights.py`.
 */
export function npsStaleDays(p: Position, asOf: string): number | null {
  if (p.asset_class !== 'nps' || !p.is_open || !(p.value > 0) || p.symbol) return null;
  const age = navAgeDays(p.price_at, asOf);
  return age !== null && age > NPS_NAV_STALE_DAYS ? age : null;
}

/**
 * EPF accounts and NPS schemes (`/epf`, `/nps`, Part 1 §5.7, H19): retirement savings outside capital-gains tax.
 * T0 is the class hero with a verdict and three tiles (the third behind "More" on phones); T1 is the
 * page's Needs-attention strip (NPS: stale hand-entered NAVs); T2/T3 are the account or scheme table,
 * with the inline NAV editor and the passbook / NSDL CAS imports.
 */
@Component({
  selector: 'app-retirement',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, PortfolioTabsComponent, NeedsAttentionComponent, StatusBadgeComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" [style.--acc]="kind() === 'epf' ? 'var(--s7)' : 'var(--s8)'">
      <app-portfolio-tabs />

      <!-- Page head: the h1 is the class name (A22, H19); imports and adds are T3 tools -->
      <div class="page-head">
        <div>
          <h1>{{ kind() === 'epf' ? 'EPF' : 'NPS' }}</h1>
          <p class="sub">{{ kind() === 'epf' ? 'Employees\\' Provident Fund' : 'National Pension System' }}@if (rows().length) { · {{ rows().length }} {{ kind() === 'epf' ? 'account' : 'scheme' }}{{ rows().length === 1 ? '' : 's' }} }</p>
        </div>
        @if (auth.canWrite()) {
          <div class="row wrap">
            @if (kind() === 'nps') { <a class="btn ghost sm" routerLink="/import"><app-icon name="upload" [size]="15" /> Import NSDL CAS</a> }
            @if (kind() === 'epf') { <a class="btn ghost sm" routerLink="/import" [queryParams]="{ source: 'epf' }"><app-icon name="upload" [size]="15" /> Import passbook</a>
              <button type="button" class="btn sm" (click)="add('CREDIT')">Interest credited</button> }
            <button type="button" class="btn sm" (click)="add('BUY')"><app-icon name="plus" [size]="15" /> Contribution</button>
          </div>
        }
      </div>

      @if (loading()) {
        <div class="skeleton hero-skel" role="status" [attr.aria-label]="kind() === 'epf' ? 'Loading your EPF accounts' : 'Loading your NPS schemes'"></div>
        <div class="card"><div class="skeleton" style="height:18px;width:40%"></div><div class="skeleton" style="height:180px;margin-top:14px"></div></div>
      } @else if (failed()) {
        <div class="card"><div class="empty">
          <app-icon name="alert" [size]="22" /><h3>Couldn't load your {{ kind() === 'epf' ? 'EPF accounts' : 'NPS schemes' }}</h3><p>{{ store.error() }}</p>
          <button type="button" class="btn" (click)="store.reload()"><app-icon name="refresh" [size]="15" /> Try again</button>
        </div></div>
      } @else {
        @if (store.error()) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't refresh, so these are the last numbers this device saw · {{ store.error() }}</span>
            <button type="button" class="btn ghost sm" (click)="store.reload()">Try again</button></div>
        }

        @if (rows().length) {
          <!-- T0: the class's answer -->
          <section class="kpis r-kpis" [attr.aria-label]="kind() === 'epf' ? 'EPF at a glance' : 'NPS at a glance'">
            @if (kind() === 'epf') {
              <div class="kpi hero">
                <span class="label">EPF balance</span>
                <span class="value">{{ t().value | inr }}</span>
                <span class="meta">incl. interest accruing this year</span>
                <div class="verdict-line" [attr.data-status]="verdict().status">
                  <app-icon [name]="statusMeta[verdict().status].icon" [size]="16" />
                  <span>{{ verdict().text }}</span><span class="sr-only">· {{ statusMeta[verdict().status].word }}</span>
                </div>
                <button type="button" class="more-stats" (click)="moreStats.set(!moreStats())" [attr.aria-expanded]="moreStats()">{{ moreStats() ? 'Less' : 'More' }}</button>
              </div>
              <div class="kpi"><span class="chip blue sm"><app-icon name="wallet" [size]="15" /></span><span class="label">Contributed</span><span class="value">{{ t().invested | inr }}</span><span class="meta">{{ t().proceeds ? (t().proceeds | inr) + ' withdrawn' : 'employee + employer' }}</span></div>
              <div class="kpi"><span class="chip green sm"><app-icon name="trend" [size]="15" /></span><span class="label">Interest</span><span class="value pos">{{ t().credited + t().accrued | inr }}</span><span class="meta">{{ t().credited | inr }} credited · {{ t().accrued | inr }} accruing</span></div>
              <div class="kpi extra" [class.show]="moreStats()"><span class="chip amber sm"><app-icon name="chart" [size]="15" /></span><span class="label">Return (XIRR)</span><span class="value" [class]="t().xirr | sign">{{ t().xirr | pct }}</span><span class="meta">tax-free · {{ t().rate }}% declared rate</span></div>
            } @else {
              <div class="kpi hero">
                <span class="label">NPS value</span>
                <span class="value">{{ t().value | inr }}</span>
                <span class="meta">{{ rows().length }} scheme{{ rows().length === 1 ? '' : 's' }}</span>
                <div class="verdict-line" [attr.data-status]="verdict().status">
                  <app-icon [name]="statusMeta[verdict().status].icon" [size]="16" />
                  <span>{{ verdict().text }}</span><span class="sr-only">· {{ statusMeta[verdict().status].word }}</span>
                </div>
                <button type="button" class="more-stats" (click)="moreStats.set(!moreStats())" [attr.aria-expanded]="moreStats()">{{ moreStats() ? 'Less' : 'More' }}</button>
              </div>
              <div class="kpi"><span class="chip blue sm"><app-icon name="wallet" [size]="15" /></span><span class="label">Contributed</span><span class="value">{{ t().cost | inr }}</span><span class="meta">cost of units held</span></div>
              <div class="kpi"><span class="chip green sm"><app-icon name="trend" [size]="15" /></span><span class="label">Gain</span><span class="value" [class]="t().gain | sign">{{ t().gain | inr: 0 : true }}</span><span class="meta">{{ t().gainPct | pct }} on contributions</span></div>
              <div class="kpi extra" [class.show]="moreStats()"><span class="chip amber sm"><app-icon name="chart" [size]="15" /></span><span class="label">Return (XIRR)</span><span class="value" [class]="t().xirr | sign">{{ t().xirr | pct }}</span><span class="meta">{{ t().navDate ? 'NAVs as of ' + (t().navDate | dt) : 'no NAV entered yet' }}</span></div>
            }
          </section>

          <!-- T1: needs attention here (H19). EPF rarely has any; NPS shows stale hand-entered NAVs (info → 'consider') -->
          @if (kind() === 'nps') {
            <app-needs-attention [prefixes]="['/nps']" [ids]="['nps:nav-stale:']" [tiers]="['now', 'month', 'consider']" [localRun]="navRun" />
          } @else {
            <app-needs-attention [prefixes]="['/epf']" />
          }

          <!-- T2/T3: accounts or schemes -->
          <section class="card flush">
            <div class="card-head"><h2>{{ kind() === 'epf' ? 'EPF accounts' : 'NPS schemes' }}</h2>
              <span class="hint">{{ kind() === 'epf' ? 'Interest is credited by EPFO once a year; until then it is estimated at the declared rate' : 'Enter the latest NAV from your statement, or import an NSDL CAS' }}</span></div>
            <div class="table-wrap">
              <table class="table r-table">
                @if (kind() === 'epf') {
                  <thead><tr><th>Account</th><th class="num">Contributed</th><th class="num hide-sm">Withdrawn</th><th class="num">Interest credited</th>
                    <th class="num hide-sm">Accruing</th><th class="num">Balance</th><th class="num hide-sm">Rate</th><th class="num hide-sm">XIRR</th></tr></thead>
                  <tbody>
                    @for (p of rows(); track p.id) {
                      <tr class="clickable" (click)="open(p)">
                        <td class="name-cell"><div style="font-weight:500">{{ p.name }}</div><div class="sub">since {{ p.first_date | dt }}</div></td>
                        <td class="num">{{ p.invested | inr }}</td><td class="num hide-sm">{{ p.proceeds ? (p.proceeds | inr) : '—' }}</td>
                        <td class="num pos">{{ p.interest_credited | inr }}</td><td class="num hide-sm">{{ p.accrued_interest | inr }}</td>
                        <td class="num"><b>{{ p.value | inr }}</b></td><td class="num hide-sm">{{ p.rate }}%</td><td class="num pos hide-sm">{{ p.xirr | pct }}</td>
                      </tr>
                    }
                  </tbody>
                } @else {
                  <thead><tr><th>Scheme</th><th class="num hide-sm">Units</th><th class="num hide-sm">Avg cost</th><th class="num">NAV</th>
                    <th class="num hide-sm">Invested</th><th class="num">Value</th><th class="num">Gain</th><th class="num hide-sm">XIRR</th></tr></thead>
                  <tbody>
                    @for (p of rows(); track p.id) {
                      <tr [class.stale]="staleDays().has(p.id)" [attr.id]="'nav-row-' + p.id">
                        <td class="name-cell clickable-text" (click)="open(p)"><div style="font-weight:500">{{ p.name }}</div><div class="sub">{{ p.category || 'Tier I' }}{{ p.platform ? ' · ' + p.platform : '' }}</div></td>
                        <td class="num hide-sm">{{ p.quantity | qty }}</td><td class="num hide-sm">{{ p.avg_cost | inr: 4 }}</td>
                        <td class="num nav-cell">
                          @if (editing() === p.id) {
                            <span class="nav-edit"><input class="input num" type="number" step="0.0001" min="0" [(ngModel)]="nav" (keydown.enter)="saveNav(p)" (keydown.escape)="editing.set(null)" [attr.aria-label]="'New NAV for ' + p.name" />
                              <button type="button" class="btn sm primary" (click)="saveNav(p)">Save</button></span>
                          } @else {
                            <span class="nav-line">{{ p.price ? (p.price | inr: 4) : '—' }}
                              @if (auth.canWrite()) { <button type="button" class="btn ghost sm link" (click)="startNav(p)">{{ p.price ? 'Update' : 'Set NAV' }}</button> }</span>
                            @if (staleDays().get(p.id); as days) {
                              <span class="stale-badge"><span class="sr-only">Watch: NAV is </span><app-status status="watch" [word]="days + ' days old'" /></span>
                            }
                            <div class="sub">{{ p.price_at ? (p.price_at | dt) : 'valued at cost' }}</div>
                          }
                        </td>
                        <td class="num hide-sm">{{ p.cost | inr }}</td><td class="num"><b>{{ p.value | inr }}</b></td>
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
              <div class="row wrap" style="justify-content:center;margin-top:16px">
                <button type="button" class="btn primary" (click)="add('BUY')"><app-icon name="plus" [size]="15" /> Add first contribution</button>
                @if (kind() === 'nps') { <a class="btn" routerLink="/import"><app-icon name="upload" [size]="15" /> Import NSDL CAS</a> }
                @else { <a class="btn" routerLink="/import" [queryParams]="{ source: 'epf' }"><app-icon name="upload" [size]="15" /> Import EPF passbooks</a> }
              </div>
            }
          </section>
        }
      }
    </div>`,
  styles: [`
    .hero-skel { height: 150px; border-radius: 14px; }

    /* T0: hero + three tiles; phones keep the hero and two tiles, XIRR sits behind "More" (§1.5, W3-F1) */
    .r-kpis { grid-template-columns: minmax(0, 1.5fr) repeat(3, minmax(0, 1fr)); }
    .r-kpis .verdict-line { margin-top: 10px; font-size: 14px; align-items: flex-start; }
    .r-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .more-stats { display: none; align-self: flex-start; margin-top: 8px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #fff; font-size: 12px; }
    @media (max-width: 900px) {
      .r-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .r-kpis .kpi.extra { grid-column: span 2; border-left: 0; border-top: 1px solid rgba(255, 255, 255, .09); }
    }
    @media (max-width: 760px) {
      .more-stats { display: inline-flex; }
      .r-kpis .kpi.extra:not(.show) { display: none; }
    }

    .start { padding: 36px 28px; text-align: center; }
    .start h3 { font-size: 17px; margin-top: 12px; }
    .start p { color: var(--muted); max-width: 560px; margin: 8px auto 0; font-size: 13.5px; }
    .badge-ic { display: inline-flex; width: 52px; height: 52px; border-radius: 14px; align-items: center; justify-content: center; color: #fff; background: var(--acc); }
    .nav-cell { white-space: nowrap; }
    .nav-line { display: inline-flex; align-items: center; gap: 2px; }
    /* relative: keeps the sr-only prefix inside the table's scroll box, so it never widens the page */
    .stale-badge { position: relative; display: flex; justify-content: flex-end; margin-top: 4px; }
    .nav-edit { display: inline-flex; gap: 6px; align-items: center; }
    .nav-edit .input { width: 110px; height: 30px; }
    .link { height: 22px; padding: 0 6px; color: var(--primary); font-size: 12px; }
    .clickable-text { cursor: pointer; }
    .clickable-text:hover div:first-child { color: var(--primary); }
    /* phones: names wrap and cells tighten so NAV, Value and Gain fit beside the name */
    @media (max-width: 760px) {
      .nav-edit .input { width: 90px; }
      .r-table th, .r-table td { padding-left: 10px; padding-right: 10px; }
      .r-table th:first-child, .r-table td:first-child { padding-left: 14px; }
      .r-table td.name-cell { white-space: normal; min-width: 110px; }
    }
  `],
})
export class RetirementComponent {
  /** 'epf' or 'nps', from the route's `data.kind`. */
  kind = input.required<'epf' | 'nps'>();
  store = inject(StoreService);
  auth = inject(AuthService);
  private dialog = inject(TxnDialogService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private router = inject(Router);

  readonly statusMeta = STATUS_META;
  editing = signal<number | null>(null);
  nav: number | null = null;
  /** Phones: show the third tile (XIRR). */
  moreStats = signal(false);

  /** First load still on its way (no snapshot yet) / failed with nothing to show. */
  loading = computed(() => !this.store.portfolio() && !this.store.error());
  failed = computed(() => !this.store.portfolio() && !!this.store.error());

  rows = computed(() => this.store.positions().filter(p => p.asset_class === this.kind() && (p.is_open || p.txn_count > 0))
    .sort((a, b) => b.value - a.value));
  t = computed(() => {
    const r = this.rows();
    const sum = (f: (p: Position) => number | null | undefined) => r.reduce((a, p) => a + (f(p) ?? 0), 0);
    const seg = this.store.portfolio()?.segments.find(s => s.segment === (this.kind() === 'epf' ? 'EPF' : 'NPS'));
    const cost = sum(p => p.cost), value = sum(p => p.value), gain = value - cost;
    // the oldest NAV date among open schemes that hold value (what "NAVs as of" can honestly claim)
    const dates = r.filter(p => p.is_open && p.value > 0).map(p => (p.price_at ?? '').slice(0, 10)).filter(Boolean).sort();
    return { value, cost, invested: sum(p => p.invested), proceeds: sum(p => p.proceeds), credited: sum(p => p.interest_credited),
      accrued: sum(p => p.accrued_interest), gain, gainPct: cost ? gain / cost * 100 : null, xirr: seg?.xirr ?? null,
      rate: r[0]?.rate ?? 8.25, navDate: dates.length ? dates[0] : null };
  });

  /** Position id → days old, for the NPS schemes that trip `nps:nav-stale` (G10) today. */
  staleDays = computed(() => {
    const asOf = today(), out = new Map<number, number>();
    if (this.kind() !== 'nps') return out;
    for (const p of this.rows()) {
      const d = npsStaleDays(p, asOf);
      if (d !== null) out.set(p.id, d);
    }
    return out;
  });

  /** The hero's verdict line (H19): EPF is factual (`info`); NPS watches stale hand-entered NAVs. */
  verdict = computed<{ status: Status; text: string }>(() => {
    const t = this.t();
    if (this.kind() === 'epf') {
      return { status: 'info', text: `${inrCompact(t.credited)} credited · ${inrCompact(t.accrued)} accruing · ${t.rate}% declared` };
    }
    const stale = [...this.staleDays().values()];
    if (stale.length) return { status: 'watch', text: `NAVs ${Math.max(...stale)} days old — update` };
    const held = this.rows().filter(p => p.is_open && p.value > 0);
    const atCost = held.filter(p => !p.price_at).length;
    if (!t.navDate) {
      return held.length
        ? { status: 'unset', text: 'No NAV entered yet · valued at cost' }
        : { status: 'info', text: 'All schemes closed · nothing held now' };
    }
    return { status: 'good', text: `NAVs as of ${fmtDate(t.navDate)}${atCost ? ` · ${atCost} valued at cost` : ''}` };
  });

  add(type: string) {
    const only = this.rows().length === 1 ? this.rows()[0].id : undefined;
    this.dialog.add(this.kind(), { type, instrumentId: only });
  }
  open(p: Position) { this.router.navigate(['/holding', p.id]); }
  startNav(p: Position) { this.nav = p.price ?? null; this.editing.set(p.id); }

  /** The strip's nps:nav-stale CTA ("Update the NAV") routes to /nps itself, so here it opens that scheme's NAV
   *  editor in place, scrolled into view and focused (W4 review). Other actions run as usual. */
  readonly navRun = (a: Action): (() => void) | null => {
    if (!a.id.startsWith('nps:nav-stale:') || !this.auth.canWrite()) return null;
    const id = a.instrument_id ?? Number(a.id.split(':')[2]);
    const p = this.rows().find(r => r.id === id);
    if (!p) return null;
    return () => {
      this.startNav(p);
      setTimeout(() => {
        const row = document.getElementById('nav-row-' + p.id);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row?.querySelector<HTMLInputElement>('.nav-edit input')?.focus({ preventScroll: true });
      });
    };
  };
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

