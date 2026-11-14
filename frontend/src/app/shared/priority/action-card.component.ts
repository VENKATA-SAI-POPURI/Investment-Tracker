import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ActionRunnerService } from '../../core/action-runner.service';
import { ActionService } from '../../core/action.service';
import { AuthService } from '../../core/auth.service';
import { inrCompact, today } from '../../core/format';
import { Action, ActionCta, ActionStatusBody } from '../../core/models';
import { IconComponent } from '../icon.component';
import { EstTagComponent } from './est-tag.component';
import { CONFIDENCE_LABEL, STATUS_META, actionStatus, dueText, isInstalment } from './priority';

/** ISO date `n` days from today. */
function addDays(n: number): string {
  const d = new Date(today() + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export interface ActionStatusChange { id: string; body: ActionStatusBody; }

/** A page's own handler for an action it can carry out in place (e.g. /nps opening its NAV editor), or null. */
export type LocalRun = (a: Action) => (() => void) | null;

/** The path part of a link or route ("/p2p?tab=all#x" → "/p2p"), without a trailing slash. */
function pathOf(link: string): string {
  const p = link.split(/[?#]/)[0];
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * A CTA a guest may run (AMENDMENTS J17): `route` and `whatif` only read. `dialog`, `fd_mature` and every `api`
 * call (`review_complete` writes; `prices_refresh` posts a refresh) stay writer-only and become "View" for guests.
 */
export function readCta(cta: Pick<ActionCta, 'type'> | null | undefined): boolean {
  return !!cta && (cta.type === 'route' || cta.type === 'whatif');
}

/**
 * `.action-card`: status stripe, title, detail, impact · confidence · due · owner, the CTA, and a ⋯ menu
 * (Plan for…, Snooze 7/30/90, Done, Not relevant; "Skip this month" on SIP instalments).
 * `compact` is the single 44px row.
 *
 * Guests (J17): a `route` or `whatif` CTA is a read, so they see it, under the same same-page hiding as writers
 * (`ctaHere`; a page's `localRun` is for writers only, since in-place handlers open editors). A CTA that writes
 * becomes "View" to `link`, or to `/actions?id=<id>` when there is no link (not on /actions itself). No ⋯ menu.
 */
@Component({
  selector: 'app-action-card',
  standalone: true,
  imports: [FormsModule, IconComponent, EstTagComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let a = action();
    <article class="action-card" [class.compact]="compact()" [attr.data-status]="status()" [attr.id]="'action-' + a.id">
      @if (compact()) {
        <span class="ac-ic" [attr.title]="meta().word"><app-icon [name]="meta().icon" [size]="15" /><span class="sr-only">{{ meta().word }}</span></span>
        <span class="ac-title ellipsis" [attr.title]="a.title">{{ a.title }}</span>
        @if (impactText()) { <span class="impact">{{ impactText() }}</span> }
        @if (due(); as d) { <span class="due" [class.late]="late()">@if (late()) { <app-icon name="alert" [size]="12" /> }{{ d }}</span> }
      } @else {
        <div class="ac-body">
          <div class="ac-head">
            <span class="ac-ic" [attr.title]="meta().word"><app-icon [name]="meta().icon" [size]="16" /><span class="sr-only">{{ meta().word }}</span></span>
            <h3 class="ac-title">{{ a.title }}</h3>
            @if (a.is_new) { <span class="badge info">New</span> }
          </div>
          @if (a.detail) { <p class="ac-detail">{{ a.detail }}</p> }
          @if (showWhy() && a.why) { <p class="ac-why">{{ a.why }}</p> }
          @if (a.assumptions && (a.confidence === 'estimate' || a.confidence === 'model')) { <p class="ac-assume">{{ a.assumptions }}</p> }
          <div class="ac-meta">
            @if (impactText()) {
              <span class="impact">{{ impactText() }}@if (a.confidence === 'estimate' || a.confidence === 'model') { <app-est [basis]="a.assumptions" /> }</span>
            }
            <span class="conf" [attr.data-conf]="a.confidence">{{ confLabel() }}</span>
            @if (due(); as d) { <span class="due" [class.late]="late()">@if (late()) { <app-icon name="alert" [size]="12" /> }{{ d }}</span> }
            @if (ownerName(); as o) { <span class="badge"><app-icon name="users" [size]="12" />{{ o }}</span> }
          </div>
        </div>
      }
      <div class="ac-cta">
        @if (showCta() && a.cta) {
          <button type="button" class="btn sm" [class.primary]="primary()" [attr.title]="a.cta.label" (click)="run()">{{ a.cta.label }}</button>
        } @else if (viewLink()) {
          <a class="btn sm" [class.primary]="primary()" [attr.href]="viewLink()" (click)="view($event)">View</a>
        }
        @if (canWrite()) {
          <div class="ac-more">
            <button type="button" class="btn ghost icon sm" (click)="toggleMenu()" [attr.aria-expanded]="menu()" aria-haspopup="menu"
              [attr.aria-label]="'More for ' + a.title"><app-icon name="more" [size]="16" /></button>
            @if (menu()) {
              <div class="ac-menu" role="menu">
                @if (planning()) {
                  <form class="ac-plan" (ngSubmit)="plan()">
                    <label class="small muted" for="plan-{{ a.id }}">Plan for</label>
                    <input id="plan-{{ a.id }}" class="input" type="date" name="planned_for" [min]="todayIso" [(ngModel)]="planDate" />
                    <div class="row"><button type="button" class="btn sm ghost" (click)="planning.set(false)">Back</button>
                      <button type="submit" class="btn sm primary" [disabled]="!planDate">Plan</button></div>
                  </form>
                } @else {
                  @if (a.status !== 'open' && a.status !== 'expired') {
                    <button type="button" role="menuitem" (click)="set({ status: 'open' })"><app-icon name="refresh" [size]="14" /> Back to open</button>
                  }
                  <button type="button" role="menuitem" (click)="startPlan()"><app-icon name="calendar" [size]="14" /> Plan for…</button>
                  <button type="button" role="menuitem" (click)="snooze(7)"><app-icon name="bell" [size]="14" /> Snooze 7 days</button>
                  <button type="button" role="menuitem" (click)="snooze(30)"><app-icon name="bell" [size]="14" /> Snooze 30 days</button>
                  <button type="button" role="menuitem" (click)="snooze(90)"><app-icon name="bell" [size]="14" /> Snooze 90 days</button>
                  @if (instalment()) {
                    <button type="button" role="menuitem" (click)="set({ status: 'dismissed', reason: 'skipped' })"><app-icon name="chevronRight" [size]="14" /> Skip this month</button>
                  }
                  <button type="button" role="menuitem" (click)="set({ status: 'done' })"><app-icon name="check" [size]="14" /> Done</button>
                  <button type="button" role="menuitem" (click)="set({ status: 'dismissed' })"><app-icon name="close" [size]="14" /> Not relevant</button>
                }
              </div>
            }
          </div>
        }
      </div>
    </article>`,
  styles: [`:host{display:block;min-width:0}
    /* on a phone a one-line row with a long CTA label would squeeze the title to nothing or overflow: the title takes
       the first line, and the impact, CTA and menu wrap to a second one (a label longer than the card still ellipsises) */
    @media (max-width: 560px) {
      .action-card.compact { flex-wrap: wrap; row-gap: 4px; padding-top: 6px; padding-bottom: 6px; }
      .action-card.compact .ac-title { flex: 1 1 calc(100% - 40px); }
      .action-card.compact .impact { margin-left: 25px; }
      .action-card.compact .ac-cta { margin-left: auto; min-width: 0; max-width: 100%; }
      .action-card.compact .ac-cta > .btn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; line-height: 28px; }
    }`],
})
export class ActionCardComponent {
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private service = inject(ActionService);
  private runner = inject(ActionRunnerService);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute, { optional: true });

  action = input.required<Action>();
  /** The host page's in-place handler; without one, a CTA or View link to the page already shown is hidden. */
  localRun = input<LocalRun | null>(null);
  compact = input(false);
  /** Only the first card of a section carries `.btn.primary` (§9.4). */
  primary = input(false);
  /** Show the "why" line (the Actions page does; Home does not). */
  showWhy = input(false);
  /** Every status change made from the ⋯ menu, after the optimistic update has been applied. */
  statusChange = output<ActionStatusChange>();

  readonly todayIso = today();
  menu = signal(false);
  planning = signal(false);
  planDate = addDays(7);

  canWrite = this.auth.canWrite;
  status = computed(() => actionStatus(this.action()));
  meta = computed(() => STATUS_META[this.status()]);
  confLabel = computed(() => CONFIDENCE_LABEL[this.action().confidence] ?? this.action().confidence);
  instalment = computed(() => isInstalment(this.action().id));
  late = computed(() => {
    const a = this.action();
    return (a.days_late ?? 0) > 0 || (a.days !== null && a.days < 0);
  });
  due = computed(() => {
    const a = this.action();
    if ((a.days_late ?? 0) > 0) return `${a.days_late} day${a.days_late === 1 ? '' : 's'} late`;
    if (a.status === 'planned' && a.planned_for) return dueText(null, a.planned_for).replace(/^by /, 'planned ');
    return dueText(a.days, a.due);
  });
  impactText = computed(() => {
    const i = this.action().impact;
    if (!i) return '';
    if (i.label) return i.label;
    return i.amount ? `${inrCompact(i.amount)}${i.kind === 'monthly' ? '/mo' : ''}` : '';
  });
  /** Whose action it is, shown in the family view only. */
  ownerName = computed(() => {
    const o = this.action().owner;
    if (!o || o === '__global__' || !this.auth.canSwitch() || this.auth.portfolio()) return null;
    return this.auth.members().find(m => m.email.toLowerCase() === o.toLowerCase())?.name ?? o.split('@')[0];
  });

  local = computed(() => this.localRun()?.(this.action()) ?? null);
  /** The path of the page hosting the card (its activated route, so it is right while a navigation activates it). */
  private readonly here = '/' + (this.route?.snapshot.pathFromRoot ?? []).flatMap(r => r.url.map(u => u.path)).join('/');
  /** A route CTA to the page already shown, with no query or fragment to apply: it would do nothing (W4 review). */
  ctaHere = computed(() => {
    const c = this.action().cta;
    return !!c && c.type === 'route' && !!c.route && !Object.keys(c.query ?? {}).length && !c.fragment
      && !/[?#]/.test(c.route) && pathOf(c.route) === this.here;
  });
  linkHere = computed(() => {
    const l = this.action().link;
    return !!l && !/[?#]/.test(l) && pathOf(l) === this.here;
  });
  /** May this viewer run the CTA? Writers run any; guests only the reads (J17). */
  private ctaAllowed = computed(() => this.canWrite() || readCta(this.action().cta));
  /** The CTA button shows: allowed, and not a no-op to this page (a writer's in-place handler lifts that). */
  showCta = computed(() => {
    const a = this.action();
    if (!a.cta || !this.ctaAllowed()) return false;
    return (this.canWrite() && !!this.local()) || !this.ctaHere();
  });
  /**
   * Where "View" goes when the CTA does not show: the evidence `link` unless it is this page; for a guest whose CTA
   * writes and who has no link, the action on /actions (except on /actions itself). Null hides it.
   */
  viewLink = computed<string | null>(() => {
    const a = this.action();
    if (a.link) return this.linkHere() ? null : a.link;
    if (a.cta && !this.ctaAllowed() && this.here !== '/actions') return `/actions?id=${encodeURIComponent(a.id)}`;
    return null;
  });

  run() {
    const local = this.canWrite() ? this.local() : null;
    if (local) { local(); return; }
    void this.runner.run(this.action());
  }
  view(e: MouseEvent) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    this.runner.open(this.viewLink());
  }

  toggleMenu() { this.menu.update(m => !m); this.planning.set(false); }
  startPlan() { this.planDate = addDays(7); this.planning.set(true); }
  plan() { if (this.planDate) this.set({ status: 'planned', planned_for: this.planDate }); }
  snooze(days: number) { this.set({ status: 'snoozed', until: addDays(days) }); }

  set(body: ActionStatusBody) {
    this.menu.set(false);
    this.planning.set(false);
    const id = this.action().id;
    void this.service.setStatus(id, body);
    this.statusChange.emit({ id, body });
  }

  @HostListener('document:click', ['$event'])
  onDocClick(e: Event) {
    if (this.menu() && !this.host.nativeElement.contains(e.target as Node)) { this.menu.set(false); this.planning.set(false); }
  }
  @HostListener('document:keydown.escape')
  onEsc() { if (this.menu()) { this.menu.set(false); this.planning.set(false); } }
}
