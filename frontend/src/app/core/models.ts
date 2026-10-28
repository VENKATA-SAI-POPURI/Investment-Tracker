export type AssetClass = 'equity' | 'mutual_fund' | 'commodity' | 'p2p' | 'fixed_deposit' | 'cash';
export type TxnType = 'BUY' | 'SELL' | 'DIVIDEND' | 'INTEREST' | 'REPAYMENT' | 'MATURITY' | 'FX_IN' | 'FX_OUT';
export type Role = 'admin' | 'user' | 'guest';

export const SEGMENTS = ['Equity (India)', 'Equity (USA)', 'Mutual Funds', 'Commodity', 'P2P', 'Fixed Deposits'] as const;
export type Segment = typeof SEGMENTS[number];

/** Fixed categorical slot per segment — colour follows the entity, never its rank. */
export const SEGMENT_COLOR: Record<string, string> = {
  'Equity (India)': 'var(--s1)',
  'Equity (USA)': 'var(--s2)',
  'Mutual Funds': 'var(--s3)',
  'Commodity': 'var(--s4)',
  'P2P': 'var(--s5)',
  'Fixed Deposits': 'var(--s6)',
};

export const CLASS_LABEL: Record<AssetClass, string> = {
  equity: 'Stocks', mutual_fund: 'Mutual funds', commodity: 'Commodities', p2p: 'P2P lending',
  fixed_deposit: 'Fixed deposits', cash: 'USD wallet',
};

export const TXN_LABEL: Record<TxnType, string> = {
  BUY: 'Buy', SELL: 'Sell', DIVIDEND: 'Dividend', INTEREST: 'Interest', REPAYMENT: 'Repayment',
  MATURITY: 'Maturity', FX_IN: 'USD deposit', FX_OUT: 'USD withdrawal',
};

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
  segments: string[];
}

export interface SymbolHit { symbol: string; name: string; exchange: string; type: string; source: string; }
export interface AllowlistUser { email: string; added_date: string; role: Role; name: string | null; picture: string | null; last_login: string | null; }

export interface HealthComponent { key: string; label: string; weight: number; score: number; note: string; }
export interface Health { score: number; grade: string; components: HealthComponent[]; focus: { key: string; label: string; note: string }; }
export interface CalendarEvent { date: string; key: string; title: string; kind: 'festival' | 'national' | 'tax' | 'fy' | 'personal'; note: string; link: string | null; days: number; }
export interface Pulse { health: Health; calendar: { events: CalendarEvent[]; theme: string | null; next_festival: CalendarEvent | null }; }
export interface IncomeMonth { month: string; dividends: number; p2p_interest: number; fd_interest: number; total: number; }
export interface Income { months: IncomeMonth[]; last_12m: number; monthly_avg: number; top_payers: { instrument_id: number; name: string; amount: number }[]; }
export interface PriceHistory { symbol: string | null; currency: string | null; points: [string, number][]; trades: { date: string; type: 'BUY' | 'SELL'; quantity: number; amount: number; price: number | null }[]; }
