import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, shareReplay } from 'rxjs';
import { tap } from 'rxjs/operators';
import { EquityEntry, CommodityEntry, MutualFundEntry, P2PEntry, P2PRepayment, P2PEscrow, FixedDepositEntry, ForexEntry, Summary, EquityDividend, LendenParseResult } from '../models/investment.model';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class InvestmentService {
  private baseUrl = environment.apiUrl;
  private cache: Record<string, Observable<any>> = {};

  private cached<T>(key: string, url: string): Observable<T> {
    if (!this.cache[key]) {
      // tap error handler runs before shareReplay caches the result,
      // so a failed request is evicted and the next subscriber retries.
      this.cache[key] = this.http.get<T>(url).pipe(
        tap({ error: () => { delete this.cache[key]; } }),
        shareReplay(1)
      );
    }
    return this.cache[key] as Observable<T>;
  }

  private invalidate(key: string): void {
    delete this.cache[key];
    delete this.cache['summary'];
    delete this.cache['bulk-load'];
    delete this.cache['name-suggestions'];
  }

  clearAllCache(): void {
    this.cache = {};
  }

  constructor(private http: HttpClient) {
    // Warm the Render backend immediately so it's ready before the user's first real request.
    // Fire-and-forget — no auth header needed, errors silently ignored.
    this.http.get(`${this.baseUrl}/ping`).subscribe({ error: () => {} });
  }

  // ── Equity ──
  getEquity(): Observable<EquityEntry[]> {
    return this.cached<EquityEntry[]>('equity', `${this.baseUrl}/equity`);
  }

  addEquity(entry: EquityEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/equity`, entry).pipe(tap(() => this.invalidate('equity')));
  }

  updateEquity(id: number, entry: EquityEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/equity/${id}`, entry).pipe(tap(() => this.invalidate('equity')));
  }

  deleteEquity(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/equity/${id}`).pipe(tap(() => this.invalidate('equity')));
  }

  getEquityTickers(): Observable<Record<string, {ticker: string, price: number | null}>> {
    return this.cached<Record<string, {ticker: string, price: number | null}>>('equity-tickers', `${this.baseUrl}/equity/tickers`);
  }

  saveEquityTicker(name: string, ticker: string): Observable<any> {
    return this.http.put(`${this.baseUrl}/equity/tickers/${encodeURIComponent(name)}`, { ticker }).pipe(
      tap(() => { delete this.cache['equity-tickers']; delete this.cache['bulk-load']; })
    );
  }

  fetchEquityPrices(symbols: string[]): Observable<Record<string, number | null>> {
    return this.http.get<Record<string, number | null>>(
      `${this.baseUrl}/equity/prices?symbols=${encodeURIComponent(symbols.join(','))}`
    );
  }

  // ── Commodity ──
  getCommodity(): Observable<CommodityEntry[]> {
    return this.cached<CommodityEntry[]>('commodity', `${this.baseUrl}/commodity`);
  }

  addCommodity(entry: CommodityEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/commodity`, entry).pipe(tap(() => this.invalidate('commodity')));
  }

  updateCommodity(id: number, entry: CommodityEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/commodity/${id}`, entry).pipe(tap(() => this.invalidate('commodity')));
  }

  deleteCommodity(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/commodity/${id}`).pipe(tap(() => this.invalidate('commodity')));
  }

  getCommodityTickers(): Observable<Record<string, {ticker: string, price: number | null}>> {
    return this.cached<Record<string, {ticker: string, price: number | null}>>('commodity-tickers', `${this.baseUrl}/commodity/tickers`);
  }

  saveCommodityTicker(name: string, ticker: string): Observable<any> {
    return this.http.put(`${this.baseUrl}/commodity/tickers/${encodeURIComponent(name)}`, { ticker }).pipe(
      tap(() => { delete this.cache['commodity-tickers']; delete this.cache['bulk-load']; })
    );
  }

  fetchCommodityPrices(symbols: string[]): Observable<Record<string, number | null>> {
    return this.http.get<Record<string, number | null>>(
      `${this.baseUrl}/commodity/prices?symbols=${encodeURIComponent(symbols.join(','))}`
    );
  }

  // ── Mutual Funds ──
  getMutualFunds(): Observable<MutualFundEntry[]> {
    return this.cached<MutualFundEntry[]>('mutual-funds', `${this.baseUrl}/mutual-funds`);
  }

  addMutualFund(entry: MutualFundEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/mutual-funds`, entry).pipe(tap(() => this.invalidate('mutual-funds')));
  }

  updateMutualFund(id: number, entry: MutualFundEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/mutual-funds/${id}`, entry).pipe(tap(() => this.invalidate('mutual-funds')));
  }

  deleteMutualFund(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/mutual-funds/${id}`).pipe(tap(() => this.invalidate('mutual-funds')));
  }

  getMFTickers(): Observable<Record<string, {ticker: string, price: number | null}>> {
    return this.cached<Record<string, {ticker: string, price: number | null}>>('mf-tickers', `${this.baseUrl}/mutual-funds/tickers`);
  }

  saveMFTicker(name: string, ticker: string): Observable<any> {
    return this.http.put(`${this.baseUrl}/mutual-funds/tickers/${encodeURIComponent(name)}`, { ticker }).pipe(
      tap(() => { delete this.cache['mf-tickers']; delete this.cache['bulk-load']; })
    );
  }

  fetchMFPrices(symbols: string[]): Observable<Record<string, number | null>> {
    return this.http.get<Record<string, number | null>>(
      `${this.baseUrl}/mutual-funds/prices?symbols=${encodeURIComponent(symbols.join(','))}`
    );
  }

  // ── P2P ──
  getP2P(): Observable<P2PEntry[]> {
    return this.cached<P2PEntry[]>('p2p', `${this.baseUrl}/p2p`);
  }

  addP2P(entry: P2PEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/p2p`, entry).pipe(tap(() => this.invalidate('p2p')));
  }

  updateP2P(id: number, entry: P2PEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/p2p/${id}`, entry).pipe(tap(() => this.invalidate('p2p')));
  }

  deleteP2P(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/p2p/${id}`).pipe(tap(() => this.invalidate('p2p')));
  }

  // ── P2P Repayments ──
  getP2PRepayments(): Observable<P2PRepayment[]> {
    return this.cached<P2PRepayment[]>('p2p-repayments', `${this.baseUrl}/p2p-repayments`);
  }

  addP2PRepayment(entry: P2PRepayment): Observable<any> {
    return this.http.post(`${this.baseUrl}/p2p-repayments`, entry).pipe(tap(() => this.invalidate('p2p-repayments')));
  }

  updateP2PRepayment(id: number, entry: P2PRepayment): Observable<any> {
    return this.http.put(`${this.baseUrl}/p2p-repayments/${id}`, entry).pipe(tap(() => this.invalidate('p2p-repayments')));
  }

  deleteP2PRepayment(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/p2p-repayments/${id}`).pipe(tap(() => this.invalidate('p2p-repayments')));
  }

  // ── LenDen Statement Import ──
  parseLendenStatement(file: File): Observable<LendenParseResult> {
    const fd = new FormData();
    fd.append('file', file);
    return this.http.post<LendenParseResult>(`${this.baseUrl}/p2p/parse-statement`, fd);
  }

  importLendenStatement(rows: any[]): Observable<any> {
    return this.http.post(`${this.baseUrl}/p2p/import-statement`, { rows }).pipe(
      tap(() => {
        this.invalidate('p2p-repayments');
        this.invalidate('p2p');
        this.invalidate('p2p-escrow');
        delete (this.cache as any)['capital-flows'];
        delete (this.cache as any)['bulk-load'];
      })
    );
  }

  // ── P2P Escrow ──
  getP2PEscrow(): Observable<P2PEscrow[]> {
    return this.cached<P2PEscrow[]>('p2p-escrow', `${this.baseUrl}/p2p-escrow`);
  }

  addP2PEscrow(entry: P2PEscrow): Observable<any> {
    return this.http.post(`${this.baseUrl}/p2p-escrow`, entry).pipe(tap(() => this.invalidate('p2p-escrow')));
  }

  updateP2PEscrow(id: number, entry: P2PEscrow): Observable<any> {
    return this.http.put(`${this.baseUrl}/p2p-escrow/${id}`, entry).pipe(tap(() => this.invalidate('p2p-escrow')));
  }

  deleteP2PEscrow(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/p2p-escrow/${id}`).pipe(tap(() => this.invalidate('p2p-escrow')));
  }

  // ── Fixed Deposits ──
  getFixedDeposits(): Observable<FixedDepositEntry[]> {
    return this.cached<FixedDepositEntry[]>('fixed-deposits', `${this.baseUrl}/fixed-deposits`);
  }

  addFixedDeposit(entry: FixedDepositEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/fixed-deposits`, entry).pipe(tap(() => this.invalidate('fixed-deposits')));
  }

  updateFixedDeposit(id: number, entry: FixedDepositEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/fixed-deposits/${id}`, entry).pipe(tap(() => this.invalidate('fixed-deposits')));
  }

  deleteFixedDeposit(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/fixed-deposits/${id}`).pipe(tap(() => this.invalidate('fixed-deposits')));
  }

  // ── Summary ──
  getSummary(): Observable<Summary> {
    return this.cached<Summary>('summary', `${this.baseUrl}/summary`);
  }

  // ── Bulk Load ──
  getBulkLoad(): Observable<any> {
    if (!this.cache['bulk-load']) {
      this.cache['bulk-load'] = this.http.get<any>(`${this.baseUrl}/bulk-load`).pipe(
        tap({
          next: (data) => this._primeIndividualCaches(data),
          error: () => { delete this.cache['bulk-load']; }
        }),
        shareReplay(1)
      );
    }
    return this.cache['bulk-load'];
  }

  /** Populate individual caches from a bulk-load response.
   *  Always overwrites so fresh data replaces any stale warm-up data. */
  private _primeIndividualCaches(data: any): void {
    const prime = (key: string, value: any) => {
      if (value !== undefined) {
        this.cache[key] = of(value).pipe(shareReplay(1));
      }
    };
    prime('summary',           data.summary);
    prime('equity',            data.equity);
    prime('commodity',         data.commodity);
    prime('mutual-funds',      data.mutual_funds);
    prime('p2p',               data.p2p);
    prime('p2p-repayments',    data.p2p_repayments);
    prime('p2p-escrow',        data.p2p_escrow);
    prime('fixed-deposits',    data.fixed_deposits);
    prime('forex',             data.forex);
    prime('capital-flows',     data.capital_flows);
    prime('equity-dividends',  data.equity_dividends);
    prime('equity-tickers',    data.equity_tickers);
    prime('mf-tickers',        data.mf_tickers);
    prime('commodity-tickers', data.commodity_tickers);
  }

  /**
   * Synchronously prime all individual caches from the last-known dashboard
   * localStorage snapshot so pages can render stale data instantly on cold starts.
   * Must be called before getBulkLoad() so the primed cache values are available
   * when child components initialize.
   */
  warmFromLocalStorage(): void {
    try {
      const userRaw = localStorage.getItem('auth_user');
      const email = userRaw ? (JSON.parse(userRaw)?.email ?? 'guest') : 'guest';
      const raw = localStorage.getItem(`dashboard_cache_v1:${email}`);
      if (!raw) return;
      this._primeIndividualCaches(JSON.parse(raw));
    } catch { /* ignore parse/storage errors */ }
  }

  // ── Name Suggestions (for autocomplete — no financial data) ──
  getNameSuggestions(): Observable<{
    equity: string[]; equity_meta: Record<string, { market: string; market_cap: string; sector: string }>;
    mutual_funds: string[]; mf_meta: Record<string, { category: string; fund_type: string }>;
    commodity: string[]; commodity_meta: Record<string, { commodity: string }>;
    fixed_deposits: string[]; fd_meta: Record<string, { platform: string }>;
    p2p: string[];
  }> {
    return this.cached<any>('name-suggestions', `${this.baseUrl}/name-suggestions`);
  }

  fetchAllPrices(
    equity: string[],
    mf: string[],
    commodity: string[]
  ): Observable<{ equity: Record<string, number | null>; mf: Record<string, number | null>; commodity: Record<string, number | null> }> {
    const params = new URLSearchParams();
    if (equity.length) params.set('equity', equity.join(','));
    if (mf.length) params.set('mf', mf.join(','));
    if (commodity.length) params.set('commodity', commodity.join(','));
    return this.http.get<any>(`${this.baseUrl}/prices/bulk?${params}`);
  }

  // ── Unrealized P&L ──
  getUnrealizedPnL(): Observable<{ unrealized: number; unrealized_pct: number; total_cost: number; has_prices: boolean; by_category: Record<string, { unrealized: number; unrealized_pct: number; total_cost: number; has_prices: boolean }> }> {
    return this.http.get<{ unrealized: number; unrealized_pct: number; total_cost: number; has_prices: boolean; by_category: Record<string, { unrealized: number; unrealized_pct: number; total_cost: number; has_prices: boolean }> }>(`${this.baseUrl}/unrealized-pnl`);
  }

  // ── Settings ──
  getSetting(key: string): Observable<{ key: string; value: string | null }> {
    return this.http.get<{ key: string; value: string | null }>(`${this.baseUrl}/settings/${key}`);
  }

  saveSetting(key: string, value: string): Observable<any> {
    return this.http.put(`${this.baseUrl}/settings/${key}`, { value });
  }

  // ── Forex ──
  getForex(): Observable<ForexEntry[]> {
    return this.cached<ForexEntry[]>('forex', `${this.baseUrl}/forex`);
  }

  addForex(entry: ForexEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/forex`, entry).pipe(tap(() => this.invalidate('forex')));
  }

  updateForex(id: number, entry: ForexEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/forex/${id}`, entry).pipe(tap(() => this.invalidate('forex')));
  }

  deleteForex(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/forex/${id}`).pipe(tap(() => this.invalidate('forex')));
  }

  // ── Capital Flows ──
  getCapitalFlows(): Observable<any[]> {
    return this.cached<any[]>('capital-flows', `${this.baseUrl}/capital-flows`);
  }

  addCapitalFlow(entry: any): Observable<any> {
    return this.http.post(`${this.baseUrl}/capital-flows`, entry).pipe(tap(() => this.invalidate('capital-flows')));
  }

  updateCapitalFlow(id: number, entry: any): Observable<any> {
    return this.http.put(`${this.baseUrl}/capital-flows/${id}`, entry).pipe(tap(() => this.invalidate('capital-flows')));
  }

  deleteCapitalFlow(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/capital-flows/${id}`).pipe(tap(() => this.invalidate('capital-flows')));
  }

  getCapitalFlowsSummary(): Observable<{ total_deposits: number; total_withdrawals: number; actual_investment: number }> {
    return this.http.get<{ total_deposits: number; total_withdrawals: number; actual_investment: number }>(`${this.baseUrl}/capital-flows/summary`);
  }

  // ── AI Analysis ──
  aiCache: { text: string; html: string; time: Date } | null = null;
  chatHistory: { role: 'user' | 'assistant'; content: string; html?: string; time: Date }[] = [];

  getAIAnalysis(): Observable<{ analysis: string }> {
    return this.http.post<{ analysis: string }>(`${this.baseUrl}/ai/analyze`, {});
  }

  sendChatMessage(message: string, history: { role: string; content: string }[]): Observable<{ reply: string }> {
    return this.http.post<{ reply: string }>(`${this.baseUrl}/ai/chat`, { message, history });
  }

  // ── Equity Dividends ──
  getEquityDividends(): Observable<EquityDividend[]> {
    return this.cached<EquityDividend[]>('equity-dividends', `${this.baseUrl}/equity/dividends`);
  }

  addEquityDividend(entry: Partial<EquityDividend>): Observable<any> {
    return this.http.post(`${this.baseUrl}/equity/dividends`, entry).pipe(
      tap(() => { this.invalidate('equity-dividends'); delete this.cache['capital-flows']; delete this.cache['bulk-load']; })
    );
  }

  updateEquityDividend(id: number, entry: Partial<EquityDividend>): Observable<any> {
    return this.http.put(`${this.baseUrl}/equity/dividends/${id}`, entry).pipe(
      tap(() => { this.invalidate('equity-dividends'); delete this.cache['capital-flows']; delete this.cache['bulk-load']; })
    );
  }

  deleteEquityDividend(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/equity/dividends/${id}`).pipe(
      tap(() => { this.invalidate('equity-dividends'); delete this.cache['capital-flows']; delete this.cache['bulk-load']; })
    );
  }

  // ── Admin: User Management ──
  getAllowlist(): Observable<{ allowlist: { email: string; added_date: string; role: 'admin' | 'user' | 'guest' }[] }> {
    return this.http.get<{ allowlist: { email: string; added_date: string; role: 'admin' | 'user' | 'guest' }[] }>(`${this.baseUrl}/auth/allowlist`);
  }

  addToAllowlist(email: string, role: 'admin' | 'user' | 'guest'): Observable<any> {
    return this.http.post(`${this.baseUrl}/auth/allowlist`, { email, role });
  }

  updateUserRole(email: string, role: 'admin' | 'user' | 'guest'): Observable<any> {
    return this.http.patch(`${this.baseUrl}/auth/allowlist/${encodeURIComponent(email)}`, { role });
  }

  removeFromAllowlist(email: string): Observable<any> {
    return this.http.delete(`${this.baseUrl}/auth/allowlist/${encodeURIComponent(email)}`);
  }
}
