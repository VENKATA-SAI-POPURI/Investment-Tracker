import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ActionService } from '../../core/action.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, today } from '../../core/format';
import { Position, Status } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { PortfolioTabsComponent } from '../../shared/portfolio-tabs.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { STATUS_META } from '../../shared/priority/priority';

/** An FD maturing within this many days is `watch` and gets a "Redeploy ₹X" badge (actions.FD_SOON_DAYS). */
export const FD_SOON_DAYS = 30;

/** The money an FD pays back at maturity: `maturity_value`, else today's `value` (as actions `fd:maturing` does). */
export function fdPayout(p: Position): number {
  return p.maturity_value ?? p.value;
}

/** A28: an open FD whose maturity date has passed, with no maturity recorded (`days_to_maturity` is null then). */
export function maturedUnrecorded(p: Position, todayIso: string): boolean {
  return p.is_open && !!p.maturity_date && p.maturity_date < todayIso;
}

/** An open FD maturing today or within FD_SOON_DAYS days. */
export function maturingSoon(p: Position): boolean {
  const d = p.days_to_maturity;
  return p.is_open && d !== null && d !== undefined && d >= 0 && d <= FD_SOON_DAYS;
}

/**
 * Fixed deposits class page (SPEC Part 1 §5.7 FD row; AMENDMENTS H19, A13, A19, A22, A28, D24).
 *
 * - h1 "Fixed deposits" under the portfolio tabs.
 * - T0 hero "Next maturity": the open FD with the smallest `days_to_maturity` ≥ 0, as
 *   "{name} · {days} days · ₹{maturity_value}". Status `act` when an open FD matured and is not recorded (A28),
 *   `watch` when the next maturity is ≤ 30 days away, `good` otherwise (`info` with no open FD).
 *   Tiles: Active deposits, Interest accrued, Value today (the last behind "More" at ≤ 760 px).
 * - T1 Needs attention: `fd:` actions linking to `/fixed-deposits`.
 * - T3 the FD table. "Mark matured" opens the shell's global dialog (A19) with the visible
 *   `fd:matured-unrecorded:<id>` action, so saving also closes that action. Open FDs maturing within 30 days carry
 *   a "Redeploy ₹X" link to `/actions?new_money=X#deploy` (A13).
 *
 * Reads only the store's portfolio and the cached `/actions` (through ActionService); posts nothing itself.
 */
@Component({
  selector: 'app-fixed-deposits',
  standalone: true,
  imports: [RouterLink, IconComponent, PortfolioTabsComponent, NeedsAttentionComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .hero-skel { height: 150px; border-radius: 14px; }

    /* T0: hero + three tiles; phones keep the hero and two tiles, the third sits behind "More" (§1.5, W3-F1) */
    .fd-kpis { grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 1fr)); }
    .fd-kpis .kpi.hero .value.next { font-size: 22px; line-height: 1.25; white-space: normal; overflow-wrap: anywhere; }
    .fd-kpis .verdict-line { margin-top: 10px; font-size: 14px; align-items: flex-start; flex-wrap: wrap; row-gap: 2px; }
    .fd-kpis .verdict-line app-icon { flex: none; margin-top: 2px; }
    .cta-wrap { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
    .verdict-cta { border: 0; background: none; padding: 0; font: inherit; color: var(--gold-2); text-decoration: underline; cursor: pointer; }
    .more-stats { display: none; align-self: flex-start; margin-top: 8px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .25); background: transparent; color: #fff; font-size: 12px; }
    @media (max-width: 900px) {
      .fd-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .fd-kpis .kpi:nth-child(2) { border-left: 0; }
      .fd-kpis .kpi:nth-child(3) { border-left: 1px solid rgba(255, 255, 255, .09); }
      .fd-kpis .kpi.extra { grid-column: span 2; border-left: 0; }
    }
    @media (max-width: 760px) {
      .more-stats { display: inline-flex; }
      .fd-kpis .kpi.extra:not(.show) { display: none; }
      .fd-kpis .kpi.hero .value.next { font-size: 19px; }
    }

    .mat { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
    a.badge { text-decoration: none; }
    a.badge:hover { text-decoration: underline; }
    a.badge:focus-visible, .verdict-cta:focus-visible { outline: 2px solid var(--gold-2); outline-offset: 2px; }
  `],
  template: `
    <div class="page">
      <app-portfolio-tabs />
      <div class="page-head">
        <div>
          <h1>Fixed deposits</h1>
          @if (port()) { <p class="sub">{{ active().length }} open · {{ fds().length - active().length }} closed</p> }
        </div>
        @if (auth.canWrite()) { <button type="button" class="btn sm" (click)="dialog.add('fixed_deposit')"><app-icon name="plus" [size]="15" /> New FD</button> }
      </div>

      @if (loading()) {
        <div class="skeleton hero-skel" aria-label="Loading your fixed deposits"></div>
        <div class="card"><div class="skeleton" style="height:18px;width:40%"></div><div class="skeleton" style="height:200px;margin-top:14px"></div></div>
      } @else if (failed()) {
        <div class="card"><div class="empty">
          <app-icon name="alert" [size]="22" /><h3>Couldn't load your fixed deposits</h3><p>{{ store.error() }}</p>
          <button type="button" class="btn" (click)="store.reload()"><app-icon name="refresh" [size]="15" /> Try again</button>
        </div></div>
      } @else {
        @if (store.error()) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't refresh, so these are the last numbers this device saw · {{ store.error() }}</span>
            <button type="button" class="btn ghost sm" (click)="store.reload()">Try again</button></div>
        }

        @if (!fds().length) {
          <div class="card"><div class="empty">
            <app-icon name="bank" [size]="28" /><h3>No fixed deposits yet</h3><p>Add an FD to track accrued interest and get maturity reminders.</p>
            @if (auth.canWrite()) { <button type="button" class="btn primary" (click)="dialog.add('fixed_deposit')"><app-icon name="plus" [size]="16" /> Add your first FD</button> }
          </div></div>
        } @else {
          <!-- T0: the answer -->
          <section class="kpis fd-kpis" aria-label="Fixed deposits at a glance">
            <div class="kpi hero">
              <span class="label">Next maturity</span>
              @if (next(); as n) {
                <span class="value next">{{ n.name }} · {{ daysText(n.days_to_maturity!) }} · {{ payout(n) | inr }}</span>
                <span class="meta">on {{ n.maturity_date | dt }} · {{ n.maturity_value !== null && n.maturity_value !== undefined ? 'at ' + n.rate + '% a year' : 'value today; no rate to work out maturity' }}</span>
              } @else {
                <span class="value">—</span>
                <span class="meta">{{ active().length ? 'No maturity date ahead' : 'No open deposits' }}</span>
              }
              <div class="verdict-line" [attr.data-status]="verdict().status">
                <app-icon [name]="statusMeta[verdict().status].icon" [size]="16" />
                <span>{{ verdict().text }}</span>
                @if (verdict().status === 'act' && auth.canWrite() && matured()[0]; as m) {
                  <span class="cta-wrap"><span aria-hidden="true">·</span>
                    <button type="button" class="verdict-cta" (click)="markMatured(m)" [attr.aria-label]="'Mark the FD at ' + m.name + ' matured'">Mark matured</button></span>
                }
                <span class="sr-only">· {{ statusMeta[verdict().status].word }}</span>
              </div>
              <button type="button" class="more-stats" (click)="moreStats.set(!moreStats())" [attr.aria-expanded]="moreStats()">{{ moreStats() ? 'Less' : 'More' }}</button>
            </div>
            <div class="kpi"><span class="chip blue sm"><app-icon name="bank" [size]="15" /></span><span class="label">Active deposits</span>
              <span class="value">{{ stats().principal | inr }}</span><span class="meta">{{ active().length }} FD{{ active().length === 1 ? '' : 's' }}</span></div>
            <div class="kpi"><span class="chip green sm"><app-icon name="trend" [size]="15" /></span><span class="label">Interest accrued</span>
              <span class="value pos">{{ stats().accrued | inr }}</span><span class="meta">on open FDs, not yet paid out</span></div>
            <div class="kpi extra" [class.show]="moreStats()"><span class="chip violet sm"><app-icon name="wallet" [size]="15" /></span><span class="label">Value today</span>
              <span class="value">{{ stats().value | inr }}</span><span class="meta">deposits + accrued interest</span></div>
          </section>

          <!-- T1: needs attention here (H19) -->
          <app-needs-attention [prefixes]="['/fixed-deposits']" [ids]="['fd:']" />

          <!-- T3: every FD -->
          <section class="card flush">
            <div class="table-wrap">
              <table class="table">
                <thead><tr>
                  <th scope="col">Bank</th><th scope="col" class="hide-sm">Started</th><th scope="col" class="num hide-sm">Rate</th>
                  <th scope="col" class="num">Deposit</th><th scope="col" class="num">Value now</th><th scope="col">Matures</th>
                  <th scope="col" class="num hide-sm">At maturity</th><th scope="col"><span class="sr-only">Action</span></th>
                </tr></thead>
                <tbody>
                  @for (p of fds(); track p.id) {
                    <tr [class.muted]="!p.is_open">
                      <td><a [routerLink]="['/holding', p.id]">{{ p.name }}</a><div class="sub">{{ p.platform || '' }}</div></td>
                      <td class="hide-sm">{{ p.first_date | dt }}</td><td class="num hide-sm">{{ p.rate ? p.rate + '%' : '—' }}</td>
                      <td class="num">{{ p.invested | inr }}</td><td class="num">{{ p.is_open ? (p.value | inr) : '—' }}</td>
                      <td>
                        <div class="mat">
                          <span>{{ p.maturity_date | dt }}</span>
                          @if (isMatured(p)) {
                            <span class="badge bad"><app-icon name="alert" [size]="12" /> Matured, not recorded</span>
                          } @else if (soon(p)) {
                            <span class="badge warn">{{ p.days_to_maturity === 0 ? 'today' : p.days_to_maturity + 'd' }}</span>
                            <a class="badge info" routerLink="/actions" [queryParams]="{ new_money: redeployAmount(p) }" fragment="deploy"
                               [attr.aria-label]="'Redeploy ' + (redeployAmount(p) | inr) + ' from the FD at ' + p.name + ': plan where it goes'">Redeploy {{ redeployAmount(p) | inr }}</a>
                          }
                        </div>
                      </td>
                      <td class="num hide-sm">{{ p.is_open ? (p.maturity_value | inr) : (p.invested + p.realized | inr) }}</td>
                      <td class="right">
                        @if (p.is_open && auth.canWrite()) { <button type="button" class="btn sm" (click)="markMatured(p)">Mark matured</button> }
                        @else if (!p.is_open) { <span class="badge good">Matured · {{ p.realized | inr: 0 : true }}</span> }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      }
    </div>`,
})
export class FixedDepositsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private actions = inject(ActionService);

  readonly statusMeta = STATUS_META;
  readonly payout = fdPayout;
  readonly soon = maturingSoon;
  moreStats = signal(false);

  port = computed(() => this.store.portfolio());
  loading = computed(() => !this.port() && !this.store.error());
  failed = computed(() => !this.port() && !!this.store.error());

  fds = computed(() => this.store.positions().filter(p => p.asset_class === 'fixed_deposit')
    .sort((a, b) => Number(b.is_open) - Number(a.is_open) || (a.maturity_date ?? '').localeCompare(b.maturity_date ?? '')));
  active = computed(() => this.fds().filter(p => p.is_open));
  /** A28: open FDs past their maturity date, oldest first (fds() is sorted by maturity date). */
  matured = computed(() => { const t = today(); return this.active().filter(p => maturedUnrecorded(p, t)); });
  /** The open FD with the smallest `days_to_maturity` ≥ 0. */
  next = computed<Position | null>(() => this.active()
    .filter(p => p.days_to_maturity !== null && p.days_to_maturity !== undefined && p.days_to_maturity >= 0)
    .reduce<Position | null>((best, p) => !best || p.days_to_maturity! < best.days_to_maturity! ? p : best, null));

  stats = computed(() => {
    const a = this.active();
    return { principal: a.reduce((s, p) => s + p.invested, 0), accrued: a.reduce((s, p) => s + (p.accrued_interest ?? 0), 0),
      value: a.reduce((s, p) => s + p.value, 0) };
  });

  /** H19: act (matured, unrecorded) > watch (next maturity ≤ 30 days) > good; info with no open FD. */
  verdict = computed<{ status: Status; text: string }>(() => {
    const m = this.matured().length;
    if (m) return { status: 'act', text: `${m} matured FD${m === 1 ? '' : 's'} not recorded` };
    if (!this.active().length) return { status: 'info', text: 'No open deposits' };
    const n = this.next();
    if (n && n.days_to_maturity! <= FD_SOON_DAYS) {
      return { status: 'watch', text: `${n.days_to_maturity === 0 ? 'Matures today' : 'Matures within 30 days'} · plan where the money goes` };
    }
    return { status: 'good', text: 'Nothing matures in the next 30 days' };
  });

  isMatured(p: Position): boolean { return maturedUnrecorded(p, today()); }

  daysText(d: number): string { return d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`; }

  /** A13: the planner's new money, in whole rupees. */
  redeployAmount(p: Position): number { return Math.round(fdPayout(p)); }

  /** A19: the shell's global dialog; passing the visible action id closes it with the save (W1-F1 follow-up). */
  markMatured(p: Position) {
    this.dialog.openFdMature(p.id, this.actions.find('fd:matured-unrecorded:' + p.id)?.id);
  }
}
