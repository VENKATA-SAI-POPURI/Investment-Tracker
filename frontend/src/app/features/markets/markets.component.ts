import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged, firstValueFrom, switchMap, of, catchError } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, relTime, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { MarketAlert, MarketIdea, MarketOverview, SignalKey, SymbolHit, WatchItem } from '../../core/models';
import { readSnapshot, snapshotKey, writeSnapshot } from '../../core/snapshot';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { NeedsAttentionComponent } from '../../shared/priority/needs-attention.component';
import { ConfirmService, ModalComponent } from '../../shared/ui';
import { IposComponent } from './ipos.component';
import { StatusBadgeComponent } from '../../shared/priority/status-badge.component';
import { ChgComponent, RangeBarComponent, SIGNAL_TONE, SignalChipsComponent, SparkComponent, marketBannerMode, marketBannerSource, marketBannerText } from './market-parts';

export type MarketTab = 'today' | 'ideas' | 'watchlist';
const TABS: { key: MarketTab; label: string; icon: string }[] = [
  { key: 'today', label: 'Today', icon: 'zap' },
  { key: 'ideas', label: 'Ideas', icon: 'bulb' },
  { key: 'watchlist', label: 'Watchlist & IPOs', icon: 'star' },
];
/** `?tab=` values this page understands. IPOs live on the watchlist tab; older links and IPO reminders still say `ipos`. */
const TAB_ALIASES: Record<string, MarketTab> = { today: 'today', ideas: 'ideas', watchlist: 'watchlist', ipos: 'watchlist' };

/**
 * The tab a `?tab=` value opens. No value, an unknown value or the retired `performance` tab open Today
 * (the route itself sends `?tab=performance` to /performance; this only covers state reached directly).
 */
export function marketTab(v: string | null | undefined): MarketTab {
  return (v && Object.prototype.hasOwnProperty.call(TAB_ALIASES, v) ? TAB_ALIASES[v] : null) ?? 'today';
}

/** Local calendar date (YYYY-MM-DD) of a UTC ISO timestamp, so "today" means the viewer's day, not UTC's. */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const LENSES: { title: string; hint: string; lists: { key: SignalKey; label: string; hint: string }[] }[] = [
  { title: 'Momentum', hint: 'Follows the trend: what keeps rising, what keeps falling',
    lists: [{ key: 'momentum_buy', label: 'Rising strongly', hint: 'Up over the month and still up this week — consider buying' },
            { key: 'momentum_sell', label: 'Falling steadily', hint: 'Down over the month and this week — consider exiting' }] },
  { title: 'Dip & reversal', hint: 'Looks for turns: falls that are bouncing, runs that are cooling',
    lists: [{ key: 'dip_buy', label: 'Bouncing after a fall', hint: 'Down sharply over the month, up this week — possible entry' },
            { key: 'profit_book', label: 'Cooling after a run', hint: 'Up sharply over the month, slipping this week — consider booking profit' }] },
];

/**
 * Markets (Part 1 §5.12): market context, not a verdict on your plan.
 * Head → [crash/correction banner, P1.12, only when `market_state.mode` is correction or crash] → T0 (Nifty 50 hero + breadth, your stocks today, alerts today; the same on every tab) →
 * T1 "Needs attention here" (`market:` actions) → tabs Today | Ideas | Watchlist & IPOs, synced to `?tab=`.
 * Your returns against the index live on /performance (head chip).
 */
@Component({
  selector: 'app-markets',
  standalone: true,
  imports: [FormsModule, DecimalPipe, RouterLink, IconComponent, ModalComponent, IposComponent, NeedsAttentionComponent, SparkComponent,
    RangeBarComponent, SignalChipsComponent, ChgComponent, StatusBadgeComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>Markets</h1>
          <p class="sub">Today's moves across the Nifty 200, ideas from price patterns, and your watchlist
            @if (data(); as d) { · prices updated {{ rel(d.as_of) }} }
            @if (stale()) { · <span class="warn-text">couldn't refresh, showing saved prices</span> }</p></div>
        <div class="row wrap">
          <a class="btn ghost sm" routerLink="/performance">→ Your performance</a>
          <a class="btn ghost sm" routerLink="/settings" fragment="alerts"><app-icon name="bell" [size]="15" /> Alerts {{ data()?.alerts_config?.enabled === false ? 'off' : 'on' }}</a>
          @if (auth.canWrite()) { <button class="btn sm" (click)="openWatch()"><app-icon name="star" [size]="15" /> Add to watchlist</button> }
        </div>
      </div>

      <!-- P1.12: the crash/correction banner sits above T0 (§5.12, K18). Context, never 'act' (§1.6); built from the loaded payload only. -->
      @if (banner(); as bn) {
        <section class="card verdict mkt-banner" id="market-state" data-status="watch" role="status" aria-labelledby="mkt-banner-h">
          <header class="v-head">
            <h2 id="mkt-banner-h">{{ bn.title }}</h2>
            <app-status status="watch" />
          </header>
          <p class="v-sentence mb-line">{{ bn.text }}</p>
          @if (bn.playbook.length) {
            <button type="button" class="btn ghost sm mb-toggle" (click)="bookOpen.set(!bookOpen())" [attr.aria-expanded]="bookOpen()" aria-controls="mkt-playbook">
              <app-icon [name]="bookOpen() ? 'chevronDown' : 'chevronRight'" [size]="13" /> {{ bookOpen() ? 'Hide the playbook' : 'The calm playbook · ' + bn.playbook.length + ' steps' }}</button>
            <ul class="mb-book" id="mkt-playbook" [class.open]="bookOpen()" aria-label="The calm playbook">
              @for (l of bn.playbook; track $index) { <li>{{ l }}</li> }
            </ul>
          }
          <div class="mb-foot">
            <small class="muted">{{ bn.source }}</small>
            <a class="mb-link" routerLink="/performance">Your performance →</a>
          </div>
        </section>
      }

      <!-- T0: the same four numbers on every tab -->
      @if (data(); as d) {
        <section class="kpis" aria-label="Market today">
          <div class="kpi hero">
            <span class="label">{{ d.index.name || 'Nifty 50' }}</span>
            <span class="value">{{ d.index.metrics ? (d.index.metrics.price | number: '1.0-0') : '—' }}</span>
            @if (nifty(); as n) {
              <span class="meta pills"><span class="pill">{{ n.m.d1 | pct }} today</span>
                <span>{{ n.m.w1 | pct }} week</span><span>{{ n.m.m1 | pct }} month</span></span>
              <span class="meta hero-verdict"><app-icon [name]="n.icon" [size]="13" /> {{ n.line }}</span>
            } @else {
              <span class="meta hero-verdict"><app-icon name="info" [size]="13" /> The index price isn't available right now.</span>
            }
            <button type="button" class="more-btn" (click)="moreStats.set(!moreStats())" [attr.aria-expanded]="moreStats()">
              {{ moreStats() ? 'Less' : 'More' }} <app-icon [name]="moreStats() ? 'chevronDown' : 'chevronRight'" [size]="12" /></button>
          </div>
          <div class="kpi"><span class="chip green sm"><app-icon name="trend" [size]="15" /></span><span class="label">Market breadth</span>
            @if (d.breadth.total) {
              <span class="value"><span class="pos">{{ d.breadth.up }}</span> <small>up</small> <span class="neg">{{ d.breadth.down }}</span> <small>down</small></span>
              <span class="meta">of {{ d.breadth.total }} stocks today</span>
            } @else { <span class="value">—</span><span class="meta">No prices for today yet</span> }</div>
          <div class="kpi"><span class="chip violet sm"><app-icon name="wallet" [size]="15" /></span><span class="label">Your stocks today</span>
            <span class="value" [class]="mine().d1 | sign">{{ mine().d1 | pct: 2 }}</span>
            <span class="meta">@if (mine().count) { {{ mine().count }} stock{{ mine().count === 1 ? '' : 's' }} & ETFs, by value · {{ mine().w1 | pct }} this week }
              @else if (d.holdings.length) { No live prices for your stocks yet }
              @else { No Indian stocks or ETFs held }</span></div>
          <div class="kpi extra" [class.show]="moreStats()"><span class="chip amber sm"><app-icon name="bell" [size]="15" /></span><span class="label">Alerts today</span>
            <span class="value">{{ todayAlerts() }}</span>
            <span class="meta">@if (d.alerts_config.enabled === false) { Alerts are off }
              @else { Moves of {{ d.alerts_config.day }}%+ in a day, {{ d.alerts_config.week }}%+ in a week }</span></div>
        </section>
      } @else if (error()) {
        <div class="notice bad" role="alert"><app-icon name="alert" [size]="16" /> <div>Market prices couldn't load: {{ error() }} <button class="btn sm" (click)="load()">Retry</button></div></div>
      } @else {
        <div class="skeleton" style="height:128px;border-radius:14px" aria-label="Loading market prices"></div>
      }

      <!-- T1: market actions (none exist before P2, so this renders nothing for now) -->
      <app-needs-attention [prefixes]="['/markets']" [ids]="['market:']" />

      <div class="tabs" role="tablist" aria-label="Markets sections">
        @for (t of tabs; track t.key) {
          <button role="tab" [class.on]="tab() === t.key" [attr.aria-selected]="tab() === t.key" (click)="setTab(t.key)">
            <app-icon [name]="t.icon" [size]="14" /> {{ t.label }}
            @if (t.key === 'watchlist' && data()?.watchlist?.length) { <span class="muted">{{ data()!.watchlist.length }}</span> }
          </button>
        }
      </div>

      @switch (tab()) {
        @case ('today') {
          @if (data(); as d) {
            <section class="card flush">
              <div class="card-head"><div><h2>Your stocks and ETFs</h2><span class="hint">Live prices; rows that moved past your alert level are highlighted</span></div>
                <div class="seg"><button [class.on]="holdSort() === 'weight'" (click)="holdSort.set('weight')">By size</button>
                  <button [class.on]="holdSort() === 'move'" (click)="holdSort.set('move')">Biggest moves</button></div></div>
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Holding</th><th class="num">Price</th><th class="num">Today</th><th class="num hide-sm">1 week</th><th class="num hide-sm">1 month</th>
                    <th class="hide-sm">Month's range</th><th class="hide-sm">Trend</th><th class="hide-sm">Signal</th><th class="num hide-sm">Weight</th></tr></thead>
                  <tbody>
                    @for (h of holdings(); track h.id) {
                      <tr class="clickable" [class.hot]="hot(h.metrics)" (click)="go('/holding/' + h.id)">
                        <td class="name-cell"><a class="nm-link" [routerLink]="['/holding', h.id]" (click)="$event.stopPropagation()">{{ h.name }}</a>
                          <div class="sub">{{ h.symbol }}{{ h.gain_pct !== null ? ' · ' + (h.gain_pct | pct) + ' on cost' : '' }}</div>
                          @if (h.signals.length) { <app-signal-chips class="sm-only" [signals]="h.signals" /> }</td>
                        <td class="num">{{ h.metrics ? (h.metrics.price | inr: 2) : '—' }}</td>
                        <td class="num"><app-chg [v]="h.metrics?.d1" /></td><td class="num hide-sm"><app-chg [v]="h.metrics?.w1" /></td>
                        <td class="num hide-sm"><app-chg [v]="h.metrics?.m1" /></td>
                        <td class="hide-sm"><app-range-bar [m]="h.metrics" /></td>
                        <td class="hide-sm"><app-spark [values]="h.metrics?.spark ?? []" /></td>
                        <td class="hide-sm"><app-signal-chips [signals]="h.signals" empty="—" /></td>
                        <td class="num hide-sm">{{ h.weight | pct: 1 : false }}</td>
                      </tr>
                    } @empty { <tr><td colspan="9"><div class="empty">No Indian stocks or ETFs held yet. Market moves still show below.</div></td></tr> }
                  </tbody>
                </table>
              </div>
            </section>

            <div class="duo">
              <section class="card">
                <div class="card-head"><h2>Top movers</h2>
                  <div class="seg"><button [class.on]="moverRange() === 'day'" (click)="moverRange.set('day')">Today</button>
                    <button [class.on]="moverRange() === 'week'" (click)="moverRange.set('week')">This week</button></div></div>
                <div class="movers">
                  @for (side of sides; track side) {
                    <div><small class="muted">{{ side === 'up' ? 'Gainers' : 'Losers' }}</small>
                      @for (m of d.movers[moverRange()][side]; track m.symbol) {
                        <div class="mv"><span class="ellipsis">{{ m.name }}@if (m.held) { <span class="badge sm">held</span> }</span>
                          <app-chg [v]="moverRange() === 'day' ? m.metrics.d1 : m.metrics.w1" /></div>
                      } @empty { <div class="empty small">No prices yet.</div> }
                    </div>
                  }
                </div>
              </section>
              <section class="card">
                <div class="card-head"><div><h2>Recent alerts</h2><span class="hint">Last two weeks</span></div></div>
                @for (a of alerts().slice(0, 8); track a.id) {
                  <a class="al" [routerLink]="a.link || '/markets'"><app-icon [name]="a.kind === 'target' ? 'target' : a.severity === 'warning' ? 'arrowDown' : 'arrowUp'" [size]="14"
                      [class]="a.kind === 'target' ? '' : a.severity === 'warning' ? 'neg' : 'pos'" />
                    <span><b>{{ a.title }}</b><small>{{ a.body }}</small></span><small class="muted">{{ rel(a.created_at) }}</small></a>
                } @empty { <div class="empty small">No alerts yet. They appear when a holding moves {{ d.alerts_config.day }}% in a day or {{ d.alerts_config.week }}% in a week, or a watchlist price is reached.</div> }
              </section>
            </div>

            @if (d.sectors.length) {
              <section class="card">
                <div class="card-head"><div><h2>Sector heat</h2><span class="hint">Average move of Nifty 200 stocks in each industry, over the month (bar) and the week</span></div></div>
                <div class="heat">
                  @for (s of d.sectors; track s.industry) {
                    <div class="hr"><span class="ellipsis">{{ s.industry }} <small class="muted">{{ s.count }}</small></span>
                      <span class="bar"><i [class.neg]="s.m1 < 0" [style.width.%]="heatWidth(s.m1)" [style.left.%]="s.m1 < 0 ? 50 - heatWidth(s.m1) : 50"></i></span>
                      <span class="num" [class]="s.m1 | sign">{{ s.m1 | pct }}</span><span class="num small muted hide-sm">{{ s.w1 | pct }} wk</span></div>
                  }
                </div>
              </section>
            }
          } @else if (!error()) {
            <div class="skeleton" style="height:280px;border-radius:14px"></div>
            <div class="duo"><div class="card"><div class="skeleton" style="height:240px"></div></div><div class="card"><div class="skeleton" style="height:240px"></div></div></div>
          }
        }

        @case ('ideas') {
          @if (data(); as d) {
            <div class="notice"><app-icon name="info" [size]="16" /> <span>These are price patterns, not forecasts. They come only from price movement over the last week and month across {{ d.covered }} Nifty 200 stocks. They're prompts to look closer, not research or advice — check the business, valuation and your own plan before acting.</span></div>
            <div class="lenses">
              @for (lens of lenses; track lens.title) {
                <section class="card">
                  <div class="card-head"><div><h2>{{ lens.title }}</h2><span class="hint">{{ lens.hint }}</span></div></div>
                  @for (l of lens.lists; track l.key) {
                    <h3 class="lh"><span class="badge" [class]="tone[l.key]">{{ l.label }}</span><small class="muted">{{ l.hint }}</small></h3>
                    @for (i of d.ideas[l.key].slice(0, 8); track i.symbol) {
                      <div class="idea">
                        <span class="nm"><b class="ellipsis">{{ i.name }}</b><small class="muted ellipsis">{{ i.industry }}@if (i.held) { · <b>you hold this</b> }</small></span>
                        <app-spark [values]="i.metrics.spark" [w]="56" />
                        <span class="num small nowrap">{{ i.metrics.w1 | pct }} <small class="muted">wk</small></span>
                        <span class="num small nowrap">{{ i.metrics.m1 | pct }} <small class="muted">mo</small></span>
                        @if (auth.canWrite()) {
                          @if (i.watching) { <span class="badge sm" title="On your watchlist"><app-icon name="star" [size]="11" /></span> }
                          @else { <button class="btn ghost sm icon" (click)="quickWatch(i)" [title]="'Add ' + i.name + ' to watchlist'" [attr.aria-label]="'Watch ' + i.name"><app-icon name="star" [size]="14" /></button> }
                        } @else { <span></span> }
                      </div>
                    } @empty { <div class="empty small">Nothing meets this right now.</div> }
                  }
                </section>
              }
            </div>

            <section class="card">
              <div class="card-head"><div><h2>Rebalancing with the signals</h2>
                <span class="hint">Where your target allocation and the price signals point the same way · <a routerLink="/risk" fragment="rebalance">full rebalancing planner →</a></span></div></div>
              @if (d.rebalance.has_targets) {
                <div class="drifts">
                  @for (s of d.rebalance.segments; track s.segment) {
                    <div class="dr"><span>{{ s.segment }}</span><span class="num small">{{ s.pct | pct: 1 : false }} <small class="muted">/ {{ s.target }}%</small></span>
                      <span class="chg" [class.neg]="s.drift >= 2.5" [class.pos]="s.drift <= -2.5">{{ s.drift > 0 ? '+' : '' }}{{ s.drift.toFixed(1) }} pts</span></div>
                  }
                </div>
              } @else { <p class="small muted">Set a target allocation in <a routerLink="/settings">Settings</a> to see which asset classes are over or under target.</p> }
              <div class="trio">
                <div><h3 class="lh"><span class="badge warn">Consider trimming</span></h3>
                  @for (h of d.rebalance.trim; track h.id) { <a class="ri" [routerLink]="['/holding', h.id]"><b>{{ h.name }}</b><small>{{ h.why }} · {{ h.weight | pct: 1 : false }} of portfolio</small></a> }
                  @empty { <p class="small muted">No holding is flashing a sell signal.</p> }</div>
                <div><h3 class="lh"><span class="badge good">Consider adding</span></h3>
                  @for (h of d.rebalance.add; track h.id) { <a class="ri" [routerLink]="['/holding', h.id]"><b>{{ h.name }}</b><small>{{ h.why }} · {{ h.weight | pct: 1 : false }} of portfolio</small></a> }
                  @empty { <p class="small muted">No holding is flashing a buy signal.</p> }</div>
                <div><h3 class="lh"><span class="badge info">New names to look at</span></h3>
                  @for (i of d.rebalance.new_ideas; track i.symbol) { <div class="ri"><b>{{ i.name }}</b><small>{{ i.title }} · {{ i.note }}</small></div> }
                  @empty { <p class="small muted">No fresh candidates today.</p> }</div>
              </div>
            </section>
          } @else if (!error()) {
            <div class="lenses"><div class="card"><div class="skeleton" style="height:320px"></div></div><div class="card"><div class="skeleton" style="height:320px"></div></div></div>
          }
        }

        @case ('watchlist') {
          @if (data(); as d) {
            <section class="card flush">
              <div class="card-head"><div><h2>Watchlist</h2><span class="hint">Set a buy or sell price and you'll get an alert when it's reached</span></div>
                @if (auth.canWrite()) { <button class="btn sm" (click)="openWatch()"><app-icon name="plus" [size]="14" /> Add</button> }</div>
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Stock</th><th class="num">Price</th><th class="num">Today</th><th class="num hide-sm">1 week</th><th class="num">1 month</th>
                    <th class="num hide-sm">Since added</th><th class="num">Buy at</th><th class="num">Sell at</th><th class="hide-sm">Signal</th><th><span class="sr-only">Edit</span></th></tr></thead>
                  <tbody>
                    @for (w of d.watchlist; track w.id) {
                      <tr [class.hot]="!!w.target_hit">
                        <td class="name-cell"><div style="font-weight:500">{{ w.name }}@if (w.held) { <span class="badge sm">held</span> }</div><div class="sub">{{ w.symbol }}{{ w.industry ? ' · ' + w.industry : '' }}{{ w.notes ? ' · ' + w.notes : '' }}</div></td>
                        <td class="num">{{ w.metrics ? (w.metrics.price | inr: 2) : '—' }}</td>
                        <td class="num"><app-chg [v]="w.metrics?.d1" /></td><td class="num hide-sm"><app-chg [v]="w.metrics?.w1" /></td><td class="num"><app-chg [v]="w.metrics?.m1" /></td>
                        <td class="num hide-sm"><app-chg [v]="w.since_added" /></td>
                        <td class="num">{{ w.target_buy ? (w.target_buy | inr: 2) : '—' }}@if (w.target_hit === 'buy') { <div><span class="badge good sm">reached</span></div> }</td>
                        <td class="num">{{ w.target_sell ? (w.target_sell | inr: 2) : '—' }}@if (w.target_hit === 'sell') { <div><span class="badge warn sm">reached</span></div> }</td>
                        <td class="hide-sm"><app-signal-chips [signals]="w.signals" empty="—" /></td>
                        <td class="num nowrap">@if (auth.canWrite()) {
                          <button class="btn ghost sm icon" (click)="openWatch(w)" [attr.aria-label]="'Edit ' + w.name"><app-icon name="edit" [size]="14" /></button>
                          <button class="btn ghost sm icon" (click)="removeWatch(w)" [attr.aria-label]="'Remove ' + w.name"><app-icon name="trash" [size]="14" /></button> }</td>
                      </tr>
                    } @empty { <tr><td colspan="10"><div class="empty">Nothing on your watchlist yet. Add stocks from here or with the star on the Ideas tab.</div></td></tr> }
                  </tbody>
                </table>
              </div>
            </section>
          } @else if (!error()) {
            <div class="card"><div class="skeleton" style="height:200px"></div></div>
          }
          <app-ipos />
        }
      }
    </div>

    @if (watchForm(); as f) {
      <app-modal [title]="f.id ? 'Edit ' + f.name : 'Add to watchlist'" [width]="480" (close)="watchForm.set(null)">
        <div class="form">
          @if (!f.id) {
            <div class="field"><label for="w-sym">Stock</label>
              <input id="w-sym" class="input" [(ngModel)]="f.query" (ngModelChange)="search$.next($event)" placeholder="Name or NSE symbol, e.g. TCS" autocomplete="off" />
              @if (hits().length && !f.symbol) {
                <div class="hits">@for (h of hits(); track h.symbol) { <button type="button" (click)="pick(h)"><b>{{ h.symbol }}</b> <span class="muted">{{ h.name }} · {{ h.exchange }}</span></button> }</div>
              }
              @if (f.symbol) { <span class="hint">{{ f.symbol }} · {{ f.name }} <button type="button" class="btn ghost sm" (click)="f.symbol = ''">change</button></span> }
            </div>
          }
          <div class="cols">
            <div class="field"><label for="w-buy">Alert me to buy at (₹)</label><input id="w-buy" class="input num" type="number" min="0" step="0.05" [(ngModel)]="f.target_buy" /></div>
            <div class="field"><label for="w-sell">Alert me to sell at (₹)</label><input id="w-sell" class="input num" type="number" min="0" step="0.05" [(ngModel)]="f.target_sell" /></div>
          </div>
          <div class="field"><label for="w-notes">Notes</label><input id="w-notes" class="input" [(ngModel)]="f.notes" placeholder="Why you're watching it" /></div>
          @if (formError()) { <div class="notice bad">{{ formError() }}</div> }
          <div class="form-actions"><button class="btn" (click)="watchForm.set(null)">Cancel</button>
            <button class="btn primary" (click)="saveWatch()" [disabled]="saving() || (!f.id && !f.symbol && !f.query)">{{ saving() ? 'Saving…' : 'Save' }}</button></div>
        </div>
      </app-modal>
    }
  `,
  styles: [`
    .tabs button { display: inline-flex; align-items: center; gap: 6px; }
    /* P1.12 banner: the global .verdict stripe (data-status=watch) plus a list; copied rules only, styles.scss untouched (H19) */
    .mkt-banner { min-height: 0; }
    .mkt-banner .mb-line { margin: 0; color: var(--text); }
    .mb-book { margin: 2px 0 0; padding-left: 20px; font-size: 13.5px; color: var(--text-2); }
    .mb-book li { margin-bottom: 4px; }
    .mb-toggle { display: none; align-self: flex-start; padding-left: 0; }
    .mb-foot { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; }
    .mb-foot small { font-size: 12px; }
    .mb-link { font-size: 13px; font-weight: 500; white-space: nowrap; }
    .warn-text { color: var(--warn); }
    .kpi.hero .pills { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 2px; }
    .kpi.hero .hero-verdict { display: flex; align-items: flex-start; gap: 6px; margin-top: 4px; color: rgba(255, 255, 255, .85); }
    .kpi.hero .hero-verdict app-icon { flex: none; margin-top: 1px; }
    .kpis .value small { font-size: 12px; font-weight: 500; color: rgba(255, 255, 255, .6); }
    .kpis .value .pos { color: #6ee7b7; }
    .kpis .value .neg { color: #fca5a5; }
    .more-btn { display: none; align-self: flex-start; align-items: center; gap: 2px; margin-top: 6px; padding: 0; border: 0; background: none;
      color: var(--gold-2); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
    tr.hot td { background: color-mix(in srgb, var(--warn-soft) 60%, transparent); }
    .nm-link { color: var(--text); font-weight: 500; text-decoration: none; }
    .nm-link:hover { text-decoration: underline; }
    .movers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .sm-only { display: none; margin-top: 4px; }
    .mv { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .mv:last-child { border-bottom: 0; }
    .badge.sm { padding: 0 6px; font-size: 10.5px; margin-left: 4px; }
    .al { display: grid; grid-template-columns: 18px 1fr auto; gap: 10px; align-items: start; padding: 8px 0; border-bottom: 1px solid var(--border); color: var(--text); text-decoration: none; font-size: 13px; }
    .al:last-child { border-bottom: 0; }
    .al span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .al span small { color: var(--muted); font-size: 12px; }
    .heat { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 4px 28px; }
    .hr { display: grid; grid-template-columns: minmax(0, 1.4fr) 1fr 56px 62px; gap: 10px; align-items: center; padding: 5px 0; font-size: 13px; }
    .bar { position: relative; height: 8px; border-radius: 4px; background: var(--surface-2); }
    .bar::after { content: ''; position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: var(--border-strong); }
    .bar i { position: absolute; top: 0; bottom: 0; border-radius: 4px; background: var(--pos); }
    .bar i.neg { background: var(--neg); }
    .lh { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 13px; font-weight: 500; margin: 14px 0 6px; }
    .lh:first-of-type { margin-top: 0; }
    .lenses { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; align-items: start; }
    .idea { display: grid; grid-template-columns: minmax(0, 1fr) 56px 78px 78px 30px; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .idea .nm { display: flex; flex-direction: column; min-width: 0; }
    .idea .nm small { font-size: 11.5px; }
    .btn.icon { width: 28px; padding: 0; justify-content: center; }
    .drifts { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-bottom: 14px; }
    .dr { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; }
    .trio { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
    .ri { display: flex; flex-direction: column; gap: 2px; padding: 7px 0; border-bottom: 1px solid var(--border); color: var(--text); text-decoration: none; font-size: 13px; }
    .ri small { color: var(--muted); font-size: 12px; }
    .hits { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; margin-top: 4px; max-height: 220px; overflow: auto; }
    .hits button { text-align: left; padding: 8px 10px; border: 0; background: none; cursor: pointer; font: inherit; font-size: 13px; }
    .hits button:hover { background: var(--surface-2); }
    .nowrap { white-space: nowrap; }
    @media (max-width: 900px) {
      .lenses { grid-template-columns: minmax(0, 1fr); } .trio { grid-template-columns: minmax(0, 1fr); } .heat { grid-template-columns: minmax(0, 1fr); }
      /* the hero spans the first row, so the two tiles under it pair up and the third takes its own row */
      .kpis .kpi:nth-child(2) { border-left: 0; }
      .kpis .kpi:nth-child(3) { border-left: 1px solid rgba(255, 255, 255, .09); }
      .kpis .kpi.extra { grid-column: span 2; border-left: 0; }
    }
    @media (max-width: 760px) {
      .sm-only { display: inline-flex; }
      /* phones keep T0 near the top: the five playbook lines wait behind one toggle (§1.5) */
      .mb-toggle { display: inline-flex; }
      .mb-book:not(.open) { display: none; }
      /* ≤2 hero stats on phones (§1.5); the third waits behind More */
      .kpis .kpi.extra:not(.show) { display: none; }
      .more-btn { display: inline-flex; }
    }
    @media (max-width: 560px) { .movers { grid-template-columns: minmax(0, 1fr); } .idea { grid-template-columns: minmax(0, 1fr) 70px 70px 30px; } .idea app-spark { display: none; } .hr { grid-template-columns: minmax(0, 1fr) 80px 52px; } }
  `],
})
export class MarketsComponent {
  auth = inject(AuthService);
  private store = inject(StoreService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  tabs = TABS;
  lenses = LENSES;
  tone = SIGNAL_TONE;
  sides = ['up', 'down'] as const;
  tab = signal<MarketTab>(marketTab(this.route.snapshot.queryParamMap.get('tab')));
  data = signal<MarketOverview | null>(null);
  alerts = signal<MarketAlert[]>([]);
  error = signal<string | null>(null);
  /** The last refresh failed while saved prices were on screen. */
  stale = signal(false);
  moreStats = signal(false);
  holdSort = signal<'weight' | 'move'>('weight');
  moverRange = signal<'day' | 'week'>('day');
  /** Phones: the banner's playbook list is open. */
  bookOpen = signal(false);

  watchForm = signal<{ id?: number; query: string; symbol: string; name: string; target_buy: number | null; target_sell: number | null; notes: string } | null>(null);
  hits = signal<SymbolHit[]>([]);
  saving = signal(false);
  formError = signal<string | null>(null);
  search$ = new Subject<string>();
  private paintedFor: string | null = null;

  holdings = computed(() => {
    const h = [...(this.data()?.holdings ?? [])];
    return this.holdSort() === 'move' ? h.sort((a, b) => Math.abs(b.metrics?.d1 ?? 0) - Math.abs(a.metrics?.d1 ?? 0)) : h;
  });
  /** Value-weighted change of the stocks and ETFs tracked here. */
  mine = computed(() => {
    const h = (this.data()?.holdings ?? []).filter(x => x.metrics);
    const tot = h.reduce((a, x) => a + x.value, 0) || 1;
    const avg = (f: 'd1' | 'w1') => h.reduce((a, x) => a + (x.metrics![f] ?? 0) * x.value, 0) / tot;
    return { count: h.length, d1: h.length ? avg('d1') : null, w1: h.length ? avg('w1') : null };
  });
  /** Alerts raised on the viewer's calendar day (timestamps are UTC). */
  todayAlerts = computed(() => {
    const day = today();
    return this.alerts().filter(a => localDay(a.created_at) === day).length;
  });
  /**
   * P1.12 banner (K18): shown only in correction or crash, read from the `/markets` payload already on screen (no price call).
   * Line 1 is `marketBannerText`, the backend's `markets.context_line` word for word; then the fixed playbook and the source.
   */
  banner = computed(() => {
    const s = this.data()?.market_state ?? null;
    const mode = marketBannerMode(s);
    const text = marketBannerText(s);
    if (!s || !mode || !text) return null;
    return { mode, text, playbook: s.playbook ?? [], source: marketBannerSource(s),
      title: mode === 'crash' ? 'The market has fallen sharply' : 'The market is in a correction' };
  });
  /** The hero's verdict line: today's direction and where the index sits against its month's high. Facts only, no forecast. */
  nifty = computed(() => {
    const m = this.data()?.index.metrics ?? null;
    if (!m) return null;
    const d1 = m.d1;
    const flat = d1 === null || Math.abs(d1) < 0.05;
    const icon = flat ? 'info' : d1! > 0 ? 'arrowUp' : 'arrowDown';
    const day = d1 === null ? 'No move reported today' : flat ? 'Flat today' : `${d1 > 0 ? 'Up' : 'Down'} ${Math.abs(d1).toFixed(1)}% today`;
    const fromHigh = m.high_1m > 0 ? (m.price / m.high_1m - 1) * 100 : null;
    const high = fromHigh === null ? '' : fromHigh > -0.5 ? 'near its high for the month' : `${Math.abs(fromHigh).toFixed(1)}% below this month's high`;
    return { m, icon, line: high ? `${day}, ${high}.` : `${day}.` };
  });

  constructor() {
    // follow ?tab= when it changes under a reused component (a bell link, the back button)
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(q => this.tab.set(marketTab(q.get('tab'))));
    effect(() => {
      const scope = this.store.scopeKey();
      this.store.version();
      if (!this.auth.token()) return;
      if (scope !== this.paintedFor) {
        // a new portfolio: paint what this device saw last time for it, then refresh
        this.paintedFor = scope;
        this.stale.set(false);
        this.data.set(readSnapshot<MarketOverview>(snapshotKey('markets', scope)));
      }
      queueMicrotask(() => this.load());
    });
    this.search$.pipe(debounceTime(250), distinctUntilChanged(),
      switchMap(q => q.trim().length < 2 ? of([]) : this.api.searchSymbols(q.trim(), 'equity').pipe(catchError(() => of([])))),
      takeUntilDestroyed())
      .subscribe(h => this.hits.set(h.filter(x => /\.(NS|BO)$/.test(x.symbol)).slice(0, 8)));
  }

  async load() {
    const scope = this.store.scopeKey();
    this.error.set(null);
    try {
      const [d, a] = await Promise.all([firstValueFrom(this.api.markets()), firstValueFrom(this.api.marketAlerts()).catch(() => [] as MarketAlert[])]);
      if (scope !== this.store.scopeKey()) return;
      this.data.set(d);
      this.alerts.set(a);
      this.stale.set(false);
      writeSnapshot(snapshotKey('markets', scope), d);
    } catch (e) {
      if (scope !== this.store.scopeKey()) return;
      if (this.data()) this.stale.set(true);
      else this.error.set(errorMessage(e));
    }
  }

  setTab(t: MarketTab) {
    this.tab.set(t);
    this.router.navigate([], { queryParams: { tab: t === 'today' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
  }
  go(path: string) { this.router.navigateByUrl(path); }
  rel(iso: string) { return relTime(iso); }
  hot(m: { d1: number | null; w1: number | null } | null) {
    const c = this.data()?.alerts_config;
    return !!(m && c && ((m.d1 !== null && Math.abs(m.d1) >= c.day) || (m.w1 !== null && Math.abs(m.w1) >= c.week)));
  }
  heatWidth(v: number) {
    const max = Math.max(...(this.data()?.sectors ?? []).map(s => Math.abs(s.m1)), 1);
    return Math.abs(v) / max * 50;
  }

  openWatch(w?: WatchItem) {
    this.formError.set(null);
    this.hits.set([]);
    this.watchForm.set(w ? { id: w.id, query: '', symbol: w.symbol, name: w.name, target_buy: w.target_buy, target_sell: w.target_sell, notes: w.notes ?? '' }
      : { query: '', symbol: '', name: '', target_buy: null, target_sell: null, notes: '' });
  }
  pick(h: SymbolHit) {
    const f = this.watchForm();
    if (f) { f.symbol = h.symbol; f.name = h.name; f.query = h.symbol; }
    this.hits.set([]);
  }
  async quickWatch(i: MarketIdea) {
    try {
      await firstValueFrom(this.api.addWatch({ symbol: i.symbol, name: i.name }));
      this.toast.ok(`${i.name} added to your watchlist`);
      await this.store.changed();
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
  async saveWatch() {
    const f = this.watchForm();
    if (!f) return;
    this.saving.set(true);
    this.formError.set(null);
    const body = { target_buy: f.target_buy || null, target_sell: f.target_sell || null, notes: f.notes };
    try {
      if (f.id) await firstValueFrom(this.api.updateWatch(f.id, body));
      else await firstValueFrom(this.api.addWatch({ ...body, symbol: f.symbol || f.query, name: f.name || undefined }));
      this.watchForm.set(null);
      this.toast.ok(f.id ? 'Watchlist updated' : 'Added to your watchlist');
      await this.store.changed();
    } catch (e) {
      this.formError.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }
  async removeWatch(w: WatchItem) {
    if (!await this.confirm.ask(`Remove ${w.name}?`, 'It comes off your watchlist and its price alerts stop.', 'Remove')) return;
    try {
      await firstValueFrom(this.api.deleteWatch(w.id));
      await this.store.changed();
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
}
