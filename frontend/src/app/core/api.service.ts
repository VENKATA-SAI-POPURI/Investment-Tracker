import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  AllowlistUser, CashMovement, Goal, Income, Insight, Instrument, Benchmark, PerfMetrics, Performance, Portfolio,
  PriceHistory, Pulse, RebalancePlan, Settings, SymbolHit, TaxReport, Transaction, Member, Report, ReportMeta, CasPreview, LendenPreview, KitePreview, EpfPreview, MarketOverview, WatchItem, Ipo, MarketAlert, PushConfig,
  Projection, StressTest, RetirementPlan, CashFlow, PortfolioRisk, Outlook, OptimizerResult, SipPlan,
  Action, ActionsResponse, ActionStatusBody, Brief, Plan, AssumptionsView, WhatIfParams, WhatIfSale, SipsResponse,
  NotificationsResponse, NotificationsSeenResponse, PlanCompare, PlanCompareRequest, TransactionsPage, TransactionsPageParams,
  Overview, Answers, GroupRebalance, Trace, DataCheck, CashRule, GroupExplain,
} from './models';

type Params = Record<string, string | number | boolean | null | undefined>;

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  private params(p?: Params): HttpParams {
    let hp = new HttpParams();
    for (const [k, v] of Object.entries(p ?? {})) if (v !== null && v !== undefined && v !== '') hp = hp.set(k, String(v));
    return hp;
  }
  get<T>(path: string, p?: Params): Observable<T> { return this.http.get<T>(this.base + path, { params: this.params(p) }); }
  post<T>(path: string, body: unknown = {}): Observable<T> { return this.http.post<T>(this.base + path, body); }
  put<T>(path: string, body: unknown): Observable<T> { return this.http.put<T>(this.base + path, body); }
  patch<T>(path: string, body: unknown): Observable<T> { return this.http.patch<T>(this.base + path, body); }
  delete<T>(path: string): Observable<T> { return this.http.delete<T>(this.base + path); }

  ping() { return this.get<{ ok: boolean }>('/ping'); }

  // family, reminders, reports, statement import
  portfolios() { return this.get<{ family: boolean; members: Member[] }>('/portfolios'); }
  /** `unread` arrives with W7-B1 (K19); until then only `items`. */
  notifications() { return this.get<NotificationsResponse>('/notifications'); }
  /** Marks notices seen in `action_log.seen_at` (D15): action notices are `act:<action id>`. Returns the new unread count. */
  notificationsSeen(ids: string[]) { return this.post<NotificationsSeenResponse>('/notifications/seen', { ids }); }
  reportCatalog() { return this.get<{ reports: ReportMeta[]; years: string[]; asset_classes: string[] }>('/reports'); }
  report(key: string, p?: Params) { return this.get<Report>(`/reports/${key}`, p); }
  reportXlsx(key: string, p?: Params) {
    return this.http.get(`${this.base}/reports/${key}/export.xlsx`, { params: this.params(p), responseType: 'blob' });
  }
  casPreview(file: string, password: string) { return this.post<CasPreview>('/import/cas/preview', { file, password }); }
  // markets: overview, watchlist, IPO tracker, alerts and push
  markets() { return this.get<MarketOverview>('/markets'); }
  addWatch(body: unknown) { return this.post<WatchItem>('/watchlist', body); }
  updateWatch(id: number, body: unknown) { return this.put<WatchItem>(`/watchlist/${id}`, body); }
  deleteWatch(id: number) { return this.delete<{ message: string }>(`/watchlist/${id}`); }
  ipos() { return this.get<Ipo[]>('/ipos'); }
  addIpo(body: unknown) { return this.post<Ipo>('/ipos', body); }
  updateIpo(id: number, body: unknown) { return this.put<Ipo>(`/ipos/${id}`, body); }
  deleteIpo(id: number) { return this.delete<{ message: string }>(`/ipos/${id}`); }
  marketAlerts() { return this.get<MarketAlert[]>('/markets/alerts'); }
  pushConfig() { return this.get<PushConfig>('/push/config'); }
  pushSubscribe(subscription: unknown) { return this.post<{ devices: number }>('/push/subscribe', { subscription }); }
  pushUnsubscribe(endpoint: string | null, all = false) { return this.post<{ devices: number }>('/push/unsubscribe', { endpoint, all }); }
  pushTest() { return this.post<{ sent: number }>('/push/test', {}); }
  epfPreview(files: { name: string; file_data: string }[]) { return this.post<EpfPreview>('/import/epf/preview', { files }); }
  epfCommit(files: { name: string; file_data: string }[]) {
    return this.post<{ imported: number; skipped: number; balance: number }>('/import/epf/commit', { files });
  }
  tradebookPreview(files: { name: string; file_data: string }[]) { return this.post<KitePreview>('/import/tradebook/preview', { files }); }
  tradebookCommit(stocks: unknown[]) {
    return this.post<{ added: number; removed: number; corrected: number; results: { symbol: string; ok: boolean; error?: string }[] }>('/import/tradebook/commit', { stocks });
  }
  casCommit(body: unknown) { return this.post<{ imported: number; results: { name: string; ok: boolean; imported?: number; error?: string; updated?: string }[] }>('/import/cas/commit', body); }

  // redesign: the group overview and rebalancing by group
  overview() { return this.get<Overview>('/overview'); }
  answers() { return this.get<Answers>('/answers'); }
  groupExplain(key: string) { return this.get<GroupExplain>(`/overview/group/${key}`); }
  groupRebalance(newMoney: number, allowSell: boolean, targets: 'mine' | 'suggested') {
    return this.get<GroupRebalance>('/overview/rebalance', { new_money: newMoney, allow_sell: allowSell ? 1 : 0, targets });
  }

  trace(txnId: number) { return this.get<Trace>(`/trace/txn/${txnId}`); }
  checks() { return this.get<DataCheck[]>('/checks'); }
  cashRules() { return this.get<CashRule[]>('/rules'); }

  // portfolio & analytics
  portfolio() { return this.get<Portfolio>('/portfolio'); }
  performance(range: string, segment?: string | null) { return this.get<Performance>('/performance', { range, segment }); }
  tax(fy?: string) { return this.get<TaxReport>('/tax', { fy }); }
  insights(performance = true) { return this.get<{ insights: Insight[]; benchmarks: Benchmark[]; metrics: PerfMetrics }>('/insights', { performance: performance ? 1 : 0 }); }
  dismissInsight(id: string, days = 30) { return this.post(`/insights/${encodeURIComponent(id)}/dismiss`, { days }); }
  /**
   * Rebalance plan for `newMoney`. `net: 'deploy'` (A15) tells the server that the money is the brief's
   * `deploy.suggested`, already held inside its source segments, so it is netted out before planning.
   * Send it only when the amount is that default; a typed amount sends no `net`.
   */
  rebalance(newMoney: number, allowSell: boolean, net?: 'deploy') {
    return this.get<RebalancePlan>('/rebalance', { new_money: newMoney, allow_sell: allowSell ? 1 : 0, net });
  }
  /** The tax on a hypothetical sale (H8). A read, so guests may call it; a bad input is a 400 with the reason. */
  whatIf(p: WhatIfParams) {
    return this.get<WhatIfSale>('/tax/what-if', { instrument_id: p.instrument_id, qty: p.qty, price: p.price, date: p.date });
  }
  pulse() { return this.get<Pulse>('/pulse'); }
  income() { return this.get<Income>('/income'); }
  instrumentHistory(id: number) { return this.get<PriceHistory>(`/instruments/${id}/history`); }
  completeReview() { return this.post<{ lastReviewDate: string }>('/review/complete'); }

  // priority: the answer-ladder brief and ranked actions
  brief(since?: string | null) { return this.get<Brief>('/brief', { since }); }
  actions(p?: { status?: string; category?: string; instrument_id?: number }) { return this.get<ActionsResponse>('/actions', p); }
  /** Action ids contain ':' (e.g. `fd:maturing:12`), so the id is URL-encoded. */
  setActionStatus(id: string, body: ActionStatusBody) { return this.post<Action>(`/actions/${encodeURIComponent(id)}/status`, body); }

  // ledger
  instruments(assetClass?: string) { return this.get<Instrument[]>('/instruments', { asset_class: assetClass }); }
  createInstrument(body: Partial<Instrument>) { return this.post<Instrument>('/instruments', body); }
  updateInstrument(id: number, body: Partial<Instrument>) { return this.put<Instrument>(`/instruments/${id}`, body); }
  deleteInstrument(id: number) { return this.delete(`/instruments/${id}`); }
  transactions(p?: Params) { return this.get<Transaction[]>('/transactions', p); }
  /** One page of the ledger (K4): sending `page` switches GET /transactions to the paged object; a bad page/size/sort is a 400. */
  transactionsPage(p: TransactionsPageParams) {
    return this.get<TransactionsPage>('/transactions', {
      page: p.page, size: p.size, q: p.q?.trim() || null, sort: p.sort, asset_class: p.asset_class,
      instrument_id: p.instrument_id, type: p.type, from: p.from, to: p.to,
    });
  }
  addTransaction(body: unknown) { return this.post<Transaction>('/transactions', body); }
  updateTransaction(id: number, body: unknown) { return this.put<Transaction>(`/transactions/${id}`, body); }
  deleteTransaction(id: number) { return this.delete(`/transactions/${id}`); }
  importPreview(csv: string) { return this.post<{ format: string; rows: any[]; errors: { line: number; error: string }[] }>('/transactions/import/preview', { csv }); }
  importCommit(rows: unknown[]) { return this.post<{ imported: number; results: any[] }>('/transactions/import/commit', { rows }); }
  cash(account?: string) { return this.get<CashMovement[]>('/cash', { account }); }
  addCash(body: Partial<CashMovement>) { return this.post<CashMovement>('/cash', body); }
  updateCash(id: number, body: Partial<CashMovement>) { return this.put<CashMovement>(`/cash/${id}`, body); }
  deleteCash(id: number) { return this.delete(`/cash/${id}`); }
  suggestions() { return this.get<Record<string, any>>('/suggestions'); }

  addLoan(body: unknown) { return this.post<Instrument>('/p2p/loans', body); }
  lendenPreview(files: { name: string; file_data: string }[]) { return this.post<LendenPreview>('/p2p/import/preview', { files }); }
  lendenCommit(body: unknown) {
    return this.post<{ loans_added: number; repayments: number; status_updated: number; details_filled: number; errors: { loan_id: string; error: string }[] }>('/p2p/import/commit', body);
  }
  addFd(body: unknown) { return this.post<Instrument>('/fixed-deposits', body); }
  matureFd(id: number, body: unknown) { return this.post(`/fixed-deposits/${id}/mature`, body); }
  addForex(body: unknown) { return this.post<Transaction>('/forex', body); }

  refreshPrices(force = false) { return this.post<{ refreshed: boolean; last_refresh: string; failed?: string[]; updated?: number }>('/prices/refresh', { force }); }
  searchSymbols(q: string, assetClass?: string) { return this.get<SymbolHit[]>('/symbols/search', { q, asset_class: assetClass }); }

  // forecasting & planning
  /** `after_tax: true` sends `after_tax=1`, which fills `end.after_tax` (D5, K19); false or absent sends nothing. */
  forecast(p: { years: number; sip?: number | null; step?: number; sims?: number; return?: number | null; after_tax?: boolean }) {
    const { after_tax, ...rest } = p;
    return this.get<Projection>('/forecast', { ...rest, after_tax: after_tax ? 1 : null });
  }
  stress() { return this.get<StressTest>('/forecast/stress'); }
  retirement(p?: Params) { return this.get<RetirementPlan>('/forecast/retirement', p); }
  cashflow(months = 12) { return this.get<CashFlow>('/forecast/cashflow', { months }); }
  risk() { return this.get<PortfolioRisk>('/risk'); }
  outlook(id: number) { return this.get<Outlook>(`/instruments/${id}/outlook`); }
  optimizer(profile?: string | null) { return this.get<OptimizerResult>('/optimizer', { profile }); }
  /** The Plan hub in one call (H6). `detail: true` sends `detail=1`, which adds `sensitivities` (§6.10). */
  plan(p?: { detail?: boolean }) { return this.get<Plan>('/plan', { detail: p?.detail ? 1 : null }); }
  /**
   * Scenarios against the baseline on common random numbers (§6.10, K19): ≤ 4, each a `planScenarios` index or inline.
   * A read (guests get ≤ 2 × 500 sims); an invalid scenario is a 400 with the reason.
   */
  planCompare(body: PlanCompareRequest) { return this.post<PlanCompare>('/plan/compare', body); }
  /**
   * The Assumption Book (H7). `mix` ({segment name: pct}, summing to 100) adds `proposed`, the chip for that mix;
   * it is sent as `mix=Equity (India):60,Mutual Funds:40`.
   */
  assumptions(mix?: Record<string, number>) {
    const m = mix ? Object.entries(mix).map(([k, v]) => `${k}:${v}`).join(',') : undefined;
    return this.get<AssumptionsView>('/assumptions', { mix: m });
  }
  /** Plans with their totals; P1 adds `adherence`, `arriving` and `arriving_total` (H9). */
  sips() { return this.get<SipsResponse>('/sips'); }
  addSip(body: unknown) { return this.post<SipPlan>('/sips', body); }
  updateSip(id: number, body: unknown) { return this.put<SipPlan>(`/sips/${id}`, body); }
  deleteSip(id: number) { return this.delete<{ message: string }>(`/sips/${id}`); }

  // goals & settings
  goals() { return this.get<Goal[]>('/goals'); }
  addGoal(body: unknown) { return this.post<Goal[]>('/goals', body); }
  updateGoal(id: number, body: unknown) { return this.put<Goal[]>(`/goals/${id}`, body); }
  deleteGoal(id: number) { return this.delete(`/goals/${id}`); }
  settings() { return this.get<Settings>('/settings'); }
  saveSetting(key: string, value: unknown) { return this.put(`/settings/${key}`, { value }); }

  // AI
  aiStatus() { return this.get<{ enabled: boolean; provider: string | null; disclaimer: string }>('/ai/status'); }
  aiAnalyze() { return this.post<{ analysis: string; disclaimer: string }>('/ai/analyze'); }
  aiChat(message: string, history: { role: string; content: string }[]) { return this.post<{ reply: string }>('/ai/chat', { message, history }); }

  // auth & admin
  me() { return this.get<any>('/auth/me'); }
  users() { return this.get<{ users: AllowlistUser[] }>('/admin/users'); }
  addUser(email: string, role: string) { return this.post('/admin/users', { email, role }); }
  setRole(email: string, role: string) { return this.patch(`/admin/users/${encodeURIComponent(email)}`, { role }); }
  removeUser(email: string) { return this.delete(`/admin/users/${encodeURIComponent(email)}`); }
}
