import { ChangeDetectionStrategy, Component, HostListener, effect, inject, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { errorMessage } from '../../core/http';
import { fmtDate, inr, money, pctV } from '../../core/format';
import { groupMeta } from '../../core/groups';
import { linkPath, linkQuery } from '../../core/links';
import { GroupExplain } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { IconComponent } from '../icon.component';

/** The ⓘ sheet: how a group's (or, with key 'all', the whole portfolio's) return and market comparison are worked out,
 *  in four numbered steps with every input shown, and any data problem behind them with a link to fix it. */
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
      <div class="head"><span class="v-ic lg" [style.--c]="meta().color"><app-icon [name]="meta().icon" [size]="17" /></span>
        <div><div class="nm">{{ meta().label }}</div><div class="v-mut sub">How the numbers are worked out</div></div></div>

      @if (e(); as x) {
        <div class="v-stats" style="margin:14px 0 4px">
          <div><small>Value today</small><b>{{ money(x.value) }}</b></div>
          <div><small>Total gain</small><b [class.v-gain]="x.gain >= 0" [class.v-loss]="x.gain < 0">{{ money(x.gain, true) }}</b></div>
          <div><small>Return a year</small><b>{{ pctV(x.xirr) }}</b></div>
        </div>

        @for (i of x.issues ?? []; track i.id) {
          <div class="v-note" [class.warn]="i.severity !== 'info'" [class.info]="i.severity === 'info'">
            <app-icon name="triangleAlert" [size]="16" />
            <span><b>{{ i.title }}</b>{{ i.items.length ? ' · ' + names(i) : '' }}. {{ i.fix ?? '' }}
              @if (fixLink(i); as l) { <a [routerLink]="path(l)" [queryParams]="query(l)" (click)="closed.emit()">Fix it →</a> }</span>
          </div>
        }

        <h3>How "{{ pctV(x.xirr) }} a year" is worked out</h3>
        <ol class="steps4">
          <li><span class="n">1</span><div><b>Money in</b> — what you put in{{ key() === 'p2p' ? ' (wallet top-ups)' : '' }}<code>{{ inr(x.put_in) }} over {{ x.flows }} dated payments since {{ fmtDate(x.first_date) }}</code></div></li>
          <li><span class="n">2</span><div><b>Money out</b> — sales, dividends, interest, repayments to your bank<code>{{ inr(x.taken_out) }}</code></div></li>
          <li><span class="n">3</span><div><b>Still there</b> — value today<code>{{ inr(x.value) }}</code></div></li>
          <li><span class="n">4</span><div><b>Yearly rate</b> that makes 1, 2 and 3 balance, counting when each payment happened (XIRR)<code>= {{ pctV(x.xirr) }} a year</code></div></li>
        </ol>
        <div class="fx">Total gain = {{ inr(x.value) }} + {{ inr(x.taken_out) }} − {{ inr(x.put_in) }} = {{ inr(x.gain) }}</div>
        <p class="note">Money added last month counts for one month, not the whole {{ x.years }} years, which is why this differs from a simple
          gain ÷ money in.</p>
        <div class="links"><a class="v-link" routerLink="/activity" [queryParams]="{ tab: 'entries' }" (click)="closed.emit()">See the entries →</a>
          @if (x.market.labels.length) { <a class="v-link" routerLink="/analysis" [queryParams]="{ q: 'market' }" (click)="closed.emit()">Compare with the market →</a> }</div>
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
    .nm { font-weight: 800; font-size: 16px; letter-spacing: -.02em; }
    .sub { font-size: 12.5px; font-weight: 600; }
    h3 { font-size: 13px; font-weight: 800; margin: 18px 0 6px; }
    .ln { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; padding: 7px 0; border-top: 1px solid var(--border); font-size: 12.5px; }
    .ln span { display: flex; flex-direction: column; } .ln small { font-size: 11.5px; color: var(--muted); }
    .ln b { white-space: nowrap; }
    .ln.yr span { flex: 1; } .ln.yr span:first-child { flex: 0 0 60px; font-weight: 700; }
    .fx { display: inline-block; font-size: 12.5px; font-weight: 700; background: var(--bg); border-radius: 9px; padding: 6px 10px; margin-top: 6px; }
    .note { font-size: 12.5px; color: var(--text-2); margin: 8px 0 0; line-height: 1.5; }
    .yr2 { font-size: 11.5px; font-weight: 600; }
    .v-note { margin-top: 12px; } .v-note a { font-weight: 700; white-space: nowrap; }
    .steps4 { list-style: none; margin: 4px 0 0; padding: 0; background: var(--surface-2); border: 1px solid var(--border); border-radius: 16px; padding: 4px 14px; }
    .steps4 li { display: grid; grid-template-columns: 28px 1fr; gap: 10px; padding: 10px 0; border-top: 1px solid var(--border); font-size: 12.5px; color: var(--text-2); }
    .steps4 li:first-child { border-top: 0; }
    .steps4 b { color: var(--text); }
    .steps4 .n { width: 28px; height: 28px; border-radius: 50%; background: var(--surface-3); color: var(--accent); display: grid; place-items: center; font-weight: 800; font-size: 13px; }
    .steps4 code { display: block; font-family: inherit; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; margin-top: 6px; font-size: 13px; color: var(--text); font-weight: 650; }
    .links { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
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
  meta = () => this.key() === 'all' ? { label: 'Everything', icon: 'layers', color: '#8b93ff' } : groupMeta(this.key());
  path = linkPath; query = linkQuery;
  /** Where to fix an issue: one holding opens that holding; otherwise the check's own page. */
  fixLink = (i: { items: { instrument_id: number }[]; link?: string | null }) =>
    i.items.length === 1 ? `/portfolio?holding=${i.items[0].instrument_id}` : i.link ?? null;
  names = (i: { items: { name: string }[]; count: number }) => i.items.slice(0, 2).map(x => x.name).join(', ') + (i.count > 2 ? ` and ${i.count - 2} more` : '');

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
