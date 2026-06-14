export interface EquityEntry {
  id?: number;
  market: string;
  market_cap: string;
  date: string;
  sector: string;
  name: string;
  quantity: number | null;
  value: number | null;
  value_usd: number | null;
  buy_sell: string;
  remarks: string;
  created_by?: string | null;
}

export interface CommodityEntry {
  id?: number;
  year: string;
  commodity: string;
  name: string;
  date: string;
  buy_quantity: number | null;
  buy_value: number | null;
  sell_quantity: number | null;
  sell_value: number | null;
  buy_sell: string;
  remarks: string;
  created_by?: string | null;
}

export interface MutualFundEntry {
  id?: number;
  year: string;
  category: string;
  fund_type: string;
  name: string;
  date: string;
  buy_quantity: number | null;
  buy_value: number | null;
  sell_quantity: number | null;
  sell_value: number | null;
  buy_sell: string;
  remarks: string;
  created_by?: string | null;
}

export interface P2PEntry {
  id?: number;
  lending_id: string;
  loan_id?: string;
  platform: string;
  name: string;
  date: string;
  amount: number | null;
  tenure: number | null;
  maturity_date: string;
  status: string;
  remarks: string;
  created_by?: string | null;
}

export interface P2PRepayment {
  id?: number;
  lending_id: string;
  date: string;
  principal: number | null;
  interest: number | null;
  platform_fee: number | null;
  amount: number | null;  // = principal + interest (auto-computed on save)
  source?: string | null; // 'manual' | 'statement_import'
  remarks: string;
  created_by?: string | null;
}

export interface LendenStatementRow {
  loan_id: string;
  lending_id: string;
  entry_id: number;
  platform: string;
  name: string;
  date: string;
  stmt_principal: number;
  stmt_interest: number;
  stmt_platform_fee: number;
  already_posted_principal: number;
  already_posted_interest: number;
  already_posted_platform_fee: number;
  delta_principal: number;
  delta_interest: number;
  delta_platform_fee: number;
  delta_total: number;
  remarks: string;
  selected: boolean;
  // status change (populated from warnings)
  new_status?: string;
  old_status?: string;
}

export interface LendenStatementWarning {
  type: 'unmatched' | 'status_change';
  loan_id: string;
  lending_id?: string;
  entry_id?: number;
  old_status?: string;
  new_status?: string;
  message: string;
}

export interface LendenParseResult {
  from_date: string;
  to_date: string;
  suggested: LendenStatementRow[];
  warnings: LendenStatementWarning[];
}

export interface P2PEscrow {
  id?: number;
  date: string;
  type: string;
  amount: number | null;
  platform: string;
  remarks: string;
  created_by?: string | null;
}

export interface FixedDepositEntry {
  id?: number;
  year: string;
  platform: string;
  bank_name: string;
  date: string;
  fd_value: number | null;
  interest: number | null;
  maturity_date: string;
  return_value: number | null;
  remarks: string;
  created_by?: string | null;
}

export interface Summary {
  [key: string]: {
    count: number;
    total_buy: number;
    total_sell: number;
    net: number;
  };
}

export interface EquityDividend {
  id?: number;
  name: string;
  date: string;
  amount: number;
  remarks?: string;
  capital_flow_id?: number;
  created_by?: string | null;
}

export interface ForexEntry {
  id?: number;
  date: string;
  type: string;
  inr_amount: number | null;
  usd_amount: number | null;
  rate: number | null;
  remarks: string;
  created_by?: string | null;
}
