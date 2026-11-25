export type AssetClass = 'equity' | 'mutual_fund' | 'commodity' | 'p2p' | 'fixed_deposit' | 'cash' | 'epf' | 'nps';
export type TxnType = 'BUY' | 'SELL' | 'DIVIDEND' | 'INTEREST' | 'REPAYMENT' | 'MATURITY' | 'FX_IN' | 'FX_OUT' | 'CREDIT' | 'BONUS' | 'SPLIT';
export type Role = 'admin' | 'user' | 'guest';

export const SEGMENTS = ['Equity (India)', 'Equity (USA)', 'Mutual Funds', 'Commodity', 'P2P', 'Fixed Deposits', 'EPF', 'NPS'] as const;
export type Segment = typeof SEGMENTS[number];

/** Fixed categorical slot per segment — colour follows the entity, never its rank. */
export const SEGMENT_COLOR: Record<string, string> = {
  'Equity (India)': 'var(--s1)',
  'Equity (USA)': 'var(--s2)',
  'Mutual Funds': 'var(--s3)',
  'Commodity': 'var(--s4)',
  'P2P': 'var(--s5)',
  'Fixed Deposits': 'var(--s6)',
  'EPF': 'var(--s7)',
  'NPS': 'var(--s8)',
};

/** Friendly name, icon and page for each segment. */
export const SEGMENT_META: Record<string, { label: string; icon: string; route: string }> = {
  'Equity (India)': { label: 'Indian stocks', icon: 'trend', route: '/holdings/equity' },
  'Equity (USA)': { label: 'US stocks', icon: 'globe', route: '/holdings/equity' },
  'Mutual Funds': { label: 'Mutual funds', icon: 'layers', route: '/holdings/mutual_fund' },
  'Commodity': { label: 'Gold & silver', icon: 'coins', route: '/holdings/commodity' },
  'P2P': { label: 'P2P lending', icon: 'users', route: '/p2p' },
  'Fixed Deposits': { label: 'Fixed deposits', icon: 'bank', route: '/fixed-deposits' },
  'EPF': { label: 'EPF', icon: 'shield', route: '/epf' },
  'NPS': { label: 'NPS', icon: 'lotus', route: '/nps' },
};

/** Accent per asset class, matching the segment slots. */
export const CLASS_COLOR: Record<AssetClass, string> = {
  equity: 'var(--s1)', mutual_fund: 'var(--s3)', commodity: 'var(--s4)', p2p: 'var(--s5)', fixed_deposit: 'var(--s6)', cash: 'var(--s2)',
  epf: 'var(--s7)', nps: 'var(--s8)',
};

export const CLASS_LABEL: Record<AssetClass, string> = {
  equity: 'Stocks', mutual_fund: 'Mutual funds', commodity: 'Commodities', p2p: 'P2P lending',
  fixed_deposit: 'Fixed deposits', cash: 'USD wallet', epf: 'EPF', nps: 'NPS',
};

export const TXN_LABEL: Record<TxnType, string> = {
  BUY: 'Buy', SELL: 'Sell', DIVIDEND: 'Dividend', INTEREST: 'Interest', REPAYMENT: 'Repayment',
  MATURITY: 'Maturity', FX_IN: 'USD deposit', FX_OUT: 'USD withdrawal', CREDIT: 'Interest credited', BONUS: 'Bonus', SPLIT: 'Split',
};

export interface Member { email: string; name: string; role: Role; self: boolean; }

export interface Notice { id: string; kind: string; title: string; body: string; date: string | null; days: number | null;
  link: string | null; severity: 'critical' | 'warning' | 'info';
  /** P2 (K19, D15): read from `action_log.seen_at`. Action notices have ids `act:<action id>`. */
  seen?: boolean; }
/** GET /notifications. `unread` arrives with W7-B1 (K19); a wave-6 server sends only `items`. */
export interface NotificationsResponse { items: Notice[]; unread?: number; }
/** POST /notifications/seen {ids} → the unread count after marking (K19). */
export interface NotificationsSeenResponse { unread: number; }

export type ColType = 'text' | 'date' | 'inr' | 'num' | 'pct' | 'qty';
export interface ReportColumn { key: string; label: string; type: ColType; }
export interface ReportMeta { key: string; group: string; title: string; description: string; filters: string[]; }
export interface Report extends ReportMeta {
  columns: ReportColumn[]; rows: Record<string, any>[]; totals: Record<string, any> | null; note?: string | null;
  subtitle: string | null; generated_at: string; portfolio: string;
}

export interface CasTxn { date: string; type: TxnType; quantity: number | null; amount: number; notes: string | null; duplicate?: boolean; }
export interface CasFund { key: string; name: string; amc: string | null; folio: string | null; amfi: string | null; isin: string | null;
  category: string | null; closing_units: number; value: number | null; nav: number | null; opening_only: boolean; skipped: number;
  transactions: CasTxn[]; matched_id: number | null; matched_name: string | null; new_count: number; duplicate_count: number; selected: boolean; }
export interface CasNps { key: string; pran: string; name: string; tier: string | null; fund_manager: string | null; units: number;
  nav: number | null; value: number | null; matched_id: number | null; action: 'update_nav' | 'create'; selected: boolean; }
export interface CasDemat { name: string; isin: string; symbol: string | null; units: number; price: number | null; value: number | null;
  account: string | null; app_units: number | null; app_name: string | null; status: 'match' | 'differs' | 'missing'; mutual_fund?: boolean; }
export interface CasPreview { file_type: string; cas_type: string; investor: string | null; period: { from: string | null; to: string | null };
  funds: CasFund[]; nps: CasNps[]; demat: CasDemat[]; warnings: string[]; }

/** LenDenClub import: what the uploaded reports say versus what the app holds. */
export interface LendenFile { name: string; kind: 'order_report' | 'investment_report'; from_date: string | null; to_date: string | null;
  loans: number; skipped: number; lending_types: string[];
  summary: Partial<Record<'invested' | 'principal' | 'interest' | 'fee' | 'net' | 'outstanding' | 'npa', number>>;
  app: { loans: number; invested: number; principal: number; net: number; fee: number }; }
export interface LendenRepayment { date: string; principal: number; interest: number; fees: number; amount: number; closes: boolean; }
export interface LendenNewLoan { loan_id: string; ref: string; order_id: string | null; lending_type: string | null; date: string;
  amount: number; tenure: number; rate: number | null; status: string; maturity_date: string | null; repayment: LendenRepayment | null; selected: boolean; }
export interface LendenPosting extends LendenRepayment { loan_id: string; instrument_id: number; ref: string; name: string;
  lending_type: string | null; selected: boolean; }
export interface LendenStatus { loan_id: string; instrument_id: number; ref: string; name: string; old_status: string; new_status: string; apply: boolean; }
export interface LendenPreview { files: LendenFile[]; new_loans: LendenNewLoan[]; repayments: LendenPosting[]; status_changes: LendenStatus[];
  details: { instrument_id: number; loan_id: string; ref: string; fields: Record<string, string | number> }[];
  review: { loan_id: string; ref: string; name: string; message: string }[]; overdue: { loan_id: string; ref: string; dpd: string }[]; }

/** Zerodha tradebook import: Kite's day-by-day trades against the app's entries, stock by stock. */
export interface KiteDay { date: string; type: 'BUY' | 'SELL'; quantity: number; amount: number; price: number; fills: number; exchanges: string[]; }
export interface KiteEntry { id: number; date: string; type: 'BUY' | 'SELL'; quantity: number; amount: number; notes: string | null; }
export interface KiteBlock { type: 'BUY' | 'SELL'; remove: KiteEntry[]; add: KiteDay[]; selected: boolean; message?: string; }
export interface KiteStock { symbol: string; name: string; instrument_id: number | null; new_instrument: Record<string, string | null> | null;
  isin: string | null; matched: number; add: (KiteDay & { selected: boolean })[]; split: KiteBlock[]; review: KiteBlock[];
  corrections: { txn_id: number; date: string; type: string; quantity: number; app_amount: number; kite_amount: number; selected: boolean }[];
  kept: KiteEntry[]; kite_net: number; app_net: number; }
export interface KitePreview { from_date: string; to_date: string; client_ids: string[]; trades: number; stocks: KiteStock[]; }

/** Markets: 1-week / 1-month price signals over the Nifty 200, holdings and watchlist. */
export type SignalKey = 'momentum_buy' | 'momentum_sell' | 'dip_buy' | 'profit_book';
export interface PriceMetrics { price: number; d1: number | null; w1: number | null; m1: number | null; vol: number | null;
  high_1m: number; low_1m: number; spark: number[]; }
export interface Signal { signal: SignalKey; title: string; note: string;
  /** P2 (K16): `signals.SIGNAL_LABEL`, "price pattern, not a forecast"; the copy travels with the signal. */
  label?: string; }
export interface MarketIdea extends Signal { symbol: string; name: string; industry: string | null; metrics: PriceMetrics;
  held: boolean; watching: boolean; score: number; }
export interface MarketMover { symbol: string; name: string; industry: string | null; metrics: PriceMetrics; held: boolean; }
export interface MarketHolding { id: number; name: string; symbol: string; segment: string; value: number; weight: number;
  gain_pct: number | null; quantity: number | null; metrics: PriceMetrics | null; signals: Signal[]; }
export interface WatchItem { id: number; owner: string; symbol: string; name: string; target_buy: number | null; target_sell: number | null;
  added_price: number | null; notes: string | null; created_at: string; industry: string | null; metrics: PriceMetrics | null;
  target_hit: 'buy' | 'sell' | null; since_added: number | null; held: boolean; signals: Signal[]; }
export interface MarketAlertsConfig { enabled: boolean; push: boolean; day: number; week: number;
  /** P2 (K19): the daily digest of up to 3 `now` actions; default false, validated by W7-B1. */
  digest?: boolean; }
export interface RebalanceHint extends MarketHolding { why: string; }
export interface MarketOverview { as_of: string; universe: string; universe_size: number; covered: number;
  index: { name: string; metrics: PriceMetrics | null }; breadth: { up: number; down: number; total: number };
  holdings: MarketHolding[]; watchlist: WatchItem[]; ideas: Record<SignalKey, MarketIdea[]>;
  movers: { day: { up: MarketMover[]; down: MarketMover[] }; week: { up: MarketMover[]; down: MarketMover[] } };
  sectors: { industry: string; count: number; w1: number; m1: number }[];
  rebalance: { has_targets: boolean; segments: { segment: string; pct: number; target: number; drift: number }[];
    trim: RebalanceHint[]; add: RebalanceHint[]; new_ideas: MarketIdea[] };
  alerts_config: MarketAlertsConfig; rules: Record<SignalKey, { m1: number; w1: number }>;
  /** P1 (H4): added outside the cached overview; null with fewer than 200 stored Nifty closes. */
  market_state?: MarketState | null; }
export interface MarketAlert { id: number; owner: string; key: string; kind: 'move' | 'target'; symbol: string | null; title: string;
  body: string | null; severity: string; link: string | null; pushed: number; created_at: string; }
export interface Ipo { id: number; owner: string; name: string; symbol: string | null; board: string | null;
  open_date: string | null; close_date: string | null; allotment_date: string | null; listing_date: string | null;
  price_low: number | null; price_high: number | null; lot_size: number | null; issue_size_cr: number | null; gmp: number | null;
  subscription: string | null; applied: boolean; lots_applied: number | null; lots_allotted: number | null; listing_price: number | null;
  notes: string | null; status: 'upcoming' | 'open' | 'closed' | 'listed'; min_investment: number | null; gmp_pct?: number;
  listing_gain_pct?: number; }
export interface PushConfig { available: boolean; public_key: string | null; devices: number; }

/** EPFO passbook import: one EPF holding per UAN, built from the uploaded statements. */
export interface EpfTxn { date: string; type: 'BUY' | 'SELL' | 'CREDIT'; amount: number; notes: string; member_id: string;
  kind: 'opening' | 'contribution' | 'withdrawal' | 'interest' | 'transfer_in' | 'transfer_out'; duplicate: boolean; }
export interface EpfSide { computed: number; statement: number | null; ok: boolean; }
export interface EpfPreview { uan: string | null; name: string | null; closing_balance: number; notes: string[]; new_count: number;
  account: { id: number; name: string } | null; transactions: EpfTxn[];
  statements: { member_id: string; establishment: string | null; fy: string; entries: number; closing: number;
    check: { ok: boolean; employee: EpfSide; employer: EpfSide } }[]; }

export interface AuthUser {
  email: string;
  name?: string | null;
  picture?: string | null;
  role: Role;
}

export interface Instrument {
  id: number;
  owner: string;
  asset_class: AssetClass;
  name: string;
  symbol: string | null;
  price_source: string | null;
  market: string | null;
  currency: string;
  sector: string | null;
  market_cap: string | null;
  category: string | null;
  sub_category: string | null;
  tax_class: string | null;
  platform: string | null;
  status: string;
  ref: string | null;
  ref2: string | null;
  rate: number | null;
  tenure_months: number | null;
  maturity_date: string | null;
  notes: string | null;
  last_price: number | null;
  prev_close: number | null;
  last_price_at: string | null;
}

export interface OpenLot { date: string; qty: number; cost: number; age_days: number; }

export interface Position {
  id: number;
  owner: string;
  name: string;
  asset_class: AssetClass;
  segment: string;
  /** Redesign group (backend domain.group_of). */
  group?: string;
  market: string | null;
  currency: string;
  sector: string | null;
  market_cap: string | null;
  category: string | null;
  sub_category: string | null;
  tax_class: string | null;
  symbol: string | null;
  platform: string | null;
  status: string;
  ref: string | null;
  ref2: string | null;
  rate: number | null;
  tenure_months: number | null;
  maturity_date: string | null;
  notes: string | null;
  quantity: number | null;
  avg_cost?: number | null;
  avg_cost_fc?: number | null;
  cost: number;
  cost_fc?: number | null;
  price?: number | null;
  prev_close?: number | null;
  price_at?: string | null;
  has_price: boolean;
  value: number;
  day_change: number;
  unrealized: number;
  unrealized_pct: number | null;
  invested: number;
  proceeds?: number;
  income: number;
  realized: number;
  total_return: number;
  xirr: number | null;
  weight: number;
  first_date: string | null;
  last_date: string | null;
  is_open: boolean;
  open_lots?: OpenLot[];
  txn_count: number;
  fx_gain?: number;
  stock_gain?: number;
  elss?: { unlocked_qty: number; locked_qty: number; unlocked_value: number | null; next_unlock: string | null };
  // P2P
  principal_repaid?: number;
  outstanding?: number;
  interest?: number;
  fees?: number;
  principal_loss?: number;
  overdue_days?: number;
  at_risk?: number;
  last_repayment?: string | null;
  /** P2P EMI status (the 5th of each month up to the maturity date), measured on data_as_of. */
  next_due?: string | null;
  emis_total?: number;
  emis_paid?: number;
  emis_behind?: number;
  data_as_of?: string;
  written_down?: number;
  /** P2P wallet (status 'wallet'): money added, top-ups inferred from loans, withdrawn, lent. */
  wallet?: { balance: number; added: number; topups: number; withdrawn: number; lent: number };
  // FD
  accrued_interest?: number;
  days_to_maturity?: number | null;
  maturity_value?: number | null;
  // EPF
  interest_credited?: number;
  // wallet
  balance_usd?: number;
  avg_rate?: number | null;
  current_rate?: number | null;
  deposited_usd?: number;
  withdrawn_usd?: number;
}

export interface SegmentSummary {
  segment: string;
  value: number;
  cost: number;
  invested: number;
  unrealized: number;
  realized: number;
  income: number;
  day_change: number;
  open_count: number;
  pct: number;
  target: number | null;
  /** Share of the classes that have a target; drift is measured against this. */
  mix_pct: number | null;
  drift: number | null;
  unrealized_pct: number | null;
  total_return: number;
  xirr: number | null;
}

export interface Totals {
  value: number;
  cost: number;
  unrealized: number;
  unrealized_pct: number | null;
  realized: number;
  income: number;
  total_gain: number;
  day_change: number;
  day_change_pct: number | null;
  xirr: number | null;
  open_positions: number;
  missing_prices: string[];
}

export interface Portfolio {
  as_of: string;
  usd_inr: number | null;
  totals: Totals;
  segments: SegmentSummary[];
  positions: Position[];
  contributions: { deposits: number; withdrawals: number; profit_withdrawals: number; net: number; p2p_escrow_balance: number };
  prices: { last_refresh: string | null; usd_inr: number | null };
}

export interface Transaction {
  id: number;
  owner: string;
  instrument_id: number;
  date: string;
  type: TxnType;
  quantity: number | null;
  amount: number;
  amount_fc: number | null;
  principal: number | null;
  fees: number | null;
  notes: string | null;
  source: string;
  legacy_ref?: string | null;
  instrument_name?: string;
  asset_class?: AssetClass;
  segment?: string;
  currency?: string;
}

/** GET /transactions query for one page (K4). Sending `page` is what switches the route to the paged object. */
export interface TransactionsPageParams {
  page: number;
  /** Clamped to 10–200 by the server; default 50. */
  size?: number;
  /** Case-insensitive, trimmed, ≤ 100 characters: instrument name, symbol, type and notes. */
  q?: string | null;
  sort?: 'date' | '-date' | 'amount' | '-amount' | 'name' | '-name';
  asset_class?: AssetClass | null;
  instrument_id?: number | null;
  type?: TxnType | null;
  from?: string | null;
  to?: string | null;
}
/** Money out (BUY, FX_IN) and in (SELL, DIVIDEND, INTEREST, REPAYMENT, MATURITY, FX_OUT); `net` = out − in. */
export interface TransactionsSums { count: number; out: number; in: number; net: number; }
/**
 * GET /transactions?page= (K4, P2.11). `rows` have the unpaged item shape. `sums` and `months` cover every filtered
 * row, not just the page. A page past the end has `rows: []` and the true `total`; `pages` is at least 1.
 */
export interface TransactionsPage {
  rows: Transaction[]; total: number; page: number; size: number; pages: number;
  sums: TransactionsSums;
  /** Newest first; 'YYYY-MM'. */
  months: { month: string; count: number; out: number; in: number }[];
}

export interface CashMovement {
  id: number;
  owner: string;
  account: 'capital' | 'p2p_escrow';
  date: string;
  direction: 'in' | 'out';
  amount: number;
  category: string | null;
  kind: string | null;
  notes: string | null;
  transaction_id: number | null;
  source: string;
}

export interface PerfPoint { date: string; value: number; cost: number; net_invested: number; index: number; groups?: Record<string, number>; [bench: string]: number | string | null | Record<string, number> | undefined; }
export interface Benchmark { key: string; label: string; symbol: string; end_value: number; xirr: number | null; index_return: number | null; excess_xirr: number | null; }
export interface PerfMetrics {
  range: string; start: string; end: string; days: number; start_value: number; end_value: number; net_flows: number; gain: number;
  twr: number | null; twr_annualised: number | null; xirr: number | null; volatility: number | null; max_drawdown: number | null;
  current_drawdown: number | null; sharpe: number | null; best_day: number | null; worst_day: number | null; positive_days_pct: number | null;
}
/** Drops the stretch before money really went in (a few hundred rupees for months), which otherwise
 *  flattens the rest of a value chart; keeps one point before the start for context. */
export function activeSeries(points: PerfPoint[], share = 0.05): PerfPoint[] {
  const peak = Math.max(0, ...points.map(p => Math.max(p.value, p.net_invested)));
  const first = points.findIndex(p => Math.max(p.value, p.net_invested) >= peak * share);
  return first > 1 ? points.slice(first - 1) : points;
}
export interface Contributor2 { id: number; name: string; group: string; asset_class: AssetClass; start_value: number; end_value: number; gain: number; }
export interface Performance { series: PerfPoint[]; metrics: PerfMetrics; benchmarks: Benchmark[]; monthly: { month: string; return: number | null }[]; segment?: string | null; contributors?: Contributor2[]; }

export interface RealizedLotTax {
  instrument_id: number; name: string; asset_class: AssetClass; tax_class: string; buy_date: string; sell_date: string;
  holding_days: number; qty: number; cost: number; proceeds: number; gain: number; term: string; rate: number | null; exempt_eligible: boolean;
}
export interface OpenLotTax {
  instrument_id: number; name: string; tax_class: string; date: string; qty: number; cost: number; value: number; gain: number;
  held_days: number; term: string; lt_on: string | null; days_to_lt: number; locked_until: string | null; tax_saving?: number;
}
export interface TaxReport {
  fy: string; start: string; end: string; slab_rate: number; years: string[];
  realized: RealizedLotTax[]; summary: Record<string, number>; total_realized: number;
  set_off: { st_loss: number; lt_loss: number; carry_forward_st: number; carry_forward_lt: number };
  equity_exemption: { limit: number; used: number; remaining: number };
  tax_lines: { group: string; rate: number; taxable: number; tax: number; slab: boolean }[];
  income: Record<string, number>; income_total: number;
  estimate: { capital_gains_tax: number; income_tax: number; cess: number; total: number };
  opportunities: {
    loss_harvest: { instrument_id: number; name: string; st_loss: number; lt_loss: number; qty: number }[];
    loss_harvest_total: number; loss_harvest_offsettable: number;
    ltcg_harvest: { unrealized_lt_equity_gain: number; remaining_exemption: number; suggested_booking: number; future_tax_saved: number; lots: OpenLotTax[] };
    upcoming_long_term: OpenLotTax[];
    open_lots: OpenLotTax[];
    /** Current FY only; an empty plan for other years. */
    harvest_plan?: HarvestPlan;
  };
}

export interface Insight {
  id: string; severity: 'critical' | 'warning' | 'info' | 'positive'; category: string;
  title: string; detail: string; action: string | null; link: string | null; amount: number | null;
}

export interface GoalProjection {
  current: number; progress_pct: number; months_left: number; expected_return: number; volatility: number;
  /** `required_sip` reaches the target in 75 of 100 futures ("needs"); `required_sip_typical` at the typical return. */
  projected: number; shortfall: number; required_sip: number | null; probability: number;
  status: 'achieved' | 'on_track' | 'at_risk' | 'off_track'; p10: number | null; p50: number | null; p90: number | null;
  path: { date: string; projected: number; contributed: number }[];
  /** W3 (G5): the Assumption Book numbers behind the projection, and the copy that labels them. */
  required_sip_typical?: number | null;
  assumptions?: ForwardAssumptions; honesty?: ProjectionHonesty; note?: string;
  /** P2 (K15): the plans linked to this goal (`sip_plans.goal_id`); a plan not running has `monthly_equiv` 0. */
  linked_sips?: LinkedSip[];
  /** Σ linked `monthly_equiv`; when > 0 it replaces `monthly_contribution` in the projection. */
  linked_monthly?: number;
  /** 'linked' when the linked plans fund the projection, else 'goal' (the goal's own monthly contribution). */
  contribution_source?: 'linked' | 'goal';
}
/** A SIP plan linked to a goal (K15): its monthly equivalent by the `monthly_sip_total` rule, no step-up. */
export interface LinkedSip { id: number; name: string | null; amount: number; frequency: SipFrequency; monthly_equiv: number; }

/** The §6.0 rule-2 block every forward-looking payload carries (AMENDMENTS G5). `hash` names the Book version. */
export interface ForwardAssumptions { return_pct: number; typical_pct: number; volatility_pct: number; inflation_pct: number; basis: string; hash: string; }

/** `opportunities.harvest_plan` in GET /tax (W3, A12): long-term equity lots to book and rebuy inside the exemption. */
export interface HarvestPlanLot { date: string; qty: number; cost: number; proceeds: number; gain: number; partial: boolean; }
export interface HarvestPlan {
  rows: { instrument_id: number; name: string; qty: number; proceeds: number; gain: number; lots: HarvestPlanLot[] }[];
  total_gain: number; future_tax_saved: number; note: string;
}
export interface Goal {
  id: number; name: string; target_amount: number; target_date: string; monthly_contribution: number;
  expected_return: number | null; allocation: Record<string, number>; priority: string | null; notes: string | null;
  projection: GoalProjection;
}

/**
 * One holding sold inside a sale leg (`tax.plan_sales`, K12). `tax` is this sale's own `what_if_sale` tax (negative
 * is tax saved); `order` is why it was picked: a loss first, then a long-term gain inside the exemption, then the rest.
 */
export interface SaleLeg {
  instrument_id: number; name: string; qty: number; proceeds: number; gain: number; st_gain: number; lt_gain: number;
  tax: number; order: 'loss' | 'lt_exempt' | 'other';
}
/**
 * The P2 fields (K13) arrive only on an `allow_sell` plan. FD and P2P never sell: they come as 'hold' with `let_mature`
 * (the amount over target); an over-target EPF or NPS comes as 'hold' with `locked`. `sells`, `covered` and
 * `tax_if_sold` (the leg's marginal tax) are on sell rows only when the server had the ledger.
 */
export interface RebalanceRow { segment: string; current: number; current_pct: number; target_pct: number; after_pct: number; action: 'buy' | 'sell' | 'hold'; amount: number;
  let_mature?: number; locked?: boolean; sells?: SaleLeg[]; covered?: number; tax_if_sold?: number; }
export interface RebalancePlan { rows: RebalanceRow[]; total: number; new_money: number; allow_sell: boolean; shortfall_to_targets: number; money_to_fix_without_selling: number; error?: string;
  /** Present when the request sent `net=deploy` (A15): the deploy money already held, taken out of each segment before planning. */
  net?: 'deploy'; netted?: Record<string, number>;
  /** P1 (H14, D2): months the no-sell fix takes at the SIP + 90-day inflow pace; 0 when nothing to fix, null when the plan has an error. */
  months_to_fix?: number | null;
  /** P2 (K13): Σ `let_mature` + locked excess on an allow_sell plan. */
  not_sold?: number;
  /** P2 (K12): all sales costed together, so the exemption is used once; with its slab and charges note. */
  tax_total?: number; tax_note?: string; }

export interface Settings {
  targetAllocation?: Record<string, number>;
  taxSlabRate?: number | string;
  lastReviewDate?: string;
  reviewSnapshot?: Record<string, number>;
  dismissedInsights?: Record<string, string>;
  autoCapitalFlows?: string;
  marketAlerts?: Partial<MarketAlertsConfig>;
  riskProfile?: string;
  retirementPlan?: Record<string, number>;
  /** P1 (§7.7, H10): the cushion the user names. Absent until it is saved. */
  emergencyFund?: EmergencyFund | null;
  /** Read-only, sent by GET /settings for the request's scope (H10); W5-F7 reads it. */
  emergencyFundSuggest?: EmergencyFundSuggest;
  /** P2 (§6.10, D14): up to 5 saved scenarios for Plan › Scenarios. */
  planScenarios?: PlanScenario[];
  /** P2 (§7.7): Book overrides per segment key, and inflation. */
  assumptions?: AssumptionOverrides;
  /** Read-only (P2.6): whose settings these are; the "Editing the family plan" banner reads it. */
  settings_owner?: string;
  /** Read-only (P2.6): the keys a member reads from `__global__`. */
  inherited?: string[];
  segments: string[];
  /** Redesign: the owner's own target mix by group (sums to 100). */
  groupTargets?: Record<string, number>;
  /** Redesign: show the switched-off pages (Plan, Markets, Actions…) in the navigation again. */
  advancedFeatures?: boolean;
  /** Redesign: % of a defaulted P2P loan's outstanding principal expected back (0–100). */
  p2pDefaultRecovery?: number;
  groups?: string[];
}

/** The `assumptions` setting (§7.7): return −5..25, vol 0..60, inflation 0..15; an unknown key is a 400. */
export interface AssumptionOverrides {
  segments?: Record<string, { return_pct: number; vol_pct: number }>;
  inflation_pct?: number;
}

/**
 * A `planScenarios` entry or an inline `/plan/compare` scenario (§6.10, D14). `return`, `retire_age`, `inflation_pct`
 * and `mix` are null to keep the baseline's; `mix` is {segment: pct} summing to 100 ± 0.5.
 */
export interface PlanScenario {
  name: string; sip: number; step: number; return: number | null; retire_age: number | null;
  lump_sums: { date: string; amount: number }[];
  inflation_pct: number | null; mix: Record<string, number> | null;
}
/**
 * POST /plan/compare body: ≤ 4 scenarios, each a `planScenarios` index or inline (guests ≤ 2 × 500 sims). An inline
 * scenario may be partial (R5, R20): an absent or null field keeps the baseline's value; a missing name reads "Scenario {n}".
 */
export interface PlanCompareRequest { scenarios: (number | Partial<PlanScenario>)[]; }
/** A compare-table row. `values` has one entry per column; `deltas` are against column 0 (the baseline), on CRN. */
export interface PlanCompareRow {
  key: string; label: string; format: 'inr' | 'pct' | 'pts' | 'age';
  values: (number | null)[]; deltas: (number | null)[];
}
/**
 * POST /plan/compare (§6.10, K19). Column 0 is the baseline, so compare(baseline, baseline) gives deltas of 0.
 * `paths` are each column's median per label; `band` is the baseline's p10–p90.
 */
export interface PlanCompare {
  columns: string[]; rows: PlanCompareRow[];
  paths: { name: string; p50: number[] }[];
  band: { p10: number[]; p90: number[] };
  labels: string[]; sims: number; assumptions: ForwardAssumptions;
  honesty: Partial<ProjectionHonesty> & Record<string, string>;
  /** R6, R20: today's plan as a resolved scenario ("Today's plan"), the editor's prefill. */
  baseline?: PlanScenario | null;
  /** R6, R20: each column's resolved scenario, column 0 first, ready to save. */
  scenarios?: PlanScenario[] | null;
  /** W7-B1: the horizon H in years every column is projected over. */
  years?: number;
}
/** One "What moves the needle" tile (§6.10, `GET /plan?detail=1`); `scenario` feeds "Try it". Points are deltas. */
export interface PlanSensitivity {
  key: 'sip' | 'retire' | 'returns' | 'inflation'; label: string;
  /** The change in the key's own unit: ₹ a month (sip), years (retire), points (returns, inflation); `label` words it. */
  change: number;
  retirement_pts: number | null; worst_goal_pts: number | null; scenario: PlanScenario;
  /** The goal `worst_goal_pts` is about (the lowest baseline chance in the compare); null without goals. */
  worst_goal?: { id: number | string; name: string } | null;
}

/** The `emergencyFund` setting (H10). `cash_amount` is bank money outside the tracker; it is reported, never subtracted. */
export interface EmergencyFund { months_target: number; monthly_expenses: number | null; instrument_ids: number[]; cash_amount: number; }
/** GET /settings `emergencyFundSuggest`: `brief.cushion_state` candidates, and `retirementPlan.monthly_expenses` as a hint. */
export interface EmergencyFundSuggest {
  candidates: { instrument_id: number; name: string; kind: string; value: number }[];
  candidates_amount: number; monthly_expenses_hint: number | null;
}

export interface SymbolHit { symbol: string; name: string; exchange: string; type: string; source: string; }
export interface AllowlistUser { email: string; added_date: string; role: Role; name: string | null; picture: string | null; last_login: string | null; }

export interface HealthComponent { key: string; label: string; weight: number; score: number; note: string; }
export interface Health { score: number; grade: string; components: HealthComponent[]; focus: { key: string; label: string; note: string }; }
export interface CalendarEvent { date: string; key: string; title: string; kind: 'festival' | 'national' | 'tax' | 'fy' | 'personal'; note: string; link: string | null; days: number; }
export interface Takeaway { key: string; icon: string; tone: 'pos' | 'neg' | 'neutral'; label: string; value: string; note: string; link: string | null; }
export interface Contributor { id: number; name: string; segment: string; gain: number; is_open: boolean; }
export interface Attribution {
  total: number; unrealized: number; realized: number; income: number; gross_gains: number; gross_losses: number;
  gainers: Contributor[]; losers: Contributor[]; segments: { segment: string; gain: number }[]; winners: number; losers_count: number;
}
export interface MarketCompare { you: number | null; value: number; since: string | null;
  rows: { key: string; label: string; xirr: number | null; end_value: number; diff_value: number; excess: number | null }[]; }
export interface Rhythm { months: { month: string; invested: number; withdrawn: number; net: number }[]; active_months: number; streak: number;
  invested: number; net: number; monthly_avg: number; pace: number; }
export interface Milestones { value: number; monthly: number; assumed_return: number; last_reached: { amount: number; label: string } | null; progress: number;
  ahead: { amount: number; label: string; months: number | null; when: string | null; in: string | null }[]; }
export interface Story { takeaways: Takeaway[]; attribution: Attribution; market: MarketCompare | null; rhythm: Rhythm; milestones: Milestones; }
export interface Pulse { health: Health; calendar: { events: CalendarEvent[]; theme: string | null; next_festival: CalendarEvent | null }; story: Story; }
export interface IncomeMonth { month: string; dividends: number; p2p_interest: number; fd_interest: number; total: number; }
export interface Income { months: IncomeMonth[]; last_12m: number; monthly_avg: number; top_payers: { instrument_id: number; name: string; amount: number }[]; }
export interface PriceHistory { symbol: string | null; currency: string | null; points: [string, number][]; trades: { date: string; type: 'BUY' | 'SELL'; quantity: number; amount: number; price: number | null }[]; }

/** Forecasting and planning (Forecast page, holding outlook). */
export interface ProjectionPoint { year: number; date: string; p10: number; p25: number; p50: number; p75: number; p90: number; expected: number; contributed: number; }
export interface Projection {
  years: number; sims: number; current: number; monthly_sip: number; step_up_pct: number; sip_plans_total: number;
  assumptions: { return_pct: number; volatility_pct: number; basis: string; inflation_pct: number;
    /** W3 (G5): the typical (median) annual return and the Book hash. */
    typical_pct?: number; hash?: string;
    /** Wave-6 review: `return_pct` is the return the simulation used; this is the one asked for (override or record blend). */
    requested_return_pct?: number;
    /** Set only when the two differ (δ's ±5-point cap, or almost nothing market-linked); show it beside the return. */
    return_note?: string | null;
    own: { return_pct: number | null; volatility_pct: number | null } | null;
    mix: { segment: string; weight_pct: number; return_pct: number; volatility_pct: number }[] };
  path: ProjectionPoint[];
  end: { p10: number; p50: number; p90: number; expected: number; contributed: number; real_p50: number; gain_p50: number; probability_of_loss: number;
    /** P2 (K9, D5): only with `after_tax=1`; the horizon value if sold, at today's rules. */
    after_tax?: AfterTaxEnd };
  /** Percentiles of the one simulation (SPEC §1.9): base = end p50 (typical), bear = p10, bull = p90. */
  scenarios: { bear: number; base: number; bull: number; no_more_investing: number };
  milestones: { amount: number; label: string; probability: number; median_months: number; median_year: number }[];
  /** (end p50 / contributed)^(1/years) − 1, in %; null when nothing goes in. */
  typical_cagr_pct: number | null;
  /** The §1.9 copy for each number; `expected` (the mean) is shown only with `mean`, at T3. */
  honesty: ProjectionHonesty;
  note?: string;
  /* P2 (K9): the projection runs on `simulate.run`. */
  engine?: 'simulate';
  /** Horizon medians by segment (debt funds folded into Mutual Funds), largest first. */
  by_key?: Record<string, number>;
  /** % of futures worth less than what went in, 3 years out. */
  prob_below_contributed_3y?: number | null;
  /** The typical worst fall from a peak along the way, as a positive percent. */
  max_drawdown_p50?: number | null;
  /** 'plans': each SIP plan on its own class and dates; 'mix': one monthly amount spread over the mix. */
  flows_basis?: 'plans' | 'mix';
  /** How far the Book was shifted to the blended return and volatility (0 and 1 when it was not). */
  calibration?: { delta_pct: number; vol_scale: number };
}
/** `end.after_tax` (K8, K9): the horizon value if everything were sold, after capital-gains tax; `note` names the rules. */
export interface AfterTaxEnd { p10: number; p50: number; p90: number; note: string; }
export interface ProjectionHonesty { p50: string; p10: string; p90: string; mean: string; probability: string; estimate: string; signal: string;
  /** W4-B2 (H16): the cone's own label, "statistical range at the asset class's long-run return; not a forecast". */
  cone?: string;
  disclaimer?: string; }
/** Cash flow and stress run no simulation, so their honesty copy has only these two lines (W3-B5). */
export interface PointHonesty { estimate: string; disclaimer: string; }
export interface StressScenario { key: string; label: string; note: string; impact: number; impact_pct: number; after: number;
  /** `book_key` is the Assumption Book key; debt funds get their own row ('Mutual Funds (debt)', MF_DEBT). */
  recovery_months: number | null; rows: { segment: string; value: number; shock_pct: number; impact: number; book_key?: string }[];
  /** P2 (K11): months to regain today's value at each class's typical return, markets alone; null past 240 or when nothing falls. */
  recovery_months_markets?: number | null;
  /** The same with your monthly SIP added; `recovery_months` is an alias of this. */
  recovery_months_with_sips?: number | null;
  /** The 10 holdings with the largest |impact|. */
  holdings?: StressHolding[];
  /** Only on `GET /forecast/stress` with a plan, and only for falling scenarios; else null. */
  plan_impact?: PlanImpact | null; }
/** A holding's share of a stress scenario (K11). `beta` is set only for Indian equity, equity funds and NPS with a known β. */
export interface StressHolding { instrument_id: number; name: string; segment: string; value: number; beta: number | null; shock_pct: number; impact: number; }
/**
 * Stress-to-plan (K11): chances before and after the shock, on the same draws (500 sims, CRN). The retirement figures
 * are accumulation probabilities (money at the retirement age ≥ the corpus needed); null without a retirement plan.
 */
export interface PlanImpact {
  retirement_before: number | null; retirement_after: number | null;
  goals: { id: number; name: string; before: number | null; after: number | null }[];
}
export interface StressTest { total: number; market_exposed_pct: number; scenarios: StressScenario[]; worst: string | null; note: string;
  assumptions?: ForwardAssumptions; honesty?: PointHonesty;
  /** P2 (K11): the `worst` scenario's `plan_impact`; null without a plan. */
  plan_impact?: PlanImpact | null; }
export interface RetirementInputs { current_age: number; retire_age: number; life_expectancy: number; monthly_expenses: number; inflation_pct: number;
  post_return_pct: number; monthly_sip: number; step_up_pct: number; return_pct: number; other_income_monthly: number; volatility_pct: number; return_basis: string;
  /** Wave-6 review: `return_pct` is the return simulated (and behind `projected`); this is the one asked for. */
  requested_return_pct?: number;
  /** Set only when the return asked for could not be simulated as given. */
  return_note?: string | null; }
export interface RetirementPlan {
  inputs: RetirementInputs; years_to_retire: number; retirement_years: number; current: number; monthly_expenses_at_retirement: number;
  corpus_needed: number; projected: number; gap: number; required_sip: number; probability: number | null; status: 'on_track' | 'at_risk' | 'off_track';
  fire: { number: number; progress_pct: number | null; years_to_fi: number | null; fi_age: number | null; coast_amount_now: number; coasting: boolean };
  runs_out_at: number | null; path: { age: number; year: number; phase: 'saving' | 'retired'; corpus: number; expenses: number }[]; note: string;
  /** Wave 1: the first retirement year's withdrawal (inflated expenses less other income). */
  first_year_withdrawal?: number;
  /** Simulations actually run behind `probability`. */
  sims?: number;
  /** Mandatory copy (Part 2 §6.12): `probability` is "{n} of 100 futures", `estimate` is "est.". */
  honesty?: { probability: string; estimate: string } & Partial<ProjectionHonesty>;
  /** W3: `required_sip` reaches the corpus in 75 of 100 futures; this one at the typical return. */
  required_sip_typical?: number | null;
  assumptions?: ForwardAssumptions;
  /* P2 (K10): the Monte Carlo parts come from one `simulate.run`; `status` follows min(probability, probability_lasts). */
  /** % of futures whose money pays every withdrawal to life expectancy. */
  probability_lasts?: number | null;
  /** The 10th-percentile age the money runs out, when at least 10% of futures run out; else null. */
  depletion_age_p10?: number | null;
  /** One band per age from today's age to life expectancy. */
  path_bands?: RetirementBand[];
  /** The money used when the plan's funding is known (goal-free money only); null when the whole portfolio is used. */
  sources?: RetirementSources | null;
  /** The NPS annuity (40% at 6%) whose income offsets withdrawals; null without NPS. */
  annuity?: { share: number; rate: number; income_p50?: number } | null;
  engine?: 'simulate' | null;
  /** Wave-6 review: 'plans' when the SIP plans stand in for an unset `monthly_sip` (deterministic figures too), else 'input'. */
  flows_basis?: 'plans' | 'input';
}
export interface RetirementBand { age: number; p10: number; p50: number; p90: number; }
/** K10: `excluded` is money earmarked for goals or the cushion, left out so it is not counted twice. */
export interface RetirementSources { epf: number; nps: number; free: number; excluded: number; }
export interface CashFlowMonth { month: string; dividends: number; interest: number; principal_back: number; epf_interest: number; sip_out: number;
  contributions: number; inflow: number; outflow: number; net: number; }
export interface CashFlowEvent { date: string; kind: 'fd_maturity' | 'p2p_close' | 'p2p_overdue'; name: string; amount: number; note: string; instrument_id: number | null; count?: number; }
export interface CashFlow { months: CashFlowMonth[]; totals: Omit<CashFlowMonth, 'month'>; events: CashFlowEvent[]; notes: string[]; note: string;
  /** Σ of the active SIP plans that have started (forecast.monthly_sip_total, wave 1). */
  monthly_sip_total?: number;
  assumptions?: ForwardAssumptions; honesty?: PointHonesty; }
/**
 * One market-priced holding in `quant.portfolio_risk` v2 (Part 2 §6.7).
 * `volatility_pct` is the holding's own measured σ (null under 60 days of prices);
 * `volatility_used_pct` is that σ shrunk toward its asset-class prior, which the portfolio numbers use.
 */
export interface RiskHolding { id: number; name: string; symbol: string; segment: string; weight_pct: number; volatility_pct: number | null; beta: number | null;
  risk_contribution_pct: number | null; value: number;
  volatility_used_pct?: number;
  /** How its daily returns were built: its own prices, an index standing in before its first price, or from the first price only. */
  data?: 'own' | 'proxy' | 'prior';
  /** How much of its σ is its own: own (n ≥ 504), some (60–503), prior (< 60) or rate (FD/EPF/P2P). */
  data_quality?: 'own' | 'some' | 'prior' | 'rate';
  /** Days of its own returns behind `volatility_pct`. */
  n?: number;
  /** The index that stood in before its first price ("Nifty 50", "S&P 500 in ₹", "GOLDBEES"), or null. */
  proxy?: string | null; }
/** The Assumption Book's view of today's mix (model σ and its 1-day 95% VaR in ₹). */
export interface RiskModel { vol_pct: number; var_day: number; }
/** FDs, EPF, P2P and hand-priced NPS, counted at their interest rates in the daily returns. */
export interface RiskBallast { value: number; weight_pct: number; rate_pct: number | null; risk_contribution_pct: number; }
export interface PortfolioRisk {
  total: number; exposed_pct: number; days?: number; since?: string | null; benchmark?: string;
  var_95?: { day_pct: number; day: number; month_pct: number; month: number; parametric_day_pct: number; expected_shortfall_day_pct: number };
  volatility_pct?: number; downside_deviation_pct?: number; beta?: number | null; correlation_index?: number | null; sharpe?: number | null;
  sortino?: number | null; diversification_ratio?: number | null; holdings: RiskHolding[];
  correlation: { labels: string[]; matrix: (number | null)[][]; highest: { pair: string[]; value: number } | null; lowest: { pair: string[]; value: number } | null };
  notes: string[];
  /** v2 (wave 1): annualised mean daily return and the risk-free rate the Sharpe ratio uses. */
  mean_return_pct?: number; risk_free_pct?: number;
  ballast?: RiskBallast;
  /** Present even when there is too little history to measure (then `measured_vol_pct` and `ratio` are null). */
  model?: RiskModel;
  measured_vs_model?: { measured_vol_pct: number | null; model_vol_pct: number; ratio: number | null };
}
export interface ConeBand { p10: number; p50: number; p90: number; days?: number; }
export interface Outlook {
  available: boolean; reason?: string; as_of?: string; price?: number; benchmark?: string; currency?: string;
  trend?: { key: 'up' | 'down' | 'mixed'; label: string; sma50: number | null; sma200: number | null; above_50: boolean; above_200: boolean;
    /** P2 (K16): true when the signals overruled the long averages (up + momentum_sell, or down + momentum_buy → mixed). */
    reconciled?: boolean };
  /** P2 (K16): the Markets signals from the holding's own closes, so the trend and the chips never disagree. */
  signals?: Signal[];
  momentum?: Record<'1M' | '3M' | '6M' | '1Y', number | null>; rsi?: number | null;
  volatility?: { annual_pct: number | null; month_pct: number | null; regime: 'calm' | 'normal' | 'turbulent' | null };
  range_52w?: { high: number; low: number; from_high_pct: number; max_drawdown_pct: number; position_pct: number };
  cagr_3y_pct?: number | null; beta?: number | null; correlation?: number | null;
  /** W3 (G9): the cone drifts at the Book μ with the shrunk σ; `cone_label` and `basis` are its honest labels. */
  assumptions?: { drift_pct: number; volatility_pct: number; typical_pct?: number; basis?: string;
    data_quality?: 'own' | 'some' | 'prior' | 'rate'; hash?: string; cone_label?: string };
  cone?: Record<'3M' | '6M' | '1Y', ConeBand>;
  holding?: { quantity: number; value: number; cone: Record<'3M' | '6M' | '1Y', ConeBand> }; notes?: string[]; disclaimer?: string;
}
export type RiskProfileKey = 'conservative' | 'balanced' | 'growth' | 'aggressive';
export interface OptimizerProfile { key: RiskProfileKey; label: string; note: string; target_vol: number; target_vol_pct: number; return_pct: number; vol_pct: number;
  weights: Record<string, number>; }
export interface OptimizerRow { segment: string; locked: boolean; current_pct: number; suggested_pct: number; delta_pct: number; delta_amount: number;
  /** P2 (K14): an FD or P2P row that would shrink is 'let_mature', never 'trim', and is left out of `turnover`. */
  action: 'hold' | 'add' | 'trim' | 'let_mature';
  /** On 'trim' rows: the leg's marginal tax with the ledger, else null. */
  tax_if_sold?: number | null;
  /** On 'trim' rows, with the ledger only. */
  sells?: SaleLeg[]; }
export interface OptimizerResult {
  total: number; profile: RiskProfileKey; profiles: OptimizerProfile[];
  current: { return_pct: number; vol_pct: number; sharpe: number | null; weights: Record<string, number>; closest_profile: RiskProfileKey } | null;
  suggested: { return_pct: number; vol_pct: number; sharpe: number | null } | null;
  rows: OptimizerRow[]; turnover?: number; locked_pct?: number; frontier: { vol_pct: number; ret_pct: number }[]; caps?: Record<string, number>; note: string;
  /** P2 (K14): all trims costed together, with the ledger only. */
  tax_total?: number;
}
export type SipFrequency = 'monthly' | 'quarterly' | 'weekly' | 'yearly';
export interface SipPlan { id: number; owner: string; instrument_id: number | null; instrument_name: string | null; asset_class: AssetClass | null;
  name: string; segment: string | null; amount: number; frequency: SipFrequency; day_of_month: number; step_up_pct: number | null;
  start_date: string | null; end_date: string | null; active: number; notes: string | null; created_at: string; updated_at: string;
  /** P2 (K3, P2.7): the goal this plan funds, one of the same owner's goals; null when unlinked. */
  goal_id?: number | null; }

/* ── Priority grammar: actions and the brief (SPEC Part 2 §8.1, Part 1 §2 P0.4/P0.7, AMENDMENTS A6) ── */

/** One status vocabulary, everywhere (Part 1 §1.8). */
export type Status = 'good' | 'watch' | 'act' | 'unset' | 'info';
export type ActionTier = 'now' | 'month' | 'consider' | 'good';
export type ActionSeverity = 'crit' | 'warn' | 'info' | 'pos';
export type ActionConfidence = 'fact' | 'estimate' | 'model' | 'signal';
export type ActionStatus = 'open' | 'planned' | 'snoozed' | 'done' | 'dismissed' | 'expired';
export type ActionCtaType = 'dialog' | 'route' | 'api' | 'whatif' | 'fd_mature';

/** What an action is worth in real ₹. `monthly` amounts are shown per month and left out of impact_total. */
export interface ActionImpact { amount: number; kind: 'lump' | 'monthly'; label: string | null; }

/** What to do. `route` + `query` + `fragment` navigate; `dialog` opens the transaction dialog prefilled. */
export interface ActionCta {
  label: string;
  type: ActionCtaType;
  route?: string;
  query?: Record<string, string | number> | null;
  fragment?: string | null;
  dialog?: { kind?: string | null; instrumentId?: number | null; type?: string | null; amount?: number | null;
    quantity?: number | null; date?: string | null; notes?: string | null } | null;
  api?: 'review_complete' | 'prices_refresh';
  whatif?: { instrument_id: number; qty: number | null } | null;
  /** `fd_mature`: the FD to mark matured (actions.py sends it on the CTA as well as on the action). */
  instrument_id?: number | null;
}

/** A ranked, persisted piece of advice. `link` is where the evidence lives; `cta` is what to do (A7). */
export interface Action {
  id: string;
  kind: 'state' | 'event';
  tier: ActionTier;
  severity: ActionSeverity;
  status: ActionStatus;
  category: string;
  title: string;
  detail: string | null;
  why: string | null;
  assumptions: string | null;
  impact: ActionImpact | null;
  due: string | null;
  days: number | null;
  confidence: ActionConfidence;
  score: number;
  owner: string | null;
  instrument_id: number | null;
  cta: ActionCta | null;
  link: string | null;
  first_seen: string | null;
  is_new: boolean;
  done_via: 'manual' | 'auto' | null;
  evidence: Record<string, unknown> | null;
  planned_for: string | null;
  snooze_until: string | null;
  done_at?: string | null;
  reason?: string | null;
  note?: string | null;
  /** Planned actions whose date has passed (§8.4). */
  days_late?: number | null;
  /** Rule inputs (sip_id, segment, fy...) that actions.py keeps for its close rules; not for display. */
  meta?: Record<string, unknown>;
}

export interface ActionsSummary { now: number; month: number; consider: number; good: number; impact_total: number;
  /** Visible actions not in the last snapshot, and open tax actions (the FY-window line). */
  new?: number; tax_open?: number; }

export interface FollowThrough {
  acted_90d: { done: number; total: number; pct: number | null };
  on_time_pct: number | null;
  impact_realised_fy: number | null;
  sip_adherence_12m: number | null;
  median_days_to_act?: number | null;
}

/** GET /actions (Part 1 §5.1 Data). */
export interface ActionsResponse {
  summary: ActionsSummary;
  actions: Action[];
  planned: Action[];
  done: Action[];
  snoozed: Action[];
  follow_through: FollowThrough | null;
  /** One line per source that failed and was skipped (E4); absent or [] when every source answered. */
  notes?: string[];
}

/** POST /actions/<id>/status body (§7.2). `evidence` mirrors `txn_ids` for the ledger's evidence column (A19). */
export interface ActionStatusBody {
  status: Exclude<ActionStatus, 'expired'>;
  until?: string | null;
  planned_for?: string | null;
  note?: string | null;
  reason?: string | null;
  txn_ids?: number[];
  evidence?: Record<string, unknown> | null;
}

export type VitalKey = 'data' | 'cushion' | 'risk' | 'mix' | 'money_at_risk';
/** One of the five checks on Home (A6, A23): an array, read with `vitalOf(vitals, key)`. */
export interface Vital { key: VitalKey; status: Status; label: string; value: string; note: string | null; link: string; }

/** Data trust (Part 1 §2 P0.7). */
export interface Freshness {
  last_refresh: string | null;
  age_minutes: number | null;
  missing_prices: string[];
  missing_weight_pct: number;
  stale: boolean;
}

/** `cushion_state` in brief.py (A6). */
export interface Cushion {
  set: boolean; months: number | null; target_months: number; monthly_expenses: number | null; amount: number; cash_amount: number;
  instrument_ids: number[]; candidates: { instrument_id: number; name: string; kind: string; value: number }[]; candidates_amount: number;
}

/** `deploy_state` in brief.py (A6): new money and where it comes from. `held_value` is already inside `segment`. */
export interface DeploySource {
  kind: 'usd' | 'fd' | 'p2p_principal' | 'escrow'; label: string; segment: string | null; instrument_id: number | null;
  date: string | null; amount: number; held_value: number;
}
export interface Deploy { suggested: number; sources: DeploySource[]; }

export interface RiskEst { vol_pct: number | null; target_vol_pct: number | null; profile: string | null; closest_profile: string | null; }

/** "Against the market" card; `pending` while /performance is not warm (A16). */
export interface MarketTrack { status: Status | 'pending'; excess: number | null; diff_value: number | null; since: string | null; days: number | null; }
export interface PlanTrackRow {
  kind: 'goal' | 'retirement'; id: number | null; name: string; probability: number | null; status: Status;
  target_amount: number | null; target_date: string | null; delta: number | null;
}
export interface PlanTrack { status: Status; on_track: number; total: number; rows: PlanTrackRow[]; }
export interface HabitTrack { status: Status; invested_month: number; planned_month: number; adherence_6m_pct: number | null; pace: number | null;
  /** P1 (H11): adherence `next_due[0]`, and the first `ahead` row of `story.milestones`. */
  next_due?: NextDue | null;
  milestone?: { label: string; when: string | null; in: string | null } | null; }

export interface UpcomingEvent {
  date: string; days: number; kind: string; title: string; amount: number | null; direction: 'in' | 'out' | null;
  link: string | null; key: string; instrument_id?: number | null; note?: string;
}
/** `calendar.upcoming` (P1): the next 90 days of money in and out. The totals are null when no cash flow was available.
 * `next_festival` is passed through from `build_calendar`, so it is a CalendarEvent. */
export interface Upcoming { inflow_90d: number | null; outflow_90d: number | null; theme: string | null; next_festival: CalendarEvent | null;
  events: UpcomingEvent[]; }

export interface AllocationRow { segment: string; value: number; pct: number; target: number | null; drift: number | null; drift_status: Status; }
export interface AssumptionsCheck { realised_pct: number | null; years: number; typical: number; lo: number; hi: number;
  verdict: 'within' | 'above' | 'below' | 'too_short';
  /** H11: `/plan?return=<realised>` when realised runs ≥ 3 points below typical over ≥ 2 years; otherwise null. */
  link?: string | null; }
/** `markets.market_state` (P1). */
export interface MarketState {
  mode: 'normal' | 'volatile' | 'correction' | 'crash';
  nifty: { price: number | null; d1: number | null; w1: number | null; from_high_pct: number | null; high?: number; high_date?: string };
  you: { from_peak_pct: number | null; from_peak_inr: number | null };
  /** The mildest falling stress scenario your drawdown fits within; `smaller` when your fall is smaller than it. */
  comparable: { key: string; label: string; impact: number | null; impact_pct?: number | null; smaller?: boolean } | null;
  playbook: string[];
  since: string | null;
  as_of?: string;
}
export interface ContextLine { kind: string; text: string; link: string | null; }

/** GET /brief: Home's answer ladder in one call (A6). */
export interface Brief {
  status: { status: Status; headline: string; count_now: number; count_month: number; impact_total: number };
  hero: { nifty_d1: number | null; since_last: { date: string; change: number; change_pct: number | null; actions_new: number } | null };
  /** [] when the ledger is empty; otherwise in the order data, cushion, risk, mix, money_at_risk. */
  vitals: Vital[];
  actions: Action[];
  on_track: { plan: PlanTrack; market: MarketTrack; habit: HabitTrack };
  why: Attribution;
  allocation: AllocationRow[];
  upcoming: Upcoming | null;
  tax: { fy: string; estimate_total: number | null };
  deploy: Deploy;
  freshness: Freshness;
  pending: string[];
  empty: boolean;
  context_line: ContextLine | null;
  assumptions_check: AssumptionsCheck | null;
  market_state: MarketState | null;
  /** Filled by later waves; present only when the backend sends them. */
  cushion?: Cushion | null;
  risk_est?: RiskEst | null;
  /** The whole portfolio's Book chip (H11). `chip` repeats `text`, so Home's P0 template keeps reading it. */
  assumptions?: ChipBlock | null;
}

/* ── P1 shared contracts (AMENDMENTS H6–H11, H17) ── */

/**
 * The assumption chip (§1.9, H17): what `<app-assumption-chip [block]>` reads from any forward payload.
 * `text` is "11.0% avg · 9.6% typical · ±12.4% · 6% inflation"; the brief also sends `chip` as an alias of it.
 */
export type ChipBlock = Pick<ForwardAssumptions, 'return_pct' | 'volatility_pct' | 'inflation_pct' | 'hash'> & {
  typical_pct?: number; basis?: string; text?: string; chip?: string;
};

/** GET /plan `sip` (H6): achieved goals and a null `required_sip` are skipped. */
export interface PlanSip { plans_monthly_total: number; goals_monthly_contribution: number; needed_monthly: number; gap_monthly: number; }
/** Engine statuses over the goals and the retirement plan (H6). */
export interface PlanCounts { on_track: number; at_risk: number; off_track: number; achieved: number; unknown: number; total: number; }

/** `goals.funding_summary` (§6.4, G7): where the money is spoken for. A goal's row has `unscaled` when its segment was over-claimed. */
export interface FundingEarmark { goal_id: number | null; name: string | null; amount: number; unscaled?: number; }
export interface FundingOverAllocated { segment: string; claimed_pct: number; goals: { goal_id: number | null; name: string | null; pct: number }[]; }
export interface Funding {
  total: number;
  cushion: { amount: number; cash_amount: number; instrument_ids: number[] };
  earmarked: FundingEarmark[];
  free: number;
  over_allocated: FundingOverAllocated[];
}

/** GET /plan (§5.2 Data, H6). Never keyed on the action log, so a status POST never rebuilds it. */
export interface Plan {
  status: { status: Status; headline: string };
  /** `brief.plan_track` rows, worst first, with deltas against the 30-day snapshot. */
  rows: PlanTrackRow[];
  goals: Goal[];
  /** Only when `settings.retirementPlan` is set; null on a failed build (with a note). */
  retirement: RetirementPlan | null;
  /** Null (with a `notes` line) when its engine failed: /plan never 500s on one source (W4-B1). */
  funding: Funding | null;
  cushion: Cushion | null;
  sip: PlanSip;
  counts: PlanCounts;
  /** Goal id as a string, or 'retirement' → probability points since the snapshot; only non-null deltas. */
  deltas: Record<string, number>;
  assumptions: ChipBlock;
  /** No goals and no retirement plan. */
  empty: boolean;
  notes: string[];
  /** P2 (§6.10): only with `?detail=1`; the four "What moves the needle" tiles. Null (with a note) when the
   *  sensitivity compare failed (W7-B1). */
  sensitivities?: PlanSensitivity[] | null;
  /** P2 (R7, R20): only with `?detail=1`; today's plan as a resolved scenario. */
  baseline?: PlanScenario | null;
}

/** One Book row in GET /assumptions (H7). `MF_DEBT` is labelled "Mutual Funds (debt)". */
export interface AssumptionSegment {
  key: string; label: string; value: number; weight_pct: number; return_pct: number; typical_pct: number; volatility_pct: number;
  /** 'default', 'override' or 'holding rates'. */
  source: string; capped?: boolean;
}
/** `typical_band(μ, σ, years)` of the portfolio mix: the median annual return and its 1-in-10 range, in %. */
export interface TypicalBand { years: number; typical: number; lo: number; hi: number; }
/** GET /assumptions (§6.1, H7): the Book behind every forward number. `proposed` only with `?mix=`. */
export interface AssumptionsView {
  segments: AssumptionSegment[];
  corr: { keys: string[]; labels: string[]; matrix: number[][]; note: string };
  portfolio: ChipBlock;
  inflation_pct: number;
  risk_free_pct: number;
  typical_bands: TypicalBand[];
  hash: string;
  /** HONESTY copy (p50 formatted for 1,000 sims). The key set grows (W4-B2 adds `cone`), so it is open. */
  honesty: Partial<ProjectionHonesty> & Record<string, string>;
  /** "Long-run assumptions, not predictions." */
  note: string;
  proposed?: ChipBlock;
  /** P3 (K17, K21): how often the 1-year range held; null until ALL performance is warm. */
  calibration?: Calibration | null;
}

/** One monthly 1-year projection snapshot against what happened (K17). `realised` is the TWR growth factor. */
export interface CalibrationRow { date: string; p10: number; p50: number; p90: number; realised: number; inside: boolean; }
/**
 * `calibration.coverage` (§6.11, K17): of the matured snapshots, how many landed inside their p10–p90 range.
 * `coverage_pct` is null at 0 matured; `target` is 80; show it only when `show` (≥ 6 matured). Rows newest first.
 */
export interface Calibration {
  matured: number; inside: number; coverage_pct: number | null; target: number; show: boolean; rows: CalibrationRow[];
}

/** GET /tax/what-if parameters (H8). `price` is in the holding's currency; `date` is the sale date (YYYY-MM-DD). */
export interface WhatIfParams { instrument_id: number; qty: number; price?: number | null; date?: string | null; }
/** One lot the hypothetical sale consumes (`tax._price_sale`). `rate_pct` is null at slab rate; `lt_on` null for intraday and slab-only classes. */
export interface WhatIfLot {
  date: string; qty: number; cost: number; proceeds: number; gain: number; term: 'STCG' | 'LTCG' | 'Intraday';
  rate_pct: number | null; lt_on: string | null;
}
/** Selling on `date` (when a short-term lot turns long-term) would cost `tax_then`, saving `saving`. */
export interface WhatIfWait { date: string; days: number; tax_then: number; saving: number; }
/** `tax.what_if_sale` (§6.9, G11, W3-B3). A negative `tax_now` is tax saved (a loss offsets gains booked this FY). */
export interface WhatIfSale {
  instrument_id: number; name: string; qty: number; price: number; currency: 'INR' | 'USD'; sell_date: string; fy: string;
  proceeds: number; cost: number; gain: number; lots: WhatIfLot[]; st_gain: number; lt_gain: number;
  exemption_used: number; exemption_left: number; tax_now: number; net_cash: number; effective_pct: number | null;
  wait: WhatIfWait | null;
  /** The slab note plus D12 (brokerage, STT and stamp duty are not deducted). */
  note: string;
  /** USD holdings only. */
  amount_fc?: number; usd_inr?: number;
}

/* SIP adherence (`plans.sip_adherence`, §7.6, H2) and GET /sips (H9) */
export type SipInstalmentStatus = 'done' | 'partial' | 'skipped' | 'upcoming' | 'missed';
export interface SipInstalment { month: string; due: string; planned: number; invested: number; status: SipInstalmentStatus; }
export interface SipAdherencePlan {
  id: number; name: string | null; active: boolean; monthly_equiv: number; months: SipInstalment[];
  adherence_pct: number | null; missed_count: number; next_due: string | null;
}
/** An instalment still to go out (paid and skipped ones are already dropped). */
export interface NextDue { date: string; plan_id: number; name: string | null; amount: number; }
export interface SipAdherence {
  plans: SipAdherencePlan[]; planned_this_month: number; invested_this_month: number; adherence_6m_pct: number | null;
  next_due: NextDue[]; excluded_epf: number[]; window: { start: string; end: string };
}
/** `Services.deploy(...).sources` as GET /sips `arriving` (H9); `link` is the class page. */
export interface ArrivingMoney { kind: DeploySource['kind']; label: string; date: string | null; amount: number; instrument_id: number | null; link: string; }
/** GET /sips. The P1 fields are optional so a P0 server still types. `arriving_total` equals `brief.deploy.suggested`. */
export interface SipsResponse {
  plans: SipPlan[]; monthly_total: number;
  adherence?: SipAdherence | null; arriving?: ArrivingMoney[]; arriving_total?: number;
  /** P2 (R3, R20): the last 12 calendar months, oldest first; null when it could not be built, absent before wave 7. */
  history?: SipHistoryMonth[] | null;
}
/** One `/sips` history month: instalments due that month across plans, and what was recorded against them. */
export interface SipHistoryMonth { month: string; planned: number; invested: number; }

/* ── Redesign: the group overview (GET /overview) ── */
export interface GroupBench {
  key: string; label: string; xirr: number | null; end_value: number | null; diff: number | null;
  verdict: 'ahead' | 'behind' | 'same' | null; estimate: boolean;
}
export interface GroupRow {
  key: import('./groups').GroupKey; label: string; value: number; pct: number; put_in: number; gain: number;
  unrealized: number; gain_pct: number | null; xirr: number | null; day_change: number; count: number;
  target: number | null; suggested: number | null; gap: number | null; bench: GroupBench | null;
}
export interface Suggestion {
  id: string; rank: number; tone: 'warn' | 'bad' | 'info' | 'good'; icon: string; title: string; detail: string;
  impact: string; value: number; cta: string; link: string; group?: string; instrument_id?: number;
}
export interface Overview {
  as_of: string;
  totals: { value: number; put_in: number; gain: number; gain_pct: number | null; xirr: number | null; day_change: number;
    day_change_pct: number | null; unrealized: number; realized: number; income: number; missing_prices: string[]; monthly_in?: number | null };
  market: { xirr: number | null; end_value: number | null; diff: number | null; groups_ahead: number; groups_compared: number; note: string;
    series: { date: string; market: number | null }[] };
  targets: { mine: Record<string, number> | null; has_mine: boolean;
    suggested: { profile: string; age: number | null; equity: number; mix: Record<string, number>; how: string } };
  groups: GroupRow[];
  suggestions: Suggestion[];
}
export interface Question {
  id: 'money' | 'market' | 'mix' | 'goals' | 'dragging' | 'returns' | 'tax'; q: string; answer: string; detail: string;
  tone: 'good' | 'warn' | 'bad' | 'muted'; icon: string; link: string; badge?: string | null;
}
export interface TodoItem {
  id: string; tone: 'primary' | 'warn' | 'bad' | 'info' | 'good'; icon: string; title: string; detail?: string; impact?: string;
  cta: string; link: string; flow?: 'invest'; steps?: number; value?: number;
}
export interface DragItem {
  kind: 'group' | 'holding' | 'p2p'; id?: number; key?: string; group: string; name: string; amount: number;
  text: string; why: string; cta: string; link: string;
}
export interface GoalRow {
  id: number | 'retirement'; kind: 'goal' | 'retirement'; name: string; target: number; date: string; current: number;
  projected: number; status: 'on_track' | 'achieved' | 'at_risk' | 'off_track' | null; probability: number | null;
  monthly_now: number; monthly_needed: number | null; extra: number; progress_pct: number | null;
  allocation?: Record<string, number>;
}
export interface Answers {
  as_of: string; questions: Question[]; todo: TodoItem[]; dragging: DragItem[]; goals: GoalRow[]; monthly_in: number | null;
}
export interface GroupRebalanceRow {
  key: import('./groups').GroupKey; label: string; current: number; target_pct: number; action: 'buy' | 'sell' | 'hold';
  amount: number; current_pct: number; after_pct: number; let_mature?: number | null; locked?: boolean;
  sells?: { instrument_id: number; name: string; qty: number; proceeds: number; gain: number; tax: number }[]; tax?: number | null;
}
export interface GroupRebalance {
  rows: GroupRebalanceRow[]; total: number; new_money: number; allow_sell: boolean; sells_total: number;
  tax_total: number | null; tax_note: string | null; not_sold: number; shortfall: number; target_set: 'mine' | 'suggested';
}

/* ── Redesign: Activity (entry flow, checks, cash rules) ── */
export interface TraceStep { key: string; title: string; text: string; tone: 'brand' | 'warn' | 'good' | 'bad' | 'info'; icon: string;
  formula: string | null; code: string | null; items: string[]; }
export interface CashRuleEntry { account: string; direction: 'in' | 'out'; category: string | null; kind: string; note: string; }
export interface CashRule { id: string; asset_class: AssetClass; type: TxnType; entries: CashRuleEntry[]; import_entries: CashRuleEntry[] | null; note: string | null; }
export interface Trace {
  txn: { id: number; date: string; type: TxnType; type_label: string; quantity: number | null; amount: number; amount_fc: number | null;
    principal: number | null; source: string; notes: string | null };
  instrument: { id: number; name: string; asset_class: AssetClass; group: string };
  steps: TraceStep[];
  rule: CashRule | null;
}
export interface DataCheck { id: string; severity: 'bad' | 'warn' | 'info'; title: string; detail: string; count: number; fix: string; link: string | null;
  items: { instrument_id: number; name: string; detail: string; txn_id?: number }[]; }

/** GET /overview/group/:key — how one group's numbers are worked out. */
export interface GroupExplain {
  key: string; label: string; as_of: string; value: number; put_in: number; taken_out: number; gain: number;
  first_date: string | null; years: number; flows: number; xirr: number | null; simple_pct: number | null;
  market: { labels: string[]; end_value: number | null; xirr: number | null; diff_pts: number | null; dividend_yield: Record<string, number>; how: string };
  by_year: { year: number; put_in: number; taken_out: number }[];
  holdings: { id: number; name: string; is_open: boolean; put_in: number; taken_out: number; value: number; gain: number; xirr: number | null;
    market: string; flows: number; first: string | null }[];
  /** Data checks touching these holdings (a doubt about a number and its fix, side by side). */
  issues?: { id: string; severity: 'bad' | 'warn' | 'info'; title: string; detail: string | null; count: number;
    items: { instrument_id: number; name: string; detail?: string }[]; fix?: string | null; link?: string | null }[];
}
