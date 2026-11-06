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
  link: string | null; severity: 'critical' | 'warning' | 'info'; }

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
export interface Signal { signal: SignalKey; title: string; note: string; }
export interface MarketIdea extends Signal { symbol: string; name: string; industry: string | null; metrics: PriceMetrics;
  held: boolean; watching: boolean; score: number; }
export interface MarketMover { symbol: string; name: string; industry: string | null; metrics: PriceMetrics; held: boolean; }
export interface MarketHolding { id: number; name: string; symbol: string; segment: string; value: number; weight: number;
  gain_pct: number | null; quantity: number | null; metrics: PriceMetrics | null; signals: Signal[]; }
export interface WatchItem { id: number; owner: string; symbol: string; name: string; target_buy: number | null; target_sell: number | null;
  added_price: number | null; notes: string | null; created_at: string; industry: string | null; metrics: PriceMetrics | null;
  target_hit: 'buy' | 'sell' | null; since_added: number | null; held: boolean; signals: Signal[]; }
export interface MarketAlertsConfig { enabled: boolean; push: boolean; day: number; week: number; }
export interface RebalanceHint extends MarketHolding { why: string; }
export interface MarketOverview { as_of: string; universe: string; universe_size: number; covered: number;
  index: { name: string; metrics: PriceMetrics | null }; breadth: { up: number; down: number; total: number };
  holdings: MarketHolding[]; watchlist: WatchItem[]; ideas: Record<SignalKey, MarketIdea[]>;
  movers: { day: { up: MarketMover[]; down: MarketMover[] }; week: { up: MarketMover[]; down: MarketMover[] } };
  sectors: { industry: string; count: number; w1: number; m1: number }[];
  rebalance: { has_targets: boolean; segments: { segment: string; pct: number; target: number; drift: number }[];
    trim: RebalanceHint[]; add: RebalanceHint[]; new_ideas: MarketIdea[] };
  alerts_config: MarketAlertsConfig; rules: Record<SignalKey, { m1: number; w1: number }>; }
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

export interface PerfPoint { date: string; value: number; cost: number; net_invested: number; index: number; [bench: string]: number | string | null; }
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
export interface Performance { series: PerfPoint[]; metrics: PerfMetrics; benchmarks: Benchmark[]; monthly: { month: string; return: number | null }[]; segment?: string | null; }

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
  };
}

export interface Insight {
  id: string; severity: 'critical' | 'warning' | 'info' | 'positive'; category: string;
  title: string; detail: string; action: string | null; link: string | null; amount: number | null;
}

export interface GoalProjection {
  current: number; progress_pct: number; months_left: number; expected_return: number; volatility: number;
  projected: number; shortfall: number; required_sip: number | null; probability: number;
  status: 'achieved' | 'on_track' | 'at_risk' | 'off_track'; p10: number | null; p50: number | null; p90: number | null;
  path: { date: string; projected: number; contributed: number }[];
}
export interface Goal {
  id: number; name: string; target_amount: number; target_date: string; monthly_contribution: number;
  expected_return: number | null; allocation: Record<string, number>; priority: string | null; notes: string | null;
  projection: GoalProjection;
}

export interface RebalanceRow { segment: string; current: number; current_pct: number; target_pct: number; after_pct: number; action: 'buy' | 'sell' | 'hold'; amount: number; }
export interface RebalancePlan { rows: RebalanceRow[]; total: number; new_money: number; allow_sell: boolean; shortfall_to_targets: number; money_to_fix_without_selling: number; error?: string; }

export interface Settings {
  targetAllocation?: Record<string, number>;
  taxSlabRate?: number | string;
  lastReviewDate?: string;
  reviewSnapshot?: Record<string, number>;
  dismissedInsights?: Record<string, string>;
  autoCapitalFlows?: string;
  marketAlerts?: Partial<MarketAlertsConfig>;
  segments: string[];
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
