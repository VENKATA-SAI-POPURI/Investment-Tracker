import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { errorMessage } from './http';
import { Action, ActionStatusBody, ActionsResponse, ActionsSummary, FollowThrough } from './models';
import { readSnapshot, snapshotKey, writeSnapshot } from './snapshot';
import { StoreService } from './store.service';
import { ToastService } from './toast.service';
import { linkUnder } from '../shared/priority/priority';

const EMPTY_SUMMARY: ActionsSummary = { now: 0, month: 0, consider: 0, good: 0, impact_total: 0 };
const EMPTY: ActionsResponse = { summary: EMPTY_SUMMARY, actions: [], planned: [], done: [], snoozed: [], follow_through: null };

/** Lump impacts only; a monthly impact is shown per month and never summed (Part 2 §8.2). */
function summarise(actions: Action[]): ActionsSummary {
  const s = { ...EMPTY_SUMMARY };
  for (const a of actions) {
    s[a.tier] += 1;
    if (a.impact && a.impact.kind === 'lump' && (a.tier === 'now' || a.tier === 'month')) s.impact_total += a.impact.amount || 0;
  }
  return s;
}

/**
 * Ranked actions for the portfolio on screen (Part 2 §9.3).
 * Paints from the device snapshot (`snapshotKey('actions', scopeKey)`), then refetches `/actions`;
 * reloads whenever the store's version moves. Every failure is soft: the lists stay as they were, or empty.
 */
@Injectable({ providedIn: 'root' })
export class ActionService {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private store = inject(StoreService);
  private toast = inject(ToastService);

  private readonly data = signal<ActionsResponse>(EMPTY);
  readonly loading = signal(false);
  /** False until /actions has answered once in this session (the route arrives in wave 2). */
  readonly loaded = signal(false);
  /** Why the last /actions load failed, or null once one succeeds: the lists on screen may be an older copy. */
  readonly error = signal<string | null>(null);

  readonly actions = computed(() => this.data().actions);
  readonly summary = computed(() => this.data().summary);
  readonly planned = computed(() => this.data().planned);
  readonly done = computed(() => this.data().done);
  readonly snoozed = computed(() => this.data().snoozed);
  readonly followThrough = computed<FollowThrough | null>(() => this.data().follow_through);
  /** One line per source the server skipped (E4); [] when every source answered. */
  readonly notes = computed<string[]>(() => this.data().notes ?? []);
  /** Tier-now actions: the bell and the nav badge read these. */
  readonly now = computed(() => this.actions().filter(a => a.tier === 'now'));

  private seq = 0;

  constructor() {
    effect(() => {
      const v = this.store.version();
      const key = this.store.scopeKey();
      if (!this.auth.token()) { untracked(() => { this.data.set(EMPTY); this.paintedFor = null; }); return; }
      untracked(() => {
        if (key !== this.paintedFor) {
          // a new identity or portfolio: paint from what this device saw last time, then refresh
          this.paintedFor = key;
          this.loaded.set(false);
          this.error.set(null);
          this.data.set(this.normalise(readSnapshot<ActionsResponse>(snapshotKey('actions', key))));
        }
        if (v >= 0) queueMicrotask(() => void this.reload());
      });
    });
  }

  private paintedFor: string | null = null;

  /** Actions whose evidence page (`link`) sits under one of the prefixes (A7, A27). */
  forLinks(prefixes: string[], tiers: Action['tier'][] = ['now', 'month']): Action[] {
    return this.actions().filter(a => tiers.includes(a.tier) && prefixes.some(p => linkUnder(a.link, p)));
  }

  find(id: string): Action | undefined {
    const d = this.data();
    return [...d.actions, ...d.planned, ...d.done, ...d.snoozed].find(a => a.id === id);
  }

  async reload(): Promise<void> {
    if (!this.auth.token()) return;
    const mine = ++this.seq;
    const key = snapshotKey('actions', this.store.scopeKey());
    this.loading.set(true);
    try {
      const r = this.normalise(await firstValueFrom(this.api.actions()));
      if (mine !== this.seq) return;  // a newer load (or a status change) has superseded this one
      this.data.set(r);
      this.loaded.set(true);
      this.error.set(null);
      writeSnapshot(key, r);
    } catch (e) {
      /* /actions not available yet, offline or forbidden: keep what is painted, and say so */
      if (mine === this.seq) this.error.set(errorMessage(e));
    } finally {
      if (mine === this.seq) this.loading.set(false);
    }
  }

  /**
   * Optimistic status change: the card moves at once, the POST follows, and a failure puts it back.
   * Resolves true when the server accepted it.
   */
  async setStatus(id: string, body: ActionStatusBody): Promise<boolean> {
    const before = this.data();
    this.seq++;  // any load in flight would paint the old state
    this.data.set(this.applyLocally(before, id, body));
    try {
      await firstValueFrom(this.api.setActionStatus(id, body));
      void this.reload();
      return true;
    } catch (e) {
      this.data.set(before);
      this.toast.error(`Couldn't update the action · ${errorMessage(e)}`);
      return false;
    }
  }

  private applyLocally(d: ActionsResponse, id: string, body: ActionStatusBody): ActionsResponse {
    const all = [...d.actions, ...d.planned, ...d.done, ...d.snoozed];
    const hit = all.find(a => a.id === id);
    const strip = (xs: Action[]) => xs.filter(a => a.id !== id);
    const next: ActionsResponse = { ...d, actions: strip(d.actions), planned: strip(d.planned), done: strip(d.done), snoozed: strip(d.snoozed) };
    if (hit) {
      const moved: Action = { ...hit, status: body.status, planned_for: body.planned_for ?? (body.status === 'planned' ? hit.planned_for : null),
        snooze_until: body.status === 'snoozed' ? (body.until ?? hit.snooze_until) : null, reason: body.reason ?? hit.reason ?? null };
      if (body.status === 'open') next.actions = [...next.actions, moved];
      else if (body.status === 'planned') next.planned = [...next.planned, moved];
      else if (body.status === 'done') next.done = [moved, ...next.done];
      else next.snoozed = [moved, ...next.snoozed];  // snoozed and dismissed are listed together
    }
    next.summary = summarise(next.actions);
    return next;
  }

  /** Fills every list so a partial payload (or an old snapshot) never breaks a template. */
  private normalise(r: Partial<ActionsResponse> | null | undefined): ActionsResponse {
    if (!r) return EMPTY;
    const actions = Array.isArray(r.actions) ? r.actions : [];
    return {
      summary: r.summary ?? summarise(actions),
      actions,
      planned: Array.isArray(r.planned) ? r.planned : [],
      done: Array.isArray(r.done) ? r.done : [],
      snoozed: Array.isArray(r.snoozed) ? r.snoozed : [],
      follow_through: r.follow_through ?? null,
      notes: Array.isArray(r.notes) ? r.notes.filter(n => typeof n === 'string') : [],
    };
  }
}
