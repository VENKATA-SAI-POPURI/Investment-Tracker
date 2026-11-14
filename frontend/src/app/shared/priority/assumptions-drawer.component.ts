import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, OnInit, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { errorMessage } from '../../core/http';
import { AssumptionsView, ChipBlock } from '../../core/models';
import { IconComponent } from '../icon.component';

/** Friendly names for the HONESTY keys; unknown keys (the set grows) show under their own name. */
const HONESTY_LABEL: Record<string, string> = {
  p50: 'The middle line', p10: 'The low line', p90: 'The high line', mean: 'The average', probability: 'Chances',
  estimate: 'Forward amounts', signal: 'Market signals', cone: 'Holding ranges',
};

/**
 * The Assumptions drawer (Part 2 §9.3, §6.1; AMENDMENTS H7, H17), opened by `<app-assumption-chip>`.
 *
 * Fetches GET /assumptions once per open and shows, in order: the note ("Long-run assumptions, not predictions"),
 * the portfolio chip and its Book hash, the typical 1/3/5-year ranges, the segment rows, inflation and the
 * risk-free rate, the correlation note (matrix collapsed), the honesty copy, and "Change the mix" → /risk#profile.
 * A side sheet on wide screens and a bottom sheet on phones; Escape, the scrim and the close button shut it.
 */
@Component({
  selector: 'app-assumptions-drawer',
  standalone: true,
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ad-scrim" (click)="closed.emit()"></div>
    <aside class="ad-sheet" role="dialog" aria-modal="true" aria-labelledby="ad-title" tabindex="-1" #sheet>
      <header class="ad-head">
        <div><h2 id="ad-title">Assumptions</h2><small>Long-run assumptions, not predictions.</small></div>
        <button type="button" class="btn ghost icon sm" (click)="closed.emit()" aria-label="Close"><app-icon name="close" /></button>
      </header>

      <div class="ad-body">
        @if (data(); as d) {
          <section class="ad-sec">
            <div class="ad-chip"><app-icon name="info" [size]="14" /><span>{{ d.portfolio.text || d.portfolio.chip }}</span></div>
            <p class="ad-meta">Your whole portfolio's mix · Book <code>#{{ d.hash }}</code>@if (block()?.basis) { · {{ block()!.basis }} }</p>
            @if (block() && block()!.hash !== d.hash) {
              <p class="notice warn ad-stale"><app-icon name="alert" [size]="15" />
                <span>The card you came from was worked out on Book #{{ block()!.hash }}; the Book is now #{{ d.hash }}. Reload the page for figures on the current one.</span></p>
            }
          </section>

          @if (d.typical_bands.length) {
            <section class="ad-sec">
              <h3>What a year typically looks like</h3>
              <ul class="ad-bands">
                @for (b of d.typical_bands; track b.years) {
                  <li><b>Over {{ b.years }} year{{ b.years === 1 ? '' : 's' }}</b>
                    <span>typical {{ fmt(b.typical) }}% a year · 1-in-10 range {{ fmt(b.lo) }}% to {{ fmt(b.hi) }}%</span></li>
                }
              </ul>
            </section>
          }

          <section class="ad-sec">
            <h3>By asset class</h3>
            <div class="table-wrap">
              <table class="table ad-table">
                <thead><tr><th>Class</th><th class="num">Your mix</th><th class="num">Avg</th><th class="num">Typical</th><th class="num">Swing ±</th></tr></thead>
                <tbody>
                  @for (s of d.segments; track s.key) {
                    <tr [class.ad-zero]="!s.weight_pct">
                      <td>{{ s.label }}@if (s.source !== 'default') { <small class="ad-src">{{ s.source }}</small> }@if (s.capped) { <small class="ad-src">capped</small> }</td>
                      <td class="num">{{ fmt(s.weight_pct) }}%</td><td class="num">{{ fmt(s.return_pct) }}%</td>
                      <td class="num">{{ fmt(s.typical_pct) }}%</td><td class="num">{{ fmt(s.volatility_pct) }}%</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="ad-meta">Inflation {{ fmt(d.inflation_pct) }}% a year · risk-free rate {{ fmt(d.risk_free_pct) }}%.
              "Typical" is the median year; "avg" is pulled up by the best years.</p>
          </section>

          <section class="ad-sec">
            <h3>How classes move together</h3>
            <p class="ad-meta">{{ d.corr.note }}</p>
            <details class="ad-corr">
              <summary>Show the correlation table</summary>
              <div class="table-wrap">
                <table class="table ad-matrix">
                  <thead><tr><th></th>@for (l of d.corr.labels; track $index) { <th class="num" [attr.title]="l">{{ short(l) }}</th> }</tr></thead>
                  <tbody>
                    @for (row of d.corr.matrix; track $index; let i = $index) {
                      <tr><th scope="row">{{ d.corr.labels[i] }}</th>@for (v of row; track $index) { <td class="num">{{ v.toFixed(2) }}</td> }</tr>
                    }
                  </tbody>
                </table>
              </div>
            </details>
          </section>

          @if (honesty().length || d.honesty['disclaimer']) {
            <section class="ad-sec">
              <h3>How forecasts are labelled</h3>
              <dl class="ad-honesty">
                @for (h of honesty(); track h.key) { <div><dt>{{ h.label }}</dt><dd>{{ h.text }}</dd></div> }
              </dl>
              @if (d.honesty['disclaimer']) { <p class="ad-meta">{{ d.honesty['disclaimer'] }}</p> }
            </section>
          }
          <p class="ad-meta">{{ d.note }}</p>
        } @else if (error()) {
          <div class="notice bad" role="alert"><app-icon name="alert" [size]="16" />
            <span>Couldn't load the assumptions. {{ error() }} <button type="button" class="btn sm" (click)="load()">Retry</button></span></div>
          @if (block(); as b) { <p class="ad-meta">This card used: {{ b.text || b.chip }} · Book #{{ b.hash }}</p> }
        } @else {
          <div aria-busy="true" aria-label="Loading the assumptions">
            <div class="skeleton" style="height:44px"></div>
            <div class="skeleton" style="height:90px;margin-top:14px"></div>
            <div class="skeleton" style="height:220px;margin-top:14px"></div>
          </div>
        }
      </div>

      <footer class="ad-foot">
        <a routerLink="/risk" fragment="profile" (click)="closed.emit()">Change the mix <app-icon name="chevronRight" [size]="14" /></a>
      </footer>
    </aside>`,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 950; display: block; }
    .ad-scrim { position: absolute; inset: 0; background: var(--drawer-scrim); }
    .ad-sheet { position: absolute; top: 0; right: 0; bottom: 0; width: min(var(--drawer-w), 100vw); display: flex; flex-direction: column;
      background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow-pop); outline: none; }
    .ad-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
    .ad-head h2 { font-size: var(--t-stat); }
    .ad-head small { display: block; font-size: var(--t-meta); color: var(--muted); }
    .ad-body { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 18px; }
    .ad-sec { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .ad-sec h3 { font-size: var(--t-label); font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    .ad-chip { display: inline-flex; align-items: center; gap: 8px; align-self: flex-start; padding: 6px 12px; border-radius: 999px;
      background: var(--chip-bg); color: var(--chip-fg); font-size: var(--t-meta); font-weight: 600; }
    .ad-meta { margin: 0; font-size: var(--t-label); color: var(--muted); }
    .ad-meta code { font-size: inherit; }
    .ad-stale { margin: 0; }
    .ad-bands { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .ad-bands li { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: var(--t-meta); }
    .ad-bands b { min-width: 92px; font-weight: 600; }
    .ad-table td small.ad-src { margin-left: 6px; font-size: 11px; color: var(--muted); }
    .ad-table tr.ad-zero td { color: var(--muted); }
    .ad-corr summary { cursor: pointer; font-size: var(--t-meta); font-weight: 600; color: var(--text-2); }
    .ad-matrix { font-size: var(--t-label); }
    .ad-matrix th[scope=row] { white-space: nowrap; font-weight: 500; }
    .ad-honesty { margin: 0; display: flex; flex-direction: column; gap: 6px; }
    .ad-honesty div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 8px; font-size: var(--t-meta); }
    .ad-honesty dt { color: var(--muted); }
    .ad-honesty dd { margin: 0; }
    .ad-foot { padding: 12px 20px; border-top: 1px solid var(--border); }
    .ad-foot a { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; }
    @media (max-width: 560px) {
      .ad-sheet { top: auto; left: 0; width: 100%; max-height: 92vh; border-left: 0; border-radius: 14px 14px 0 0; }
      .ad-honesty div { grid-template-columns: minmax(0, 1fr); gap: 0; }
    }
  `],
})
export class AssumptionsDrawerComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);

  /** The chip that opened the drawer, so a card built on an older Book can say so. */
  readonly block = input<ChipBlock | null>(null);
  readonly closed = output<void>();

  readonly data = signal<AssumptionsView | null>(null);
  readonly error = signal<string | null>(null);
  private sheet = viewChild<ElementRef<HTMLElement>>('sheet');
  private seq = 0;
  private prevOverflow = '';

  readonly honesty = computed(() => {
    const h = this.data()?.honesty ?? {};
    // a label still holding a {template} placeholder (an older server) is left out rather than printed raw
    return Object.entries(h).filter(([k, v]) => k !== 'disclaimer' && typeof v === 'string' && v && !/[{}]/.test(v))
      .map(([key, text]) => ({ key, label: HONESTY_LABEL[key] ?? key, text: text as string }));
  });

  ngOnInit() {
    this.prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setTimeout(() => this.sheet()?.nativeElement.focus());
    void this.load();
  }

  ngOnDestroy() { document.body.style.overflow = this.prevOverflow; }

  @HostListener('document:keydown.escape') onEsc() { this.closed.emit(); }

  /** One fetch per open (and per Retry). */
  async load() {
    const mine = ++this.seq;
    this.error.set(null);
    try {
      const d = await firstValueFrom(this.api.assumptions());
      if (mine === this.seq) this.data.set(d);
    } catch (e) {
      if (mine === this.seq) this.error.set(errorMessage(e));
    }
  }

  fmt(v: number | null | undefined): string { return v === null || v === undefined ? '—' : (Math.round(v * 10) / 10).toFixed(1); }
  /** Column heads for the matrix: the first word ("Equity", "Mutual", ...) keeps it narrow; the title has the full name. */
  short(l: string): string {
    const m = /\(([^)]+)\)/.exec(l);
    const first = l.split(/[\s(]/)[0];
    return m ? `${first.slice(0, 3)} ${m[1].slice(0, 5)}` : first.slice(0, 8);
  }
}
