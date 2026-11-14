import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FORMAT_PIPES } from '../../core/format';
import { PortfolioRisk, RiskHolding } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';

/** A holding's risk share above this multiple of its weight is flagged "high" (SPEC §5.6). */
export const RISK_SHARE_HIGH = 1.3;

/** Does this holding cause more than its share of the swings? */
export function riskShareHigh(h: Pick<RiskHolding, 'risk_contribution_pct' | 'weight_pct'>): boolean {
  return h.risk_contribution_pct !== null && h.risk_contribution_pct !== undefined && h.weight_pct > 0
    && h.risk_contribution_pct > h.weight_pct * RISK_SHARE_HIGH;
}

/** The Data column: own prices, or a proxy index (named) standing in before the first price. */
export function dataLabel(h: Pick<RiskHolding, 'data' | 'proxy'>): string {
  if (h.data === 'proxy') return h.proxy ? `proxy · ${h.proxy}` : 'proxy';
  if (h.data === 'prior') return 'own · short';
  return 'own';
}

/**
 * Risk & mix `#risk` "Where the risk comes from" (T2, SPEC §5.6, AMENDMENTS J8). Closes the W1-B3 follow-up:
 * - columns Holding / Weight / Volatility "measured | used" (`volatility_pct` | `volatility_used_pct`) / Beta /
 *   Risk share / Data (own, or proxy with its index);
 * - a risk share above 1.3 × weight is red **and** carries ▲ and the word "high", never colour alone;
 * - then the read-outs (parametric VaR, expected shortfall, Sharpe/Sortino with the ballast, beta, diversification).
 * The page loads `GET /risk` (its T0 reads `var_95.day`) and passes it in. The correlation heat table is the
 * separate `CorrelationHeatComponent` (T3).
 */
@Component({
  selector: 'app-risk',
  standalone: true,
  imports: [RouterLink, IconComponent, EstTagComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let rk = r();
    @if (error(); as e) {
      <div class="notice bad" role="alert"><app-icon name="alert" [size]="16" /><span>Couldn't measure the risk · {{ e }}</span>
        <span class="spacer"></span><button type="button" class="btn sm" (click)="retry.emit()">Try again</button></div>
    } @else if (rk) {
      @if (rk.holdings.length) {
        <div class="grid duo">
          <div class="card flush">
            <div class="card-head"><div><h3>By holding</h3>
              <span class="hint">share of day-to-day swings each holding causes@if (rk.days) {, past {{ rk.days }} trading days}</span></div></div>
            <div class="table-wrap">
              <table class="table rk-table">
                <caption class="sr-only">Where the risk comes from, by holding</caption>
                <thead><tr>
                  <th scope="col">Holding</th><th scope="col" class="num">Weight</th>
                  <th scope="col" class="num" title="Measured: its own price swings over the last year. Used: that figure blended toward its asset class's long-run swings, which the portfolio numbers use.">Volatility<span class="sub-h">measured | used</span></th>
                  <th scope="col" class="num hide-sm">Beta</th><th scope="col" class="num">Risk share</th><th scope="col">Data</th>
                </tr></thead>
                <tbody>
                  @for (h of rk.holdings; track h.id) {
                    @let high = isHigh(h);
                    <tr>
                      <td class="name-cell"><a [routerLink]="['/holding', h.id]">{{ h.name }}</a><div class="sub">{{ h.segment }}</div></td>
                      <td class="num">{{ h.weight_pct | pct: 1 : false }}</td>
                      <td class="num nowrap">{{ h.volatility_pct | pct: 1 : false }} <span class="muted">|</span> {{ (h.volatility_used_pct ?? h.volatility_pct) | pct: 1 : false }}</td>
                      <td class="num hide-sm">{{ h.beta ?? '—' }}</td>
                      <td class="num nowrap" [class.neg]="high">
                        <span class="share">
                          <span class="progress" aria-hidden="true"><span [style.width.%]="h.risk_contribution_pct ?? 0" [style.background]="high ? 'var(--neg)' : 'var(--s1)'"></span></span>
                          {{ h.risk_contribution_pct | pct: 0 : false }}
                          @if (high) { <span class="high" [attr.title]="'More than ' + share + '× its weight'"><span aria-hidden="true">▲</span> high</span> }
                        </span>
                      </td>
                      <td class="nowrap"><span class="badge" [class.info]="h.data === 'proxy'" [attr.title]="dataTitle(h)">{{ label(h) }}</span></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="small muted rk-foot">"Used" pulls a short or noisy history toward its asset class's long-run swings. A proxy stands in before a holding's first stored price.</p>
          </div>

          <div class="card">
            <div class="card-head"><h3>Read-outs</h3></div>
            @for (n of rk.notes; track n) { <p class="small rk-note">{{ n }}</p> }
            <dl class="kv rk-kv">
              @if (rk.var_95; as v) {
                <dt>A bad month (1 in 20)</dt><dd>−{{ v.month | inrc }}<app-est [basis]="varBasis" /> <span class="muted">({{ v.month_pct }}%)</span></dd>
                <dt>Parametric 1-day VaR</dt><dd>{{ v.parametric_day_pct }}%</dd>
                <dt>Expected shortfall (tail average)</dt><dd>{{ v.expected_shortfall_day_pct }}%</dd>
              }
              @if (rk.volatility_pct !== undefined) {
                <dt>Volatility (measured)</dt><dd>{{ rk.volatility_pct | pct: 1 : false }}@if (rk.model) { <span class="muted"> · model {{ rk.model.vol_pct | pct: 1 : false }}</span> }</dd>
              }
              <dt>Sharpe · Sortino</dt><dd>{{ rk.sharpe ?? '—' }} · {{ rk.sortino ?? '—' }}</dd>
              @if (rk.benchmark) { <dt>Beta to {{ rk.benchmark }}</dt><dd>{{ rk.beta ?? '—' }}@if (rk.correlation_index !== null && rk.correlation_index !== undefined) { <span class="muted"> · corr. {{ rk.correlation_index }}</span> }</dd> }
              <dt>Diversification ratio</dt><dd>{{ rk.diversification_ratio ?? '—' }}</dd>
              @if (rk.ballast; as b) {
                <dt>Steady money (FDs, EPF, P2P)</dt>
                <dd class="wrap">{{ b.weight_pct | pct: 0 : false }} of the portfolio@if (b.rate_pct !== null) { at ~{{ b.rate_pct }}% a year} · {{ b.risk_contribution_pct | pct: 0 : false }} of the swings</dd>
              }
              @if (rk.correlation.highest; as hi) { <dt>Most alike</dt><dd class="small wrap">{{ hi.pair[0] }} &amp; {{ hi.pair[1] }} ({{ hi.value }})</dd> }
              @if (rk.correlation.lowest; as lo) { <dt>Least alike</dt><dd class="small wrap">{{ lo.pair[0] }} &amp; {{ lo.pair[1] }} ({{ lo.value }})</dd> }
            </dl>
            <p class="small muted rk-note">Sharpe and Sortino count the steady money at its interest rates. 1.0 diversification = no benefit from mixing; higher is better.</p>
          </div>
        </div>
      } @else {
        <div class="card"><div class="empty"><app-icon name="scale" [size]="28" /><h3>Not enough price history yet</h3>
          <p>{{ rk.notes[0] }} Market-priced holdings with a ticker build up history as prices refresh.</p></div></div>
      }
    } @else {
      <div class="card"><div class="skeleton" style="height:240px" aria-label="Loading the risk breakdown"></div></div>
    }`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .notice .spacer { flex: 1 1 auto; }
    h3 { font-size: 14.5px; font-weight: 600; }
    .rk-table .sub-h { display: block; font-size: 11px; font-weight: 400; color: var(--muted); }
    .share { display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; }
    .share .progress { width: 56px; }
    .high { display: inline-flex; align-items: center; gap: 2px; font-size: 11.5px; font-weight: 600; color: var(--neg); }
    .rk-foot { padding: 12px 22px 18px; margin: 0; }
    .rk-note { margin: 0 0 8px; }
    .rk-kv { margin: 8px 0 12px; }
    .rk-kv dd.wrap { white-space: normal; }
    @media (max-width: 900px) { .duo { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 760px) { .share .progress { display: none; } .rk-foot { padding: 12px 14px 14px; } }
  `],
})
export class RiskComponent {
  readonly r = input<PortfolioRisk | null>(null);
  readonly error = input<string | null>(null);
  readonly retry = output<void>();

  readonly share = RISK_SHARE_HIGH;
  readonly varBasis = 'From the last year of daily price moves: about 1 month in 20 could lose more. Past swings, not a forecast';
  isHigh = riskShareHigh;
  label = dataLabel;
  dataTitle(h: RiskHolding): string {
    const days = h.n !== undefined ? `${h.n} days of its own prices` : '';
    const q = h.data_quality ? `volatility mostly ${h.data_quality === 'own' ? 'its own' : h.data_quality === 'some' ? 'its own, blended' : h.data_quality === 'rate' ? 'from its rate' : 'the class average'}` : '';
    const proxy = h.data === 'proxy' && h.proxy ? `${h.proxy} stands in before its first price` : '';
    return [proxy, days, q].filter(Boolean).join(' · ') || 'Its own prices';
  }
}

/**
 * "How holdings move together" (T3, collapsed on Risk & mix): the `/risk` correlation heat table, short labels with
 * the full names in each cell's and header's `title`.
 */
@Component({
  selector: 'app-correlation-heat',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (labels().length > 1) {
      <div class="table-wrap">
        <table class="heat">
          <caption class="sr-only">Correlation of daily returns between your largest holdings</caption>
          <thead><tr><th></th>@for (l of labels(); track $index) { <th scope="col" [title]="l"><span class="rot">{{ short(l) }}</span></th> }</tr></thead>
          <tbody>
            @for (row of matrix(); track $index; let i = $index) {
              <tr><th scope="row" class="lbl" [title]="labels()[i]">{{ short(labels()[i]) }}</th>
                @for (v of row; track $index; let j = $index) { <td [style.background]="bg(v, i === j)" [title]="labels()[i] + ' × ' + labels()[j] + ': ' + (v ?? '—')">{{ v === null ? '' : i === j ? '' : v.toFixed(2) }}</td> }</tr>
            }
          </tbody>
        </table>
      </div>
      <p class="small muted">1 = in lockstep, 0 = unrelated, negative = moving opposite. Warm colours move together; cool ones offset each other.</p>
    } @else {
      <p class="small muted">Needs two or more market-priced holdings with price history.</p>
    }`,
  styles: [`
    :host { display: block; min-width: 0; }
    .heat { border-collapse: separate; border-spacing: 3px; font-size: 12px; }
    .heat thead th { color: var(--muted); font-weight: 500; vertical-align: bottom; padding: 0 2px 4px; height: 90px; }
    .heat .rot { display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; max-height: 86px; overflow: hidden; text-overflow: ellipsis; }
    .heat td { text-align: center; min-width: 46px; height: 34px; border-radius: 4px; font-variant-numeric: tabular-nums; color: var(--text); }
    .heat th.lbl { text-align: right; color: var(--muted); font-weight: 500; padding-right: 8px; white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
  `],
})
export class CorrelationHeatComponent {
  readonly r = input<PortfolioRisk | null>(null);
  readonly labels = computed(() => this.r()?.correlation.labels ?? []);
  readonly matrix = computed(() => this.r()?.correlation.matrix ?? []);
  short = (s: string) => s.length > 18 ? s.slice(0, 17) + '…' : s;
  bg(v: number | null, diag: boolean) {
    if (diag) return 'var(--surface-2)';
    if (v === null) return 'transparent';
    const k = Math.min(Math.abs(v), 1) * 75;
    return `color-mix(in srgb, ${v >= 0 ? 'var(--s8)' : 'var(--s1)'} ${k.toFixed(0)}%, var(--surface-2))`;
  }
}
