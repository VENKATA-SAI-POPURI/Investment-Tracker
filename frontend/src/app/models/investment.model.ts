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
}

export interface P2PEntry {
  id?: number;
  lending_id: string;
  platform: string;
  name: string;
  date: string;
  amount: number | null;
  tenure: number | null;
  maturity_date: string;
  status: string;
  remarks: string;
}

export interface P2PRepayment {
  id?: number;
  lending_id: string;
  date: string;
  principal: number | null;
  interest: number | null;
  platform_fee: number | null;
  amount: number | null;  // = principal + interest (auto-computed on save)
  remarks: string;
}

export interface P2PEscrow {
  id?: number;
  date: string;
  type: string;
  amount: number | null;
  platform: string;
  remarks: string;
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
}

export interface Summary {
  [key: string]: {
    count: number;
    total_buy: number;
    total_sell: number;
    net: number;
  };
}

export interface ForexEntry {
  id?: number;
  date: string;
  type: string;
  inr_amount: number | null;
  usd_amount: number | null;
  rate: number | null;
  remarks: string;
}
