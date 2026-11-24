import { DOCUMENT, Location } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, fmtDate, inr, relTime } from '../../core/format';
import { errorMessage } from '../../core/http';
import {
  AllowlistUser, AssumptionOverrides, AssumptionsView, CLASS_LABEL, EmergencyFund, EmergencyFundSuggest, MarketAlertsConfig, Position, Role,
  Settings, Status,
} from '../../core/models';
import { PushService } from '../../core/push.service';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { InstrumentEditComponent } from '../../shared/instrument-edit.component';
import { StatusBadgeComponent } from '../../shared/priority/status-badge.component';
import { ConfirmService } from '../../shared/ui';

/** Sections of the anchor rail, in page order (SPEC §5.14, J15, R19). `people` is shown to admins only. */
type SectionId = 'profile' | 'alerts' | 'prices' | 'people' | 'assumptions';
const SECTIONS: { id: SectionId; label: string; short: string }[] = [
  { id: 'profile', label: 'Profile & cushion', short: 'Profile' },
  { id: 'alerts', label: 'Alerts', short: 'Alerts' },
  { id: 'prices', label: 'Prices & tickers', short: 'Prices' },
  { id: 'people', label: 'Family', short: 'Family' },
  { id: 'assumptions', label: 'Assumptions', short: 'Assumptions' },
];
/** Fragments this page aligns itself (the router's anchor scroll runs once, before late content settles). */
const ANCHORS = new Set(['profile', 'cushion', 'alerts', 'prices', 'people', 'assumptions']);

/** The settings owner of the shared family plan (`ledger.GLOBAL_OWNER`). */
const GLOBAL_OWNER = '__global__';
/**
 * Which setting keys each card shows, for the R19 "From the family plan until you change it" marker (P2.6). A card is
 * marked when one of its keys is in `settings.inherited` (the member has no row of their own for it yet).
 */
const INHERIT_GROUPS = {
  cushion: ['emergencyFund'],
  tax: ['taxSlabRate'],
  plans: ['targetAllocation', 'riskProfile', 'retirementPlan'],
  flows: ['autoCapitalFlows'],
  alerts: ['marketAlerts'],
  assumptions: ['assumptions'],
} as const;
export type InheritGroup = keyof typeof INHERIT_GROUPS;

/** The `assumptions` override ranges (§7.7, AMENDMENTS R4), in percent; the server checks the same bounds. */
const RET_RANGE: readonly [number, number] = [-5, 25];
const VOL_RANGE: readonly [number, number] = [0, 60];
const INFL_RANGE: readonly [number, number] = [0, 15];
/** Book rows whose return the engines take from the holdings' own rates when such holdings exist (R4). */
const RATED_KEYS = new Set(['Fixed Deposits', 'EPF', 'P2P']);
const MF_DEBT = 'MF_DEBT';
/** Two numbers closer than this are the same figure (the view rounds to 2 decimals). */
const EPS = 1e-6;

/** Fields W7-B2's GET /settings adds (R8); read through an intersection so an older `models.ts` still compiles. */
type SettingsP2 = Settings & { assumptions?: AssumptionOverrides | null; settings_owner?: string; inherited?: string[] };

/** One draft edit of a Book row; absent fields keep the row's base value. */
interface BookEdit { ret?: number | null; vol?: number | null; }

/** One row of the `#assumptions` editor (R19). */
export interface BookRow {
  key: string;
  label: string;
  /** Share of today's portfolio in this row, in %. */
  weight: number;
  /** What every forecast uses now (default, override or the holdings' rates), from GET /assumptions. */
  ret: number;
  vol: number;
  source: 'default' | 'override' | 'holding rates';
  capped: boolean;
  /** The saved override for this key, if any. */
  saved: { return_pct: number; vol_pct: number } | null;
  /** The return comes from the holdings' own rates, so it is read-only here (R4). */
  rated: boolean;
  /** The values in the inputs: the draft, else the saved override, else what is in use. */
  dRet: number | null;
  dVol: number | null;
  retErr: string | null;
  volErr: string | null;
  /** The user asked to drop this row's override on the next save. */
  clearing: boolean;
  /** Differs from what is saved: an edited value, or a cleared override. */
  changed: boolean;
}
const SETTLE_MS = 1500;
const TRADABLE = ['equity', 'mutual_fund', 'commodity'];
const PROFILE_LABEL: Record<string, string> = { conservative: 'Conservative', balanced: 'Balanced', growth: 'Growth', aggressive: 'Aggressive' };

/** Server bounds for `emergencyFund` (§7.7, H10, A25). */
const EF_MONTHS_MIN = 3;
const EF_MONTHS_MAX = 24;
const EF_MONTHS_DEFAULT = 6;
const EF_MAX_EXPENSES = 1e7;
const EF_MAX_CASH = 1e8;
/** Below this many months the Cushion vital acts (brief.CUSHION_FLOOR_MONTHS); the editor uses the same bands. */
const CUSHION_FLOOR_MONTHS = 3;

/** One row of the cushion checklist: a suggested candidate, a saved id, or a holding the user added. */
export interface CushionRow {
  id: number;
  name: string;
  /** What kind of money it is, in words ("USD wallet", "Debt fund", "FD · matures 3 Mar 2027"). */
  note: string;
  /** Today's value; 0 for a closed or unknown holding, which adds nothing (as `brief.cushion_state` counts it). */
  value: number;
  /** Not an open holding in this portfolio (closed, or not found); saving an unknown id is a 400. */
  gone: boolean;
}

/** The same figure, allowing for the view's 2-decimal rounding. */
function same(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < 0.005 + EPS;
}

function round2(v: number): number { return Math.round(v * 100) / 100; }

/** The inline error for one override field, or null when it is a finite number inside [lo, hi]. */
function rangeErr(v: number | null | undefined, [lo, hi]: readonly [number, number]): string | null {
  if (v == null) return 'Enter a number';
  const n = +v;
  if (!Number.isFinite(n)) return 'Enter a number';
  return n < lo || n > hi ? `Between ${lo < 0 ? '−' + -lo : lo}% and ${hi}%` : null;
}

/**
 * Settings (`/settings`, SPEC §5.14, AMENDMENTS J15). A tool page (§1.12): a head and content, no T0 and no strip.
 *
 * - Anchor rail: Profile & cushion · Alerts · Prices & tickers · Family (admins only). A sticky side rail on desktop,
 *   a `.seg` strip on phones. The active section follows the scroll.
 * - `#profile`: tax slab, automatic capital flows, the Emergency cushion editor (`id="cushion"`, A14, A25, H10) and
 *   read-only summaries of the target mix (`/risk#mix`) and retirement plan (`/plan?tab=retirement`). The target
 *   allocation editor lives on Risk & mix now (J8).
 * - `#alerts`: price alerts and the "Daily action digest (09:15)" flag (`marketAlerts.digest`, R8), saved with the
 *   whole alerts object because a PUT without `digest` stores false.
 * - `#prices`: the Missing filter is the default only when an open tradable holding has no price.
 * - `#assumptions` (P2.10, R4, R19): per-row return and volatility overrides of the Assumption Book plus inflation,
 *   checked client-side to the §7.7 ranges, with Reset to defaults and the Book's hash ("Assumptions id").
 * - Family view (`canSwitch() && !portfolio()`) shows "Editing the family plan". A member view whose
 *   `settings_owner` is the member shows "Saving to {member}'s plan" (P2.6, R11), and cards still read from the
 *   family plan (`inherited`) say so. Guests see every section read-only.
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, InstrumentEditComponent, StatusBadgeComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.component.html',
  styles: [`
    :host { display: block; }
    .set-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 28px; align-items: start; }
    .set-body { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
    .set-body > section, #cushion { scroll-margin-top: 80px; }
    .rail { position: sticky; top: 80px; display: flex; flex-direction: column; gap: 2px; }
    .rail a { display: block; padding: 8px 12px; border-radius: 8px; color: var(--text-2); font-size: 13.5px; font-weight: 500;
      text-decoration: none; border-left: 3px solid transparent; }
    .rail a:hover { color: var(--text); background: var(--surface-2); }
    .rail a.on { color: var(--text); font-weight: 600; background: var(--surface-2); border-left-color: var(--primary); }
    .rail-phone { display: none; }
    .sec-title { display: flex; flex-direction: column; gap: 2px; }
    .sec-title h2 { margin: 0; }
    .family { align-items: center; }
    .family b { color: var(--text); }
    .profile-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; align-items: start; }
    .side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 0;
      border-top: 1px solid var(--border); text-decoration: none; color: var(--text); font-size: 13.5px; }
    .summary:first-of-type { border-top: 0; padding-top: 0; }
    .summary .k { color: var(--text-2); }
    .summary .go { color: var(--primary); font-weight: 500; white-space: nowrap; }
    .summary:hover .go { text-decoration: underline; }
    .cov { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 12px; background: var(--surface-2);
      border: 1px solid var(--border); border-left: var(--stripe) solid var(--st); }
    .cov-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .cov-num { font-size: 24px; font-weight: 650; line-height: 1.1; }
    .cov-num small { font-size: 13px; font-weight: 500; color: var(--text-2); }
    .cov-bar { position: relative; height: 8px; border-radius: 999px; background: var(--grid); overflow: hidden; }
    .cov-bar > span { display: block; height: 100%; border-radius: 999px; background: var(--st); }
    .cov p { margin: 0; }
    .checklist { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .ck { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 12px;
      border-top: 1px solid var(--border); cursor: pointer; }
    .ck:first-child { border-top: 0; }
    .ck input { accent-color: var(--primary); width: 16px; height: 16px; margin: 0; }
    .ck .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; }
    .ck .nt { font-size: 12px; color: var(--muted); }
    .ck.off .nm { color: var(--text-2); }
    .ck.gone .nm { color: var(--muted); text-decoration: line-through; }
    .ck-empty { padding: 12px; font-size: 13px; color: var(--muted); }
    .skel { height: 14px; border-radius: 6px; background: var(--grid); margin: 12px; }
    .ef-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .ef-actions .grow { margin-right: auto; }
    .alerts-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 28px; }
    .device { padding: 14px 16px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; align-self: start; }
    .device p { margin: 0; }
    .digest { display: flex; flex-direction: column; gap: 4px; padding-top: 12px; border-top: 1px solid var(--border); }
    .digest .hint { font-size: 12px; color: var(--muted); padding-left: 24px; }
    .digest .need { color: var(--warn); font-weight: 500; }
    .inh { white-space: normal; text-align: left; }
    .head-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .hash code { font-size: 12px; }
    .book { display: flex; flex-direction: column; }
    .bk { display: grid; grid-template-columns: minmax(150px, 1.3fr) minmax(150px, 1.2fr) minmax(0, 1fr) minmax(0, 1fr) 112px;
      grid-template-areas: 'name now ret vol act'; gap: 6px 14px; align-items: start; padding: 11px 22px; border-top: 1px solid var(--border); }
    .bk.head { padding-top: 8px; padding-bottom: 8px; font-size: 12px; font-weight: 500; color: var(--muted); align-items: end; }
    .bk.chg { background: var(--surface-2); }
    .bk .b-name { grid-area: name; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .bk .b-name b { font-weight: 600; font-size: 13.5px; }
    .bk .b-now { grid-area: now; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; font-size: 13px; }
    .bk .b-ret { grid-area: ret; min-width: 0; }
    .bk .b-vol { grid-area: vol; min-width: 0; }
    .bk .b-act { grid-area: act; display: flex; justify-content: flex-end; }
    .bk .input { max-width: 120px; }
    .bk .lbl { display: none; }
    .bk .ro { font-size: 13px; padding-top: 7px; }
    .bk.ro-row { grid-template-columns: minmax(150px, 1.3fr) minmax(0, 2fr); grid-template-areas: 'name now'; }
    .infl { padding: 14px 22px; border-top: 1px solid var(--border); }
    .infl .input { max-width: 120px; }
    .bk-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; padding: 14px 22px; border-top: 1px solid var(--border); }
    .bk-foot .grow { margin-right: auto; }
    .bk-msg { margin: 0 22px 14px; }
    .bk-skel { padding: 0 10px 12px; }
    @media (max-width: 1100px) { .profile-grid { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 800px) { .alerts-grid { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 900px) {
      .bk { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: 'name now' 'ret vol' 'act act'; padding: 12px 16px; }
      .bk.ro-row { grid-template-areas: 'name now'; }
      .bk.head { display: none; }
      .bk .lbl { display: block; font-size: 12px; font-weight: 500; color: var(--text-2); margin-bottom: 4px; }
      .bk .b-act { justify-content: flex-start; }
      .bk .b-act:empty { display: none; }
      .bk .input { max-width: none; }
      .infl, .bk-foot { padding-left: 16px; padding-right: 16px; }
      .bk-msg { margin: 0 16px 14px; }
    }
    @media (max-width: 760px) {
      .set-layout { grid-template-columns: minmax(0, 1fr); gap: 16px; }
      .rail { display: none; }
      .rail-phone { display: flex; width: 100%; box-sizing: border-box; }
      .rail-phone button { flex: 1 1 auto; }
      .set-body { gap: 16px; }
    }
  `],
})
export class SettingsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private route = inject(ActivatedRoute);
  private location = inject(Location);
  private doc = inject(DOCUMENT);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  push = inject(PushService);
  /** The alerts draft; `digest` is the daily action digest flag (R8), false unless saved true. */
  alerts: MarketAlertsConfig & { digest: boolean } = { enabled: true, push: true, day: 5, week: 10, digest: false };

  classLabel = CLASS_LABEL;
  slab = 30;
  autoFlows = true;
  saving = signal(false);
  editing = signal<Position | null>(null);
  users = signal<AllowlistUser[]>([]);
  newEmail = '';
  newRole: Role = 'user';
  rel = relTime;
  readonly monthsOptions = Array.from({ length: EF_MONTHS_MAX - EF_MONTHS_MIN + 1 }, (_, i) => EF_MONTHS_MIN + i);

  // ── Anchor rail ──
  readonly sections = computed(() => SECTIONS.filter(s => s.id !== 'people' || this.auth.isAdmin()));
  readonly active = signal<SectionId>('profile');
  private stopSettle: (() => void) | null = null;

  /** Family view: an admin or guest looking at the whole family, whose settings are the shared family plan. */
  readonly familyView = computed(() => this.auth.canSwitch() && !this.auth.portfolio());
  readonly firstLoad = computed(() => this.store.loading() && !this.store.portfolio());

  // ── Per-member settings (P2.6, R8, R11) ──
  private readonly s2 = computed(() => this.store.settings() as SettingsP2);
  /**
   * The store `scopeKey` at which the current settings object arrived. Right after a portfolio switch the store still
   * holds the previous scope's settings (their `settings_owner` is the old owner), so the per-member meta is read only
   * once settings for today's scope are in (the shell's banner follows the same rule, W7-F1).
   */
  private readonly settingsScope = signal<string | null>(null);
  private readonly metaFresh = computed(() => this.settingsScope() === this.store.scopeKey());
  /** Whose settings row the page reads and writes; absent on a server without R8, null while settings are stale. */
  readonly settingsOwner = computed(() => (this.metaFresh() ? this.s2().settings_owner ?? null : null));
  /**
   * The "Editing the family plan" banner: the family view, or a member view whose saves still land on the family
   * plan (`settings_owner` is `__global__`, a server without R11's write path).
   */
  readonly familyBanner = computed(() => this.familyView()
    || (this.auth.canSwitch() && !!this.auth.portfolio() && this.settingsOwner() === GLOBAL_OWNER));
  /** An admin's or guest's member view whose settings are the member's own: "Saving to {member}'s plan". */
  readonly memberPlan = computed(() => {
    const owner = this.settingsOwner();
    if (!this.auth.canSwitch() || !this.auth.portfolio() || !owner || owner === GLOBAL_OWNER) return null;
    const self = owner.toLowerCase() === (this.auth.user()?.email ?? '').toLowerCase();
    const member = this.auth.members().find(m => m.email.toLowerCase() === owner.toLowerCase());
    const name = member?.name || (owner.toLowerCase() === this.auth.portfolio()!.toLowerCase() ? this.auth.portfolioLabel() : owner);
    return { self, name, whose: self ? 'your own' : `${name}'s` };
  });
  private readonly inheritedKeys = computed(() => new Set(this.metaFresh() ? this.s2().inherited ?? [] : []));
  /** A card whose key still comes from the family plan (the member has no row of its own for it). */
  inherited(group: InheritGroup): boolean {
    const keys = this.inheritedKeys();
    return keys.size > 0 && INHERIT_GROUPS[group].some(k => keys.has(k));
  }

  // ── Assumptions (P2.10, R4, R19) ──
  readonly book = signal<AssumptionsView | null>(null);
  readonly bookLoading = signal(false);
  readonly bookError = signal<string | null>(null);
  /** Draft edits by Book key, relative to each row's base (the saved override, else what is in use). */
  readonly bookEdits = signal<Readonly<Record<string, BookEdit>>>({});
  /** Keys whose saved override the user is dropping on the next save. */
  readonly bookClear = signal<ReadonlySet<string>>(new Set());
  /** The inflation draft; undefined = not edited, null = emptied (falls back to the default). */
  readonly inflEdit = signal<number | null | undefined>(undefined);
  readonly bookSaving = signal(false);
  readonly bookSaveError = signal<string | null>(null);
  /** After a save or reset: the Book's new hash, shown with "Every forecast now uses these". */
  readonly bookSaved = signal<{ hash: string; reset: boolean } | null>(null);
  private bookSeq = 0;
  /** A save is waiting for the next /assumptions load to report its hash. */
  private announce: { after: number; reset: boolean } | null = null;
  private bookScope: string | null = null;

  readonly savedOverrides = computed<AssumptionOverrides | null>(() => {
    const a = this.s2().assumptions;
    return a && typeof a === 'object' && !Array.isArray(a) ? a : null;
  });
  readonly bookRows = computed<BookRow[]>(() => {
    const view = this.book();
    if (!view) return [];
    const saved = this.savedOverrides()?.segments ?? {};
    const edits = this.bookEdits();
    const clear = this.bookClear();
    return (view.segments ?? []).map(seg => {
      const sv = saved[seg.key];
      const ov = sv && Number.isFinite(+sv.return_pct) && Number.isFinite(+sv.vol_pct) ? { return_pct: +sv.return_pct, vol_pct: +sv.vol_pct } : null;
      const source = (seg.source === 'override' || seg.source === 'holding rates' ? seg.source : 'default') as BookRow['source'];
      const rated = source === 'holding rates' && RATED_KEYS.has(seg.key);
      const clearing = clear.has(seg.key) && !!ov;
      const baseRet = ov?.return_pct ?? seg.return_pct;
      const baseVol = ov?.vol_pct ?? seg.volatility_pct;
      const e = edits[seg.key] ?? {};
      const dRet = rated ? baseRet : (e.ret !== undefined ? e.ret : baseRet);
      const dVol = e.vol !== undefined ? e.vol : baseVol;
      const edited = !clearing && (!same(dRet, baseRet) || !same(dVol, baseVol));
      return {
        key: seg.key, label: seg.key === MF_DEBT ? 'Mutual Funds (debt)' : (seg.label || seg.key), weight: seg.weight_pct ?? 0,
        ret: seg.return_pct, vol: seg.volatility_pct, source, capped: !!seg.capped, saved: ov, rated,
        dRet, dVol, clearing, changed: clearing || edited,
        retErr: clearing || rated ? null : rangeErr(dRet, RET_RANGE),
        volErr: clearing ? null : rangeErr(dVol, VOL_RANGE),
      };
    });
  });
  readonly overrideCount = computed(() => this.bookRows().filter(r => r.saved).length);
  /** The saved inflation override, or null. */
  readonly savedInfl = computed(() => {
    const v = this.savedOverrides()?.inflation_pct;
    return v != null && Number.isFinite(+v) ? +v : null;
  });
  /** The inflation figure the input shows: the draft, else the saved override, else the Book's (6% by default). */
  readonly inflValue = computed<number | null>(() => {
    const e = this.inflEdit();
    return e !== undefined ? e : (this.savedInfl() ?? this.book()?.inflation_pct ?? null);
  });
  /** Empty means "use the default", so only an out-of-range figure is an error. */
  readonly inflErr = computed(() => (this.inflValue() == null ? null : rangeErr(this.inflValue(), INFL_RANGE)));
  readonly inflChanged = computed(() => {
    const e = this.inflEdit();
    if (e === undefined) return false;
    if (e == null) return this.savedInfl() != null;
    return !same(e, this.savedInfl() ?? this.book()?.inflation_pct ?? NaN);
  });
  readonly bookDirty = computed(() => this.bookRows().some(r => r.changed) || this.inflChanged());
  readonly bookValid = computed(() => !this.inflErr() && this.bookRows().every(r => !r.retErr && !r.volErr));
  readonly hasOverrides = computed(() => {
    const o = this.savedOverrides();
    return !!o && (Object.keys(o.segments ?? {}).length > 0 || o.inflation_pct != null);
  });

  // ── Prices & tickers ──
  private priceChoice = signal<'missing' | 'all' | null>(null);
  private tradableAll = computed(() => this.store.positions().filter(p => TRADABLE.includes(p.asset_class)));
  readonly missingCount = computed(() => this.tradableAll().filter(p => p.is_open && !p.has_price).length);
  /** Missing only when something is missing, otherwise All; the user's own pick wins once made. */
  readonly priceFilter = computed(() => this.priceChoice() ?? (this.missingCount() > 0 ? 'missing' : 'all'));
  readonly tradables = computed(() => this.tradableAll()
    .filter(p => this.priceFilter() === 'all' || (p.is_open && !p.has_price))
    .sort((a, b) => Number(b.is_open) - Number(a.is_open) || a.name.localeCompare(b.name)));

  // ── Read-only summaries ──
  readonly targetsSet = computed(() => Object.values(this.store.settings().targetAllocation ?? {}).some(v => +v > 0));
  readonly profileLabel = computed(() => {
    const k = this.store.settings().riskProfile;
    return k ? (PROFILE_LABEL[k] ?? k) : null;
  });
  readonly retireAge = computed(() => {
    const rp = this.store.settings().retirementPlan;
    const age = rp && typeof rp === 'object' ? Number(rp['retire_age']) : NaN;
    return Number.isFinite(age) && age > 0 ? Math.round(age) : null;
  });
  readonly retirementSet = computed(() => {
    const rp = this.store.settings().retirementPlan;
    return !!rp && typeof rp === 'object' && Object.keys(rp).length > 0;
  });

  // ── Emergency cushion editor (A14, A25, H10) ──
  /** The saved setting, or null when it was never saved (or is not an object). */
  readonly savedEf = computed<EmergencyFund | null>(() => {
    const ef = this.store.settings().emergencyFund;
    return ef && typeof ef === 'object' ? ef : null;
  });
  readonly suggest = computed(() => this.store.settings().emergencyFundSuggest ?? null);
  readonly efExpenses = signal<number | null>(null);
  readonly efMonths = signal(EF_MONTHS_DEFAULT);
  readonly efCash = signal<number | null>(0);
  readonly efTicked = signal<ReadonlySet<number>>(new Set());
  /** Holdings the user added to the checklist from "Add another holding". */
  readonly efExtra = signal<number[]>([]);
  readonly efDirty = signal(false);
  readonly efSaving = signal(false);
  readonly efError = signal<string | null>(null);
  /** The expenses came from the retirement plan, not from a saved cushion. */
  readonly efFromHint = signal(false);
  private seededScope: string | null = null;

  readonly cushionRows = computed<CushionRow[]>(() => {
    const byId = new Map(this.store.positions().map(p => [p.id, p]));
    const cands = new Map((this.suggest()?.candidates ?? []).map(c => [c.instrument_id, c]));
    const ids: number[] = [];
    const seen = new Set<number>();
    const add = (id: number) => { if (Number.isInteger(id) && !seen.has(id)) { seen.add(id); ids.push(id); } };
    cands.forEach((_, id) => add(id));
    (this.savedEf()?.instrument_ids ?? []).forEach(add);
    this.efExtra().forEach(add);
    return ids.map(id => {
      const p = byId.get(id);
      const c = cands.get(id);
      if (p) {
        return { id, name: p.name, note: this.kindNote(c?.kind ?? null, p), value: p.is_open ? p.value : 0, gone: !p.is_open };
      }
      if (c) return { id, name: c.name, note: this.kindNote(c.kind, null), value: c.value, gone: false };
      return { id, name: `Holding #${id}`, note: 'Not found in this portfolio · untick it to save', value: 0, gone: true };
    });
  });
  /** Open holdings with value that are not on the checklist yet, for "Add another holding". */
  readonly addable = computed(() => {
    const listed = new Set(this.cushionRows().map(r => r.id));
    return this.store.openPositions().filter(p => p.value > 0 && !listed.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  });
  readonly tickedAmount = computed(() => this.cushionRows().filter(r => this.efTicked().has(r.id)).reduce((a, r) => a + r.value, 0));
  readonly coverAmount = computed(() => this.tickedAmount() + Math.max(0, +(this.efCash() ?? 0) || 0));
  /** Live coverage in months: (Σ ticked values + cash) / monthly expenses (A25). Null without expenses. */
  readonly coverMonths = computed(() => {
    const e = this.efExpenses();
    return e != null && e > 0 ? this.coverAmount() / e : null;
  });
  /** Same bands as the Cushion vital: at or over target good, ≥ 3 months watch, else act. */
  readonly coverStatus = computed<Status>(() => {
    const m = this.coverMonths();
    if (m == null) return 'unset';
    return m >= this.efMonths() ? 'good' : m >= CUSHION_FLOOR_MONTHS ? 'watch' : 'act';
  });
  readonly coverWord = computed(() => ({ good: 'Covered', watch: 'Below target', act: 'Too thin', unset: 'Not set', info: '' })[this.coverStatus()]);
  readonly coverPct = computed(() => {
    const m = this.coverMonths();
    return m == null ? 0 : Math.max(0, Math.min(100, (m / this.efMonths()) * 100));
  });
  readonly coverPctNow = computed(() => Math.round(this.coverPct()));
  readonly coverLabel = computed(() => {
    const m = this.coverMonths();
    return m == null ? '—' : m.toFixed(1);
  });
  readonly shortBy = computed(() => {
    const e = this.efExpenses();
    return e != null && e > 0 ? Math.max(0, this.efMonths() * e - this.coverAmount()) : 0;
  });

  readonly expensesErr = computed(() => {
    const v = this.efExpenses();
    return v != null && (!Number.isFinite(v) || v < 0 || v > EF_MAX_EXPENSES) ? 'Enter an amount between ₹0 and ₹1 crore' : null;
  });
  readonly cashErr = computed(() => {
    const v = this.efCash();
    return v != null && (!Number.isFinite(v) || v < 0 || v > EF_MAX_CASH) ? 'Enter an amount between ₹0 and ₹10 crore' : null;
  });
  readonly monthsErr = computed(() => {
    const m = this.efMonths();
    return Number.isInteger(m) && m >= EF_MONTHS_MIN && m <= EF_MONTHS_MAX ? null : `Pick ${EF_MONTHS_MIN} to ${EF_MONTHS_MAX} months`;
  });
  readonly efValid = computed(() => !this.expensesErr() && !this.cashErr() && !this.monthsErr());

  constructor() {
    // Record the scope each settings object arrived at (tracks only `settings`; see `settingsScope`).
    effect(() => {
      this.store.settings();
      untracked(() => this.settingsScope.set(this.store.scopeKey()));
    });
    effect(() => {
      const s = this.store.settings();
      this.slab = +(s.taxSlabRate ?? 30);
      this.autoFlows = String(s.autoCapitalFlows ?? 'true') !== 'false';
      const m = s.marketAlerts ?? {};
      this.alerts = { enabled: true, push: true, day: 5, week: 10, ...m, digest: m.digest === true };
    });
    // Seed the cushion draft from the saved setting (or the suggestion) whenever settings arrive, unless the user is
    // mid-edit in the same portfolio. A switch of portfolio always reseeds: the draft belonged to the other one.
    effect(() => {
      const s = this.store.settings();
      const scope = this.store.scopeKey();
      untracked(() => {
        if (this.seededScope !== scope) { this.efDirty.set(false); this.efExtra.set([]); this.efError.set(null); }
        this.seededScope = scope;
        if (!this.efDirty()) this.seedCushion(s.emergencyFund, s.emergencyFundSuggest ?? null);
      });
    });
    // The Book follows the portfolio on screen and every write (a save here bumps `version` too). A switch of
    // portfolio drops the assumptions draft: it belonged to the other settings owner.
    effect(() => {
      this.store.version();
      const scope = this.store.scopeKey();
      untracked(() => {
        if (this.bookScope !== null && this.bookScope !== scope) this.discardBook();
        if (this.bookScope !== scope) this.bookSaved.set(null);
        this.bookScope = scope;
        void this.loadBook();
      });
    });
    void this.push.load();
    if (this.auth.isAdmin()) this.loadUsers();

    const destroyRef = inject(DestroyRef);
    this.route.fragment.pipe(takeUntilDestroyed(destroyRef)).subscribe(f => this.settle(f));
    destroyRef.onDestroy(() => this.stopSettle?.());
  }

  private seedCushion(ef: EmergencyFund | null | undefined, sug: EmergencyFundSuggest | null) {
    const saved = ef && typeof ef === 'object' ? ef : null;
    const savedExp = saved?.monthly_expenses != null && +saved.monthly_expenses > 0 ? +saved.monthly_expenses : null;
    const hint = sug?.monthly_expenses_hint != null && +sug.monthly_expenses_hint > 0 ? +sug.monthly_expenses_hint : null;
    this.efExpenses.set(savedExp ?? hint);
    this.efFromHint.set(savedExp == null && hint != null);
    const m = Number(saved?.months_target);
    this.efMonths.set(Number.isInteger(m) && m >= EF_MONTHS_MIN && m <= EF_MONTHS_MAX ? m : EF_MONTHS_DEFAULT);
    this.efCash.set(saved ? Math.max(0, +(saved.cash_amount ?? 0) || 0) : 0);
    // Set → exactly the saved ids; unset → every suggested candidate.
    this.efTicked.set(new Set(saved ? (saved.instrument_ids ?? []).map(Number) : (sug?.candidates ?? []).map(c => c.instrument_id)));
  }

  private kindNote(kind: string | null, p: Position | null): string {
    if (kind === 'usd' || p?.asset_class === 'cash') return 'USD wallet';
    if (kind === 'fd' || p?.asset_class === 'fixed_deposit') {
      return p?.maturity_date ? `Fixed deposit · matures ${fmtDate(p.maturity_date)}` : 'Fixed deposit';
    }
    if (kind === 'mf_debt') return 'Debt fund';
    if (!p) return 'Suggested';
    return `${CLASS_LABEL[p.asset_class] ?? p.asset_class}${p.is_open ? '' : ' · closed, adds nothing'}`;
  }

  // ── Cushion edits ──
  setExpenses(v: number | null | string) { this.efExpenses.set(v === '' || v == null ? null : +v); this.efFromHint.set(false); this.touch(); }
  setMonths(v: number) { this.efMonths.set(+v); this.touch(); }
  setCash(v: number | null | string) { this.efCash.set(v === '' || v == null ? null : +v); this.touch(); }
  toggle(id: number, on: boolean) {
    this.efTicked.update(s => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
    this.touch();
  }
  addHolding(raw: string | number) {
    const id = +raw;
    if (!Number.isInteger(id) || id <= 0) return;
    this.efExtra.update(x => (x.includes(id) ? x : [...x, id]));
    this.toggle(id, true);
  }
  private touch() { this.efDirty.set(true); this.efError.set(null); }
  discardCushion() {
    this.efDirty.set(false);
    this.efExtra.set([]);
    this.efError.set(null);
    const s = this.store.settings();
    this.seedCushion(s.emergencyFund, s.emergencyFundSuggest ?? null);
  }

  /** PUT /settings/emergencyFund (H10). A 400 (an id outside this portfolio, a bound) shows inline under the form. */
  async saveCushion() {
    if (!this.efValid() || this.efSaving() || !this.auth.canWrite()) return;
    const exp = this.efExpenses();
    const value: EmergencyFund = {
      months_target: this.efMonths(),
      monthly_expenses: exp != null && exp > 0 ? Math.round(exp * 100) / 100 : null,
      instrument_ids: this.cushionRows().filter(r => this.efTicked().has(r.id)).map(r => r.id),
      cash_amount: Math.round(Math.max(0, +(this.efCash() ?? 0) || 0) * 100) / 100,
    };
    this.efSaving.set(true);
    this.efError.set(null);
    try {
      // saveSetting reloads settings; the seeding effect then sees a clean draft and reseeds from the saved value
      this.efDirty.set(false);
      this.efExtra.set([]);
      await this.store.saveSetting('emergencyFund', value);
      this.toast.ok(value.monthly_expenses ? `Cushion saved · ${inr(this.coverAmount())} set aside` : 'Cushion saved');
    } catch (e) {
      this.efDirty.set(true);
      this.efError.set(errorMessage(e));
    } finally {
      this.efSaving.set(false);
    }
  }

  // ── Assumptions ──
  readonly ranges = { ret: RET_RANGE, vol: VOL_RANGE, infl: INFL_RANGE };
  /** A percentage with at most 2 decimals and no trailing zeros: 12%, 8.25%, 10.5%. */
  p(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(+v)) return '—';
    return `${(+v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
  }
  sourceWord(s: BookRow['source']): string {
    return s === 'override' ? 'Your setting' : s === 'holding rates' ? 'From your holdings' : 'Default';
  }
  /** "2 classes and inflation changed from the defaults". */
  changedWord(): string {
    const n = this.overrideCount();
    const parts = [n ? `${n} class${n === 1 ? '' : 'es'}` : '', this.savedInfl() != null ? 'inflation' : ''].filter(Boolean);
    return `${parts.join(' and ')} changed from the defaults`;
  }

  /** GET /assumptions for the portfolio on screen. The latest request wins; a failure keeps the last good view. */
  async loadBook() {
    const seq = ++this.bookSeq;
    this.bookLoading.set(true);
    try {
      const view = await firstValueFrom(this.api.assumptions());
      if (seq !== this.bookSeq) return;
      this.book.set(view);
      this.bookError.set(null);
      if (this.announce && seq > this.announce.after) {
        this.bookSaved.set({ hash: view.hash, reset: this.announce.reset });
        this.announce = null;
      }
    } catch (e) {
      if (seq === this.bookSeq) this.bookError.set(errorMessage(e));
    } finally {
      if (seq === this.bookSeq) this.bookLoading.set(false);
    }
  }

  private toNum(v: unknown): number | null {
    if (v === '' || v == null) return null;
    const n = +(v as number);
    return Number.isFinite(n) ? n : null;
  }
  private bookTouch() { this.bookSaveError.set(null); this.bookSaved.set(null); }
  setRet(key: string, v: unknown) {
    this.bookEdits.update(m => ({ ...m, [key]: { ...m[key], ret: this.toNum(v) } }));
    this.bookTouch();
  }
  setVol(key: string, v: unknown) {
    this.bookEdits.update(m => ({ ...m, [key]: { ...m[key], vol: this.toNum(v) } }));
    this.bookTouch();
  }
  setInfl(v: unknown) { this.inflEdit.set(this.toNum(v)); this.bookTouch(); }
  /** Drop this row's override on the next save, so the row goes back to the Book's default. */
  useDefault(key: string) {
    this.bookClear.update(s => new Set(s).add(key));
    this.bookEdits.update(m => { const n = { ...m }; delete n[key]; return n; });
    this.bookTouch();
  }
  keepOverride(key: string) {
    this.bookClear.update(s => { const n = new Set(s); n.delete(key); return n; });
    this.bookTouch();
  }
  discardBook() {
    this.bookEdits.set({});
    this.bookClear.set(new Set());
    this.inflEdit.set(undefined);
    this.bookSaveError.set(null);
  }

  /**
   * The `assumptions` value to PUT (§7.7). The PUT replaces the whole setting, so besides the rows changed here it
   * keeps every saved override that was not dropped; untouched default rows are never sent (they would freeze
   * today's defaults). A row needs both numbers (R4): a "from your holdings" row sends its saved return, else the
   * rate in use, clamped to the range; the engines keep using the holdings' rates while such holdings exist.
   * Inflation is sent when it was saved before or now differs from the Book's.
   */
  bookPayload(): AssumptionOverrides {
    const segments: Record<string, { return_pct: number; vol_pct: number }> = {};
    const shown = new Set<string>();
    for (const r of this.bookRows()) {
      shown.add(r.key);
      if (r.clearing) continue;
      if (r.changed) {
        const ret = r.rated ? Math.min(RET_RANGE[1], Math.max(RET_RANGE[0], r.dRet ?? 0)) : (r.dRet as number);
        segments[r.key] = { return_pct: round2(ret), vol_pct: round2(r.dVol as number) };
      } else if (r.saved) {
        segments[r.key] = { ...r.saved };
      }
    }
    // A saved row the view did not list (an older Book) is kept as it is.
    for (const [k, v] of Object.entries(this.savedOverrides()?.segments ?? {})) if (!shown.has(k)) segments[k] = v;
    const out: AssumptionOverrides = {};
    if (Object.keys(segments).length) out.segments = segments;
    const e = this.inflEdit();
    if (e === undefined) {
      if (this.savedInfl() != null) out.inflation_pct = this.savedInfl()!;
    } else if (e != null && (this.savedInfl() != null || this.inflChanged())) {
      out.inflation_pct = round2(e);
    }
    return out;
  }

  /** PUT /settings/assumptions with the changed rows; a 400 shows inline and keeps the draft. */
  async saveBook() {
    if (!this.bookValid() || !this.bookDirty() || this.bookSaving() || !this.auth.canWrite()) return;
    await this.writeBook(this.bookPayload(), false);
  }

  /** "Reset to defaults": PUT null after a confirm, which clears every override (R4). */
  async resetBook() {
    if (this.bookSaving() || !this.auth.canWrite()) return;
    const ok = await this.confirm.ask('Reset the assumptions to the defaults?',
      'Every return, volatility and inflation figure you changed goes back to the Assumption Book. Every forecast is recomputed.', 'Reset');
    if (ok) await this.writeBook(null, true);
  }

  private async writeBook(value: AssumptionOverrides | null, reset: boolean) {
    this.bookSaving.set(true);
    this.bookSaveError.set(null);
    this.bookSaved.set(null);
    // The save bumps `version`; the next /assumptions load after this point carries the new hash.
    this.announce = { after: this.bookSeq, reset };
    try {
      await this.store.saveSetting('assumptions', value);
      this.discardBook();
      this.toast.ok(reset ? 'Assumptions back to the defaults' : 'Assumptions saved');
    } catch (e) {
      this.announce = null;
      this.bookSaveError.set(errorMessage(e));
    } finally {
      this.bookSaving.set(false);
    }
  }

  // ── Rail ──
  /** Scroll to a section and put its fragment in the address bar without a router navigation (so a second tap still scrolls). */
  go(id: SectionId, ev?: Event) {
    ev?.preventDefault();
    this.stopSettle?.();
    const el = this.doc.getElementById(id);
    if (!el) return;
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    this.active.set(id);
    this.location.replaceState(`${this.location.path(false)}#${id}`);
  }

  /** The active rail item is the last section whose top has passed just under the app bar. */
  @HostListener('window:scroll')
  onScroll() {
    const ids = this.sections().map(s => s.id);
    const win = this.doc.defaultView;
    if (!win) return;
    let cur: SectionId = ids[0];
    for (const id of ids) {
      const el = this.doc.getElementById(id);
      if (el && el.getBoundingClientRect().top <= 120) cur = id;
    }
    // At the very bottom the last short section may never reach the line; pick it anyway.
    if (win.innerHeight + win.scrollY >= this.doc.documentElement.scrollHeight - 4) cur = ids[ids.length - 1];
    if (cur !== this.active()) this.active.set(cur);
  }

  /**
   * Keep `#id` aligned while the page settles. The router scrolls to the anchor once, right after navigation;
   * the portfolio and settings may still be arriving and change the height above it. Until the user scrolls,
   * taps or types (or SETTLE_MS passes), re-align whenever the page's height changes.
   */
  private settle(id: string | null | undefined) {
    this.stopSettle?.();
    this.stopSettle = null;
    if (!id || !ANCHORS.has(id) || typeof window === 'undefined') return;
    const align = () => this.doc.getElementById(id)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => align()) : null;
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    const stop = () => {
      ro?.disconnect();
      clearTimeout(first);
      clearTimeout(end);
      events.forEach(e => window.removeEventListener(e, stop));
      if (this.stopSettle === stop) this.stopSettle = null;
    };
    // Two macrotasks later: after this navigation's render and after the router's own anchor scroll.
    let first = setTimeout(() => { first = setTimeout(() => { align(); ro?.observe(this.host.nativeElement); }); });
    const end = setTimeout(stop, SETTLE_MS);
    events.forEach(e => window.addEventListener(e, stop, { passive: true }));
    this.stopSettle = stop;
  }

  // ── Other sections ──
  setPriceFilter(f: 'missing' | 'all') { this.priceChoice.set(f); }

  async put(key: string, value: unknown, msg: string) {
    this.saving.set(true);
    try { await this.store.saveSetting(key, value); this.toast.ok(msg); }
    catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.saving.set(false); }
  }
  saveRecovery(v: string) {
    const n = Math.round(+v);
    if (Number.isFinite(n) && n >= 0 && n <= 100) void this.put('p2pDefaultRecovery', n, 'Saved: defaulted loans count at ' + n + '%');
  }
  /** The whole alerts object, `digest` included: the server stores false for a missing `digest` (R8). */
  saveAlerts() { return this.put('marketAlerts', { ...this.alerts, digest: this.alerts.digest === true }, 'Alert settings saved'); }
  async enablePush() {
    if (await this.push.enable()) this.toast.ok('Notifications are on for this device');
  }
  async testPush() {
    if (await this.push.test()) this.toast.ok('Test sent; it should arrive in a few seconds');
  }
  saveSlab() { return this.put('taxSlabRate', this.slab, 'Tax slab saved'); }
  saveAuto() { return this.put('autoCapitalFlows', this.autoFlows ? 'true' : 'false', 'Saved'); }

  async loadUsers() {
    try { this.users.set((await firstValueFrom(this.api.users())).users); } catch (e) { this.toast.error(errorMessage(e)); }
  }
  async addUser() {
    try {
      await firstValueFrom(this.api.addUser(this.newEmail.trim(), this.newRole));
      this.toast.ok(`${this.newEmail} added`);
      this.newEmail = '';
      await this.loadUsers();
    } catch (e) { this.toast.error(errorMessage(e)); }
  }
  async setRole(u: AllowlistUser, role: string) {
    try { await firstValueFrom(this.api.setRole(u.email, role)); this.toast.ok(`${u.email} is now ${role}`); await this.loadUsers(); }
    catch (e) { this.toast.error(errorMessage(e)); await this.loadUsers(); }
  }
  async removeUser(u: AllowlistUser) {
    if (!(await this.confirm.ask(`Remove ${u.email}?`, 'They will be signed out on their next request. Their data stays in the database.', 'Remove'))) return;
    try { await firstValueFrom(this.api.removeUser(u.email)); this.toast.ok('Removed'); await this.loadUsers(); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }
  viewAs(u: AllowlistUser) {
    this.auth.startViewAs({ email: u.email, name: u.name, picture: u.picture, role: u.role });
    this.toast.info(`Now viewing ${u.name || u.email}'s portfolio`);
  }
}
