import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ActionService } from '../../core/action.service';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fmtDate, today } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Action, Brief, Health, Plan, Position, SegmentSummary, Status } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { EstTagComponent } from '../../shared/priority/est-tag.component';
import { RebalancePlannerComponent } from '../../shared/rebalance-planner.component';

/* ── Pure rules (mirroring `insights.py`, R17 step 3) ─────────────── */

/**
 * Concentration lines, exactly `insights.py`'s (W7 review fixes, amending R17's 12%): a holding opens a
 * `concentration:` action at 15% of the portfolio (a mutual fund at 25%, already diversified inside), and one the
 * action list already holds open or planned stays until it falls below the line − 3 (12%, a fund 22%). So every row
 * the review lists has an action step 5 can plan.
 */
export const REVIEW_CONCENTRATION_PCT = 15;
export const REVIEW_CONCENTRATION_MF_PCT = 25;
export const REVIEW_CONCENTRATION_HYSTERESIS = 3;
/** A laggard is down at least this much… */
export const REVIEW_LAGGARD_PCT = -20;
/** …after being held at least this long (days since `first_date`), as `insights.py`'s `loser:` rule. */
export const REVIEW_LAGGARD_DAYS = 180;
/** A winner is up at least this much and at least `REVIEW_WINNER_WEIGHT` of the portfolio (`insights.py` `winner:`). */
export const REVIEW_WINNER_PCT = 50;
export const REVIEW_WINNER_WEIGHT = 5;
/** Mix moves smaller than this (percentage points since the last review's snapshot) are not listed. */
export const REVIEW_MIX_MOVE_PTS = 1;
/** "Stocks and funds" (R17): the classes whose single holdings can be trimmed at will. */
const CONCENTRATION_CLASSES = new Set(['equity', 'mutual_fund', 'commodity']);

/** One row the review lists in steps 2 and 3. `actionId` is the server's id for the same finding (§8.3 catalogue). */
export interface ReviewItem {
  actionId: string;
  group: 'mix' | 'concentration' | 'laggard' | 'winner';
  name: string;
  /** "18.2% of the portfolio", "down 27% after 14 months", … */
  detail: string;
  link: string;
}

/** Whole days from `from` to `to` (ISO dates); positive when `to` is later. */
function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to.slice(0, 10) + 'T00:00:00').getTime() - new Date(from.slice(0, 10) + 'T00:00:00').getTime()) / 86400000);
}

/** The weight at which `insights.py` flags a holding: 15% (a fund 25%), or 3 points lower while its row is held open. */
export function concentrationLine(assetClass: string, heldOpen: boolean): number {
  const limit = assetClass === 'mutual_fund' ? REVIEW_CONCENTRATION_MF_PCT : REVIEW_CONCENTRATION_PCT;
  return heldOpen ? limit - REVIEW_CONCENTRATION_HYSTERESIS : limit;
}

/**
 * Step 3 (R17), from the store's positions, mirroring `insights.py`: open, non-cash holdings;
 * concentration = a stock or fund at or above `concentrationLine` (15%, a fund 25%; 12% / 22% when `heldIds`, the
 * open or planned action ids, already hold its `concentration:<id>`); laggard = `unrealized_pct` ≤ −20 and held
 * ≥ 180 days; otherwise winner = `unrealized_pct` ≥ 50 and weight ≥ 5%. Each row links `/holding/<id>`.
 */
export function reviewHoldings(positions: readonly Position[], todayIso: string, heldIds: ReadonlySet<string> = new Set()): { concentration: ReviewItem[]; laggards: ReviewItem[]; winners: ReviewItem[] } {
  const open = positions.filter(p => p.is_open && p.asset_class !== 'cash');
  const concentration = open
    .filter(p => CONCENTRATION_CLASSES.has(p.asset_class)
      && (p.weight || 0) >= concentrationLine(p.asset_class, heldIds.has(`concentration:${p.id}`)))
    .sort((a, b) => b.weight - a.weight)
    .map<ReviewItem>(p => ({ actionId: `concentration:${p.id}`, group: 'concentration', name: p.name,
      detail: `${p.weight.toFixed(1)}% of the portfolio`, link: `/holding/${p.id}` }));
  const laggards: (ReviewItem & { k: number })[] = [];
  const winners: (ReviewItem & { k: number })[] = [];
  for (const p of open) {
    const up = p.unrealized_pct;
    if (up === null || up === undefined || isNaN(up)) continue;
    const held = p.first_date ? daysBetween(p.first_date, todayIso) : 0;
    if (up <= REVIEW_LAGGARD_PCT && held >= REVIEW_LAGGARD_DAYS) {
      const months = Math.floor(held / 30);
      laggards.push({ actionId: `loser:${p.id}`, group: 'laggard', name: p.name, k: up, link: `/holding/${p.id}`,
        detail: `down ${Math.abs(up).toFixed(0)}% after ${months} month${months === 1 ? '' : 's'}` });
    } else if (up >= REVIEW_WINNER_PCT && (p.weight || 0) >= REVIEW_WINNER_WEIGHT) {
      winners.push({ actionId: `winner:${p.id}`, group: 'winner', name: p.name, k: -up, link: `/holding/${p.id}`,
        detail: `up ${up.toFixed(0)}%, now ${p.weight.toFixed(1)}% of the portfolio` });
    }
  }
  const strip = (xs: (ReviewItem & { k: number })[]) => xs.sort((a, b) => a.k - b.k).map(({ k: _k, ...r }) => r);
  return { concentration, laggards: strip(laggards), winners: strip(winners) };
}

/** A segment's share then (the review snapshot) and now, when it moved more than `minPts`. Biggest move first. */
export interface MixMove { segment: string; then: number; now: number; delta: number; }

/**
 * Step 1 (R17): `settings.reviewSnapshot` ({segment: pct}, written by POST /review/complete) against today's
 * segment %. A segment missing on one side counts as 0 there.
 */
export function mixMoves(snapshot: Record<string, number> | null | undefined, segments: readonly Pick<SegmentSummary, 'segment' | 'pct'>[],
  minPts = REVIEW_MIX_MOVE_PTS): MixMove[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const now = new Map(segments.map(s => [s.segment, s.pct || 0]));
  const keys = new Set([...Object.keys(snapshot), ...now.keys()]);
  const out: MixMove[] = [];
  for (const k of keys) {
    const t = Number(snapshot[k] ?? 0), n = now.get(k) ?? 0;
    if (!isFinite(t)) continue;
    const delta = Math.round((n - t) * 10) / 10;
    if (Math.abs(n - t) > minPts) out.push({ segment: k, then: t, now: n, delta });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/** The health score's status on the shared scale: Good and Excellent (≥ 70) good, Fair (≥ 55) watch, else act. */
export function healthStatus(score: number | null | undefined): Status {
  if (score === null || score === undefined || isNaN(score)) return 'unset';
  return score >= 70 ? 'good' : score >= 55 ? 'watch' : 'act';
}

/* ── Session-only state (the W5-F3 Undo pattern): survives leaving the tab, never the reload ── */

interface ReviewSession { step: number; ticked: string[]; dates: Record<string, string>; }
const SESSIONS = new Map<string, ReviewSession>();

export const REVIEW_STEPS = [
  { n: 1, label: 'What changed' },
  { n: 2, label: 'Mix' },
  { n: 3, label: 'Holdings' },
  { n: 4, label: 'Plan' },
  { n: 5, label: 'Commitments' },
  { n: 6, label: 'Complete' },
] as const;

/** ISO date `days` after today (local). */
function isoIn(days: number): string {
  const d = new Date(today() + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/**
 * The quarterly review (`/actions?tab=review`, SPEC Part 1 §5.1 Review row, P2.5, AMENDMENTS R17).
 *
 * Six steps with a step indicator (`aria-current="step"`), Back/Next and session-only state:
 * 1. What changed since `lastReviewDate`: `GET /brief?since=` `hero.since_last`, the mix against
 *    `settings.reviewSnapshot`, and `/plan` `deltas` (last 30 days). It never writes Home's brief snapshot (E20).
 * 2. Mix: the shared planner twice (no-sell, then Allow selling) with its existing inputs only.
 * 3. Concentration, laggards and winners from the store's positions (`reviewHoldings`).
 * 4. Plan: `/plan` `sip` (invested vs needed a month, and the gap).
 * 5. Commitments: ticked items with a matching open action are planned through ActionService; guests read only.
 * 6. Complete: POST /review/complete, `store.changed()`, a toast, and `closed`.
 *
 * Below the wizard, the check-up card reads `GET /pulse` `health` (score, grade, components as meters, focus);
 * a failed /pulse hides the card behind a one-line notice.
 */
@Component({
  selector: 'app-review',
  standalone: true,
  imports: [NgTemplateOutlet, FormsModule, RouterLink, IconComponent, EstTagComponent, RebalancePlannerComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
<section class="card rv" aria-labelledby="rv-h">
  <div class="rv-head">
    <div class="rv-title">
      <h2 id="rv-h">Quarterly review</h2>
      <span class="hint">About 10 minutes · {{ lastReview() ? 'last done ' + (lastReview() | dt) : 'your first one' }}@if (!auth.canWrite()) { · read-only for guests }</span>
    </div>
    <button type="button" class="btn ghost sm" (click)="close()"><app-icon name="close" [size]="15" /> Close review</button>
  </div>

  <ol class="rv-steps" aria-label="Review steps">
    @for (s of steps; track s.n) {
      <li [class.cur]="step() === s.n">
        <button type="button" class="rv-step" [class.on]="step() === s.n" [class.past]="s.n < step()" [attr.aria-current]="step() === s.n ? 'step' : null"
          (click)="go(s.n)" [attr.aria-label]="'Step ' + s.n + ' of 6: ' + s.label">
          <span class="rv-n" aria-hidden="true">@if (s.n < step()) { <app-icon name="check" [size]="12" /> } @else { {{ s.n }} }</span>
          <span class="rv-l">{{ s.label }}</span>
        </button>
      </li>
    }
  </ol>

  <div class="rv-body">
    @switch (step()) {
      <!-- 1. What changed -->
      @case (1) {
        @if (lastReview(); as since) {
          <h3 class="rv-h" tabindex="-1">What changed since {{ since | dt }}</h3>
          @if (briefLoading()) {
            <div class="rv-tiles"><div class="skeleton" style="height:76px"></div><div class="skeleton" style="height:76px"></div></div>
          } @else if (briefError()) {
            <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't work out the value change · {{ briefError() }}</span>
              <span class="spacer"></span><button type="button" class="btn sm" (click)="retryBrief()">Try again</button></div>
          } @else { @if (sinceLast(); as sl) {
            <div class="rv-tiles">
              <div class="rv-tile">
                <span class="rv-tl">Value change</span>
                <b class="rv-tv" [class]="sl.change | sign">{{ sl.change | inr: 0 : true }}@if (sl.change_pct !== null) { <span class="rv-tp">({{ sl.change_pct | pct }})</span> }</b>
                <span class="rv-tm">since your snapshot of {{ sl.date | dt }} · includes money you added</span>
              </div>
              <div class="rv-tile">
                <span class="rv-tl">New actions</span>
                <b class="rv-tv">{{ sl.actions_new }}</b>
                <span class="rv-tm">{{ sl.actions_new ? 'in your lists since then' : 'nothing new since then' }}</span>
              </div>
            </div>
          } @else {
            <p class="small muted">There's no saved snapshot from around {{ since | dt }}, so the value change can't be worked out.</p>
          } }

          <h4 class="rv-sub">Mix moves of more than 1 point</h4>
          @if (!hasSnapshot()) {
            <p class="small muted">Your last review saved no mix snapshot. This one will, so next quarter shows the moves.</p>
          } @else if (moves().length) {
            <ul class="rv-list">
              @for (m of moves(); track m.segment) {
                <li><span class="rv-name">{{ m.segment }}</span>
                  <span class="rv-fig">{{ m.then | pct: 1 : false }} → {{ m.now | pct: 1 : false }}</span>
                  <b class="rv-d" [class.pos]="m.delta > 0" [class.neg]="m.delta < 0">{{ m.delta > 0 ? '▲' : '▼' }}{{ abs(m.delta) }} pts</b></li>
              }
            </ul>
          } @else {
            <p class="small muted">No asset class moved more than 1 point.</p>
          }
        } @else {
          <h3 class="rv-h" tabindex="-1">First review: here is where you stand</h3>
          <div class="rv-tiles">
            <div class="rv-tile"><span class="rv-tl">Value</span><b class="rv-tv">{{ totals()?.value | inrc }}</b>
              <span class="rv-tm">@if (totals()?.unrealized !== undefined) { <span [class]="totals()?.unrealized | sign">{{ totals()?.unrealized | inrc: true }}</span> unrealised }</span></div>
            <div class="rv-tile"><span class="rv-tl">Returns a year (XIRR)</span><b class="rv-tv">{{ totals()?.xirr | pct }}</b><span class="rv-tm">since you started</span></div>
            <div class="rv-tile"><span class="rv-tl">Actions open</span><b class="rv-tv">{{ svc.summary().now }} now · {{ svc.summary().month }} this month</b>
              <span class="rv-tm">ranked on this page</span></div>
          </div>
          @if (segments().length) {
            <h4 class="rv-sub">Your mix today</h4>
            <ul class="rv-list">
              @for (s of segments(); track s.segment) {
                <li><span class="rv-name">{{ s.segment }}</span><span class="rv-fig">{{ s.pct | pct: 1 : false }}</span>
                  <span class="rv-d muted">@if (s.target !== null) { target {{ s.target | pct: 0 : false }} } @else { no target }</span></li>
              }
            </ul>
            <p class="small muted">Completing this review saves this mix, so next quarter shows what moved.</p>
          }
        }

        <h4 class="rv-sub">Goals and retirement <span class="muted rv-win">last 30 days</span></h4>
        @if (planLoading()) {
          <div class="skeleton" style="height:48px"></div>
        } @else if (planError()) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't load your plan · {{ planError() }}</span>
            <span class="spacer"></span><button type="button" class="btn sm" (click)="retryPlan()">Try again</button></div>
        } @else if (plan()?.empty) {
          <p class="small muted">No goals or retirement plan yet. <a routerLink="/plan">Set one up on Plan →</a></p>
        } @else if (planRows().length) {
          <ul class="rv-list">
            @for (r of planRows(); track r.key) {
              <li><span class="rv-name">{{ r.name }}</span>
                <span class="rv-fig">{{ r.probability === null ? '—' : (r.probability | pct: 0 : false) }} chance<app-est [basis]="probBasis" /></span>
                @if (r.delta !== null) {
                  <b class="rv-d" [class.pos]="r.delta > 0" [class.neg]="r.delta < 0">{{ r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : '' }}{{ abs(r.delta) }} pts</b>
                } @else { <span class="rv-d muted">no change</span> }
              </li>
            }
          </ul>
        }
      }

      <!-- 2. Mix -->
      @case (2) {
        <h3 class="rv-h" tabindex="-1">Mix: add money first, sell only if you must</h3>
        <p class="small text-2">Where new money would take your mix toward its targets, and then what selling would add. You choose the funds.</p>
        <div class="rv-planners">
          <div class="rv-pl">
            <h4 class="rv-sub">Without selling</h4>
            <app-rebalance-planner [newMoney]="newMoney()" [allowSell]="false" [useNet]="useNet()" />
          </div>
          <div class="rv-pl">
            <h4 class="rv-sub">Allow selling</h4>
            <app-rebalance-planner [newMoney]="newMoney()" [allowSell]="true" [useNet]="useNet()" />
          </div>
        </div>
        <h4 class="rv-sub">Mix actions@if (auth.canWrite()) { <span class="muted rv-win">tick what you'll do; you plan it in step 5</span> }</h4>
        @if (mixItems().length) {
          <ul class="rv-list">
            @for (it of mixItems(); track it.actionId) { <ng-container *ngTemplateOutlet="itemRow; context: { $implicit: it }" /> }
          </ul>
        } @else {
          <p class="small muted">Every asset class is within 2.5 points of its target, so there's no mix action to plan.</p>
        }
      }

      <!-- 3. Holdings -->
      @case (3) {
        <h3 class="rv-h" tabindex="-1">Concentration, laggards and winners</h3>
        @if (!store.portfolio()) {
          <div class="skeleton" style="height:120px"></div>
        } @else {
          <h4 class="rv-sub">Large single holdings <span class="muted rv-win">stocks from {{ concPct }}%, funds from {{ concMfPct }}%</span></h4>
          @if (holdings().concentration.length) {
            <ul class="rv-list">@for (it of holdings().concentration; track it.actionId) { <ng-container *ngTemplateOutlet="itemRow; context: { $implicit: it }" /> }</ul>
          } @else { <p class="small muted">No stock is {{ concPct }}% or more of the portfolio, and no fund {{ concMfPct }}% or more.</p> }

          <h4 class="rv-sub">Laggards <span class="muted rv-win">down 20% or more, held 6 months or more</span></h4>
          @if (holdings().laggards.length) {
            <ul class="rv-list">@for (it of holdings().laggards; track it.actionId) { <ng-container *ngTemplateOutlet="itemRow; context: { $implicit: it }" /> }</ul>
          } @else { <p class="small muted">No holding is down 20% after six months.</p> }

          <h4 class="rv-sub">Winners <span class="muted rv-win">up 50% or more and 5%+ of the portfolio</span></h4>
          @if (holdings().winners.length) {
            <ul class="rv-list">@for (it of holdings().winners; track it.actionId) { <ng-container *ngTemplateOutlet="itemRow; context: { $implicit: it }" /> }</ul>
          } @else { <p class="small muted">No large holding is up 50% yet.</p> }
        }
      }

      <!-- 4. Plan -->
      @case (4) {
        <h3 class="rv-h" tabindex="-1">Plan: what you invest against what you need</h3>
        @if (planLoading()) {
          <div class="skeleton" style="height:90px"></div>
        } @else if (planError()) {
          <div class="notice warn" role="status"><app-icon name="alert" [size]="16" /><span>Couldn't load your plan · {{ planError() }}</span>
            <span class="spacer"></span><button type="button" class="btn sm" (click)="retryPlan()">Try again</button></div>
        } @else { @if (plan(); as p) {
          @if (p.empty) {
            <p class="text-2">You have no goals or retirement plan yet, so there's nothing to fund. <a routerLink="/plan">Set one up on Plan →</a></p>
          } @else {
            <p class="rv-sentence">You invest <b>{{ p.sip.plans_monthly_total | inr }}/month</b>; your goals and retirement need
              <b>{{ p.sip.needed_monthly | inr }} a month</b><app-est [basis]="needBasis" /></p>
            <div class="rv-gap" [attr.data-status]="p.sip.gap_monthly > 0 ? 'watch' : 'good'">
              <app-icon [name]="p.sip.gap_monthly > 0 ? 'alert' : 'checkCircle'" [size]="16" />
              @if (p.sip.gap_monthly > 0) {
                <span>Gap: <b>{{ p.sip.gap_monthly | inr }}/month</b> for the goals and retirement that are short<app-est [basis]="needBasis" /></span>
              } @else {
                <span>No gap: every goal and your retirement get at least what they need.</span>
              }
            </div>
          }
          <p class="small"><a routerLink="/plan">Open Plan →</a></p>
        } }
      }

      <!-- 5. Commitments -->
      @case (5) {
        <h3 class="rv-h" tabindex="-1">Commitments</h3>
        @if (!auth.canWrite()) {
          <div class="notice" role="status"><app-icon name="info" [size]="16" /><span>Guests can't save commitments. This is what's already planned.</span></div>
          @if (svc.planned().length) {
            <ul class="rv-list">
              @for (a of svc.planned(); track a.id) {
                <li><span class="rv-name">{{ a.title }}</span><span class="rv-fig">planned for {{ a.planned_for | dt }}</span></li>
              }
            </ul>
          } @else { <p class="small muted">Nothing is planned.</p> }
        } @else if (commitments().length) {
          <p class="small text-2">Pick a date for each one. It moves to Planned on this page, and a reminder comes back if it slips.</p>
          <ul class="rv-list rv-commit">
            @for (c of commitments(); track c.item.actionId) {
              <li>
                <span class="rv-name">@if (c.item.link) { <a [routerLink]="linkPath(c.item.link)" [fragment]="linkFrag(c.item.link)">{{ c.item.name }}</a> } @else { {{ c.item.name }} }
                  <span class="muted small"> · {{ c.item.detail }}</span></span>
                @if (c.action; as a) {
                  <span class="rv-plan">
                    @if (a.status === 'planned' && a.planned_for) { <span class="small text-2">Planned for {{ a.planned_for | dt }}</span> }
                    <label class="sr-only" [for]="'rv-d-' + $index">Date for {{ c.item.name }}</label>
                    <input class="input sm rv-date" type="date" [id]="'rv-d-' + $index" [min]="todayIso" [ngModel]="dateFor(a.id)" (ngModelChange)="setDate(a.id, $event)" />
                    <button type="button" class="btn sm" (click)="planFor(a)" [disabled]="saving().has(a.id) || !dateFor(a.id)">
                      {{ saving().has(a.id) ? 'Saving…' : 'Plan for ' + (dateFor(a.id) | dt: false) }}</button>
                  </span>
                } @else {
                  <span class="small muted rv-plan">Not on your action list, so there's nothing to plan</span>
                }
              </li>
            }
          </ul>
        } @else {
          <p class="small muted">Tick the items you'll act on in steps 2 and 3, and plan them here.</p>
        }
        <p class="small"><a routerLink="/recurring">Edit SIPs on Recurring →</a></p>
      }

      <!-- 6. Complete -->
      @case (6) {
        <h3 class="rv-h" tabindex="-1">Complete the review</h3>
        <p class="text-2">@if (auth.canWrite()) { {{ plannedThisReview() ? 'You planned ' + plannedThisReview() + ' action' + (plannedThisReview() === 1 ? '' : 's') + ' in this review.' : 'You planned nothing in this review; that is fine when nothing needs changing.' }} }
          Completing it saves today's mix for next quarter's comparison and sets the next reminder for 90 days from now.</p>
        @if (auth.canWrite()) {
          <button type="button" class="btn primary" (click)="complete()" [disabled]="completing()">
            <app-icon name="checkCircle" [size]="16" /> {{ completing() ? 'Saving…' : 'Complete the review' }}</button>
        } @else {
          <p class="small muted">Only the portfolio's owner can complete the review.</p>
        }
      }
    }
  </div>

  <div class="rv-nav">
    <button type="button" class="btn sm" (click)="go(step() - 1)" [disabled]="step() === 1"><app-icon name="chevronLeft" [size]="15" /> Back</button>
    <span class="small muted">Step {{ step() }} of 6</span>
    @if (step() < 6) {
      <button type="button" class="btn sm primary" (click)="go(step() + 1)">Next <app-icon name="chevronRight" [size]="15" /></button>
    } @else {
      <button type="button" class="btn sm" (click)="close()">Close</button>
    }
  </div>
</section>

<!-- T2: the check-up (GET /pulse, lazily) -->
@if (pulseError()) {
  <p class="small muted rv-pulse-off" role="status"><app-icon name="info" [size]="14" /> The check-up couldn't load, so it's hidden. The review still works.</p>
} @else {
  <section class="card cu" aria-labelledby="cu-h">
    <div class="card-head"><div><h2 id="cu-h">Check-up</h2><span class="hint">A score out of 100 from diversification, discipline, risk, tax and returns.</span></div></div>
    @if (health(); as h) {
      <div class="cu-top" [attr.data-status]="healthStatus(h.score)">
        <b class="cu-score">{{ h.score }}<span class="cu-of">/100</span></b>
        <span class="cu-grade">{{ h.grade }}</span>
      </div>
      <ul class="cu-meters">
        @for (c of h.components; track c.key) {
          <li [attr.data-status]="healthStatus(c.score)">
            <div class="cu-row"><span class="cu-l">{{ c.label }}</span><b class="cu-v">{{ round(c.score) }}/100</b></div>
            <div class="cu-track" role="meter" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="round(c.score)" [attr.aria-label]="c.label">
              <i [style.width.%]="clamp(c.score)"></i></div>
            <span class="small muted">{{ c.note }}</span>
          </li>
        }
      </ul>
      @if (h.focus) {
        <p class="cu-focus"><app-icon name="target" [size]="15" /><span><b>Focus: {{ h.focus.label }}</b> · {{ h.focus.note }}</span></p>
      }
    } @else {
      <div class="skeleton" style="height:140px"></div>
    }
  </section>
}

<ng-template #itemRow let-it>
  <li class="rv-item">
    @if (auth.canWrite()) {
      <label class="check rv-tick"><input type="checkbox" [checked]="isTicked(it.actionId)" (change)="tick(it.actionId, $any($event.target).checked)"
        [attr.aria-label]="'Commit to ' + it.name" /></label>
    }
    <span class="rv-name"><a [routerLink]="linkPath(it.link)" [fragment]="linkFrag(it.link)">{{ it.name }}</a></span>
    <span class="rv-fig">{{ it.detail }}</span>
  </li>
</ng-template>
`,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
    .rv { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .rv-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .rv-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 220px; }
    .rv-title h2 { font-size: var(--t-h2); }
    .rv-title .hint { color: var(--muted); font-size: var(--t-meta); }

    .rv-steps { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; margin: 0; padding: 0; list-style: none; }
    .rv-step { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer;
      border: 1px solid var(--border); background: var(--surface); color: var(--text-2); font: inherit; font-size: var(--t-meta); text-align: left; }
    .rv-step:hover { border-color: var(--border-strong); color: var(--text); }
    .rv-step:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    .rv-step.on { border-color: var(--primary); background: var(--accent-soft); color: var(--text); font-weight: 600; }
    .rv-n { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 22px; height: 22px; border-radius: 999px;
      background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; font-weight: 600; }
    .rv-step.on .rv-n { background: var(--primary); border-color: var(--primary); color: var(--on-primary, #fff); }
    .rv-step.past .rv-n { background: var(--pos-soft); border-color: transparent; color: var(--pos); }
    .rv-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .rv-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .rv-h { font-size: var(--t-body); font-weight: 650; outline: none; scroll-margin-top: 120px; }
    .rv-sub { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 8px 0 0; font-size: var(--t-meta); font-weight: 600; }
    .rv-win { font-weight: 500; font-size: var(--t-label); }
    .rv-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .rv-tile { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); min-width: 0; }
    .rv-tl { font-size: var(--t-label); color: var(--muted); font-weight: 500; }
    .rv-tv { font-size: var(--t-stat); font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .rv-tp { font-size: var(--t-meta); font-weight: 500; margin-left: 4px; }
    .rv-tm { font-size: var(--t-label); color: var(--muted); }

    .rv-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; font-size: var(--t-meta); }
    .rv-list li { display: flex; align-items: baseline; gap: 6px 14px; flex-wrap: wrap; padding: 7px 0; min-width: 0; }
    .rv-list li + li { border-top: 1px dashed var(--border); }
    .rv-name { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
    .rv-fig { color: var(--text-2); font-variant-numeric: tabular-nums; }
    .rv-d { min-width: 64px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .rv-item { align-items: center !important; }
    .rv-tick { flex: none; }
    .rv-commit li { align-items: center; }
    .rv-plan { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto; }
    .rv-date { width: 150px; height: 32px; padding: 4px 8px; }

    .rv-planners { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .rv-pl { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .rv-sentence { font-size: var(--t-body); line-height: 1.5; }
    .rv-gap { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--st-soft); font-size: var(--t-meta); }
    .rv-gap app-icon { color: var(--st); display: inline-flex; flex: none; margin-top: 1px; }

    .rv-nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 12px; border-top: 1px solid var(--border); }

    .rv-pulse-off { display: flex; align-items: center; gap: 6px; margin: 0; }
    .cu-top { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
    .cu-score { font-size: var(--t-num); font-weight: 700; color: var(--st); font-variant-numeric: tabular-nums; }
    .cu-of { font-size: var(--t-meta); font-weight: 500; color: var(--muted); }
    .cu-grade { font-size: var(--t-body); font-weight: 600; }
    .cu-meters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 24px; margin: 0; padding: 0; list-style: none; }
    .cu-meters li { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .cu-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: var(--t-meta); }
    .cu-v { font-variant-numeric: tabular-nums; }
    .cu-track { height: 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); overflow: hidden; }
    .cu-track i { display: block; height: 100%; background: var(--st); border-radius: 999px; }
    .cu-focus { display: flex; align-items: flex-start; gap: 8px; margin: 16px 0 0; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface-2); font-size: var(--t-meta); }
    .cu-focus app-icon { display: inline-flex; flex: none; margin-top: 1px; color: var(--accent); }

    @media (max-width: 760px) {
      /* numbers only on phones; the current step keeps its label */
      .rv-steps { display: flex; }
      .rv-steps li { flex: none; }
      .rv-steps li.cur { flex: 1 1 auto; min-width: 0; }
      .rv-step { padding: 6px; justify-content: center; }
      .rv-step:not(.on) .rv-l { display: none; }
      .rv-step.on { justify-content: flex-start; }
      .cu-meters { grid-template-columns: minmax(0, 1fr); }
      .rv-plan { margin-left: 0; }
    }
  `],
})
export class ReviewComponent {
  readonly svc = inject(ActionService);
  readonly auth = inject(AuthService);
  readonly store = inject(StoreService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private injector = inject(Injector);

  /** The amount the planners start from: the deploy default the Actions page already read (E20). */
  readonly newMoney = input<number | null>(0);
  /** net=deploy while that amount is the brief default (A15). */
  readonly useNet = input(false);
  /** The user closed the review, or completed it. */
  readonly closed = output<void>();

  readonly steps = REVIEW_STEPS;
  readonly todayIso = today();
  readonly concPct = REVIEW_CONCENTRATION_PCT;
  readonly concMfPct = REVIEW_CONCENTRATION_MF_PCT;
  readonly probBasis = 'The share of simulated futures in which the goal is met, from the assumptions in your plan';
  readonly needBasis = 'The monthly SIP each goal and your retirement need for a 1-in-2 chance, from your plan’s assumptions';
  readonly healthStatus = healthStatus;

  // ── Session state (per portfolio on screen) ──────────────────
  readonly step = signal(1);
  readonly ticked = signal<ReadonlySet<string>>(new Set());
  private readonly dates = signal<Record<string, string>>({});
  readonly saving = signal<ReadonlySet<string>>(new Set());
  /** Actions planned from this review (this session), for step 6's sentence. */
  readonly plannedIds = signal<ReadonlySet<string>>(new Set());
  readonly plannedThisReview = computed(() => this.plannedIds().size);
  readonly completing = signal(false);
  private sessionKey: string | null = null;

  // ── Data ─────────────────────────────────────────────────────
  readonly lastReview = computed(() => {
    const d = this.store.settings().lastReviewDate;
    return typeof d === 'string' && d ? d.slice(0, 10) : null;
  });
  readonly brief = signal<Brief | null>(null);
  readonly briefLoading = signal(false);
  readonly briefError = signal<string | null>(null);
  readonly sinceLast = computed(() => this.brief()?.hero?.since_last ?? null);

  readonly plan = signal<Plan | null>(null);
  readonly planLoading = signal(true);
  readonly planError = signal<string | null>(null);

  readonly health = signal<Health | null>(null);
  readonly pulseError = signal(false);

  readonly totals = computed(() => this.store.portfolio()?.totals ?? null);
  readonly segments = computed(() => (this.store.portfolio()?.segments ?? []).filter(s => (s.value || 0) > 0 || (s.pct || 0) > 0));
  readonly hasSnapshot = computed(() => {
    const s = this.store.settings().reviewSnapshot;
    return !!s && typeof s === 'object' && Object.keys(s).length > 0;
  });
  readonly moves = computed(() => mixMoves(this.store.settings().reviewSnapshot, this.store.portfolio()?.segments ?? []));

  /** `/plan` rows with their 30-day deltas (`deltas` is keyed by goal id, or 'retirement'). */
  readonly planRows = computed(() => {
    const p = this.plan();
    if (!p) return [];
    const deltas = p.deltas ?? {};
    return (p.rows ?? []).map(r => {
      const key = r.kind === 'retirement' ? 'retirement' : String(r.id);
      const d = deltas[key];
      return { key: `${r.kind}:${r.id ?? ''}`, name: r.name, probability: r.probability,
        delta: typeof d === 'number' && isFinite(d) ? Math.round(d * 10) / 10 : null };
    });
  });

  /** Step 2's tickable items: the open or planned drift actions (`drift:<segment>`). */
  readonly mixItems = computed<ReviewItem[]>(() =>
    [...this.svc.actions(), ...this.svc.planned()].filter(a => a.id.startsWith('drift:')).map(a => ({
      actionId: a.id, group: 'mix' as const, name: a.title, detail: a.impact?.label || (a.impact?.amount ? `about ₹${Math.round(a.impact.amount).toLocaleString('en-IN')} to move` : 'off target'),
      link: a.link || '/risk#rebalance',
    })));
  readonly holdings = computed(() => reviewHoldings(this.store.positions(), this.todayIso,
    new Set([...this.svc.actions(), ...this.svc.planned()].map(a => a.id))));

  /** Step 5: every ticked item, with the open or planned action it can be planned through (or none). */
  readonly commitments = computed(() => {
    const all = [...this.mixItems(), ...this.holdings().concentration, ...this.holdings().laggards, ...this.holdings().winners];
    const seen = new Set<string>();
    const live = new Map<string, Action>([...this.svc.actions(), ...this.svc.planned()].map(a => [a.id, a]));
    return all.filter(it => this.ticked().has(it.actionId) && !seen.has(it.actionId) && seen.add(it.actionId))
      .map(item => ({ item, action: live.get(item.actionId) ?? null }));
  });

  constructor() {
    // session state follows the portfolio on screen
    effect(() => {
      const key = this.store.scopeKey();
      untracked(() => this.restore(key));
    });
    effect(() => {
      const s: ReviewSession = { step: this.step(), ticked: [...this.ticked()], dates: this.dates() };
      if (this.sessionKey !== null) SESSIONS.set(this.sessionKey, s);
    });

    // brief(since) and /plan follow the scope, the data version and the review date
    effect(() => {
      this.store.scopeKey();
      this.store.version();
      const since = this.lastReview();
      untracked(() => { void this.loadBrief(since); void this.loadPlan(); });
    });

    // the check-up is T2: fetched after the wizard's first paint
    afterNextRender(() => void this.loadPulse(), { injector: this.injector });

    inject(DestroyRef).onDestroy(() => { this.briefSeq++; this.planSeq++; this.pulseSeq++; });
  }

  // ── Navigation ───────────────────────────────────────────────
  go(n: number) {
    const next = Math.max(1, Math.min(6, n));
    if (next === this.step()) return;
    this.step.set(next);
    // move focus to the new step's heading, so keyboard and screen-reader users land on it
    afterNextRender(() => {
      const h = (this.host.nativeElement as HTMLElement).querySelector('.rv-h') as HTMLElement | null;
      if (!h) return;
      h.focus({ preventScroll: true });
      const r = h.getBoundingClientRect();
      if (r.top < 70 || r.top > window.innerHeight - 80) {
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        h.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      }
    }, { injector: this.injector });
  }

  close() { this.closed.emit(); }

  // ── Ticks and commitments ────────────────────────────────────
  isTicked(id: string): boolean { return this.ticked().has(id); }

  tick(id: string, on: boolean) {
    this.ticked.update(s => {
      const next = new Set(s);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  /** The date picked for an action, else its current planned date, else 30 days from today. */
  dateFor(id: string): string {
    const picked = this.dates()[id];
    if (picked) return picked;
    const a = this.svc.planned().find(x => x.id === id);
    return a?.planned_for?.slice(0, 10) || isoIn(30);
  }

  setDate(id: string, v: string) { this.dates.update(d => ({ ...d, [id]: v || '' })); }

  async planFor(a: Action) {
    if (!this.auth.canWrite()) return;
    const when = this.dateFor(a.id);
    if (!when || this.saving().has(a.id)) return;
    this.saving.update(s => new Set(s).add(a.id));
    try {
      const ok = await this.svc.setStatus(a.id, { status: 'planned', planned_for: when });
      if (ok) {
        this.plannedIds.update(s => new Set(s).add(a.id));
        this.toast.ok(`Planned for ${fmtDate(when)} · ${a.title}`);
      }
    } finally {
      this.saving.update(s => { const n = new Set(s); n.delete(a.id); return n; });
    }
  }

  // ── Complete ─────────────────────────────────────────────────
  async complete() {
    if (this.completing() || !this.auth.canWrite()) return;
    this.completing.set(true);
    try {
      await firstValueFrom(this.api.completeReview());
      await this.store.changed();
      this.toast.ok('Review complete · next reminder in 90 days');
      if (this.sessionKey !== null) SESSIONS.delete(this.sessionKey);
      this.sessionKey = null;  // the review is over: don't write this session back
      this.closed.emit();
    } catch (e) {
      this.toast.error(`Couldn't complete the review · ${errorMessage(e)}`);
    } finally {
      this.completing.set(false);
    }
  }

  // ── Template helpers ─────────────────────────────────────────
  abs(v: number): number { return Math.abs(v); }
  round(v: number): number { return Math.round(v || 0); }
  clamp(v: number): number { return Math.max(0, Math.min(100, v || 0)); }
  linkPath(link: string): string { return link.split('#')[0]; }
  linkFrag(link: string): string | undefined { return link.includes('#') ? link.split('#')[1] : undefined; }

  retryBrief() { void this.loadBrief(this.lastReview()); }
  retryPlan() { void this.loadPlan(); }

  // ── Loads ────────────────────────────────────────────────────
  private restore(key: string) {
    const s = SESSIONS.get(key);
    this.sessionKey = key;
    this.step.set(s?.step && s.step >= 1 && s.step <= 6 ? s.step : 1);
    this.ticked.set(new Set(s?.ticked ?? []));
    this.dates.set({ ...(s?.dates ?? {}) });
    this.plannedIds.set(new Set());
  }

  private briefSeq = 0;
  /** GET /brief?since=<lastReviewDate>; never written to Home's snapshot (E20). No review date: nothing to compare. */
  private async loadBrief(since: string | null) {
    const mine = ++this.briefSeq;
    if (!since) { this.brief.set(null); this.briefLoading.set(false); this.briefError.set(null); return; }
    this.briefLoading.set(!this.brief());
    try {
      const b = await firstValueFrom(this.api.brief(since));
      if (mine !== this.briefSeq) return;
      this.brief.set(b);
      this.briefError.set(null);
    } catch (e) {
      if (mine === this.briefSeq) this.briefError.set(errorMessage(e));
    } finally {
      if (mine === this.briefSeq) this.briefLoading.set(false);
    }
  }

  private planSeq = 0;
  private async loadPlan() {
    const mine = ++this.planSeq;
    this.planLoading.set(!this.plan());
    try {
      const p = await firstValueFrom(this.api.plan());
      if (mine !== this.planSeq) return;
      this.plan.set(p);
      this.planError.set(null);
    } catch (e) {
      if (mine === this.planSeq) this.planError.set(errorMessage(e));
    } finally {
      if (mine === this.planSeq) this.planLoading.set(false);
    }
  }

  private pulseSeq = 0;
  private async loadPulse() {
    const mine = ++this.pulseSeq;
    try {
      const p = await firstValueFrom(this.api.pulse());
      if (mine !== this.pulseSeq) return;
      const h = p?.health;
      if (!h || typeof h.score !== 'number' || !Array.isArray(h.components)) { this.pulseError.set(true); return; }
      this.health.set(h);
      this.pulseError.set(false);
    } catch {
      if (mine === this.pulseSeq) this.pulseError.set(true);
    }
  }
}
