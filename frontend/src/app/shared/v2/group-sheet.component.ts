import { ChangeDetectionStrategy, Component, HostListener, effect, inject, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { errorMessage } from '../../core/http';
import { fmtDate, inr, money, pctV } from '../../core/format';
import { groupMeta } from '../../core/groups';
import { GroupExplain } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { IconComponent } from '../icon.component';

/** How one group's return and market comparison are worked out, with every input shown. */
@Component({
  selector: 'v-group-sheet',
  standalone: true,
  imports: [IconComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="v-dim" (click)="closed.emit()"></div>
    <section class="v-sheet" role="dialog" aria-modal="true" [attr.aria-label]="meta().label">
      <div class="grab"></div>
      <button class="close" (click)="closed.emit()" aria-label="Close"><app-icon name="close" [size]="16" /></button>
      <div class="head"><span class="v-ic lg" [style.--c]="meta().color"><app-icon [name]="meta().icon" [size]="20" /></span>
        <div><div class="nm">{{ meta().label }}</div><div class="v-mut sub">How the numbers are worked out</div></div></div>

      @if (e(); as x) {
        <div class="v-stats" style="margin:14px 0 4px">
          <div><small>Value today</small><b>{{ money(x.value) }}</b></div>
          <div><small>Total gain</small><b [class.v-gain]="x.gain >= 0" [class.v-loss]="x.gain < 0">{{ money(x.gain, true) }}</b></div>
          <div><small>Return a year</small><b>{{ pctV(x.xirr) }}</b></div>
        </div>

        <h3>Your return</h3>
        <div class="ln"><span>Money you put in</span><b>{{ inr(x.put_in) }}</b></div>
        <div class="ln"><span>Money you took out<small>sales, dividends, interest, repayments</small></span><b>{{ inr(x.taken_out) }}</b></div>
        <div class="ln"><span>Value today</span><b>{{ inr(x.value) }}</b></div>
        <div class="fx">Gain = {{ inr(x.value) }} + {{ inr(x.taken_out) }} − {{ inr(x.put_in) }} = {{ inr(x.gain) }}</div>
        <p class="note"><b>Return a year ({{ pctV(x.xirr) }})</b> is the one yearly rate that grows each of your {{ x.flows }} dated payments
          into today's value, over {{ x.years }} years since {{ fmtDate(x.first_date) }}. It allows for when money went in and out,
          so money added last month counts for one month, not the whole period.</p>
        @if (x.simple_pct !== null) {
          <p class="note">Not to be confused with <b>gain ÷ money put in = {{ pctV(x.simple_pct) }}</b>, a total (not a yearly rate) that
            also shrinks its base every time money is taken out.</p>
        }

        @if (x.market.labels.length) {
          <h3>Against the market</h3>
          <div class="ln"><span>Same money in {{ x.market.labels.join(' and ') }}<small>{{ divNote(x) }}</small></span>
            <b>{{ x.market.end_value !== null ? inr(x.market.end_value) : 'no data' }}</b></div>
          <div class="ln"><span>Its return a year</span><b>{{ pctV(x.market.xirr) }}</b></div>
          @if (x.market.diff_pts !== null) {
            <div class="fx">{{ pctV(x.xirr) }} − {{ pctV(x.market.xirr) }} = {{ ptsText(x.market.diff_pts) }}</div>
          }
          <p class="note">{{ x.market.how }} The difference is in percentage points: +1 pt means 1% a year more.</p>
        }

        <h3>Money in and out by year</h3>
        @for (y of x.by_year; track y.year) {
          <div class="ln yr"><span>{{ y.year }}</span><span class="v-mut">in {{ inr(y.put_in) }}</span><span class="v-mut">out {{ inr(y.taken_out) }}</span></div>
        }

        <h3>Each holding</h3>
        @for (h of x.holdings; track h.id) {
          <a class="v-row" routerLink="/portfolio" [queryParams]="{ holding: h.id }" (click)="closed.emit()">
            <div class="grow"><div class="t">{{ h.name }}{{ h.is_open ? '' : ' (closed)' }}</div>
              <div class="s">in {{ money(h.put_in) }} · out {{ money(h.taken_out) }} · now {{ money(h.value) }}</div></div>
            <div class="r"><b [class.v-gain]="h.gain > 0" [class.v-loss]="h.gain < 0">{{ money(h.gain, true) }}</b><span class="v-mut yr2">{{ pctV(h.xirr) }} a yr</span></div>
          </a>
        }
      } @else if (err()) { <p class="v-empty">{{ err() }}</p> }
      @else { <div class="v-skel" style="height:300px;margin-top:14px"></div> }
    </section>
  `,
  styles: [`
    .head { display: flex; align-items: center; gap: 12px; padding-right: 40px; }
    .nm { font-weight: 800; font-size: 18px; letter-spacing: -.02em; }
    .sub { font-size: 12.5px; font-weight: 600; }
    h3 { font-size: 14px; font-weight: 800; margin: 18px 0 6px; }
    .ln { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; padding: 7px 0; border-top: 1px solid var(--border); font-size: 13.5px; }
    .ln span { display: flex; flex-direction: column; } .ln small { font-size: 11.5px; color: var(--muted); }
    .ln b { white-space: nowrap; }
    .ln.yr span { flex: 1; } .ln.yr span:first-child { flex: 0 0 60px; font-weight: 700; }
    .fx { display: inline-block; font-size: 12.5px; font-weight: 700; background: var(--bg); border-radius: 9px; padding: 6px 10px; margin-top: 6px; }
    .note { font-size: 12.5px; color: var(--text-2); margin: 8px 0 0; line-height: 1.5; }
    .yr2 { font-size: 11.5px; font-weight: 600; }
  `],
})
export class GroupSheetComponent {
  key = input.required<string>();
  closed = output<void>();
  private api = inject(ApiService);
  private store = inject(StoreService);

  money = money; pctV = pctV; inr = inr; fmtDate = fmtDate;
  e = signal<GroupExplain | null>(null);
  err = signal<string | null>(null);
  meta = () => groupMeta(this.key());

  constructor() {
    effect(() => {
      const k = this.key();
      this.store.version();
      untracked(() => {
        this.e.set(null);
        firstValueFrom(this.api.groupExplain(k)).then(x => this.e.set(x)).catch(e => this.err.set(errorMessage(e)));
      });
    });
  }

  ptsText(v: number) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' pts'; }
  divNote(x: GroupExplain) {
    const d = Object.entries(x.market.dividend_yield);
    return d.length ? 'Index plus an estimated ' + d.map(([, v]) => `${v}%`).join(' / ') + ' a year in dividends' : 'A fixed yearly rate';
  }

  @HostListener('document:keydown.escape') esc() { this.closed.emit(); }
}
