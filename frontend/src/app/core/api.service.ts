import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  AllowlistUser, CashMovement, Goal, Insight, Instrument, Benchmark, PerfMetrics, Performance, Portfolio,
  RebalancePlan, Settings, SymbolHit, TaxReport, Transaction,
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

  // portfolio & analytics
  portfolio() { return this.get<Portfolio>('/portfolio'); }
  performance(range: string, segment?: string | null) { return this.get<Performance>('/performance', { range, segment }); }
  tax(fy?: string) { return this.get<TaxReport>('/tax', { fy }); }
  insights(performance = true) { return this.get<{ insights: Insight[]; benchmarks: Benchmark[]; metrics: PerfMetrics }>('/insights', { performance: performance ? 1 : 0 }); }
  dismissInsight(id: string, days = 30) { return this.post(`/insights/${encodeURIComponent(id)}/dismiss`, { days }); }
  rebalance(newMoney: number, allowSell: boolean) { return this.get<RebalancePlan>('/rebalance', { new_money: newMoney, allow_sell: allowSell ? 1 : 0 }); }
  completeReview() { return this.post<{ lastReviewDate: string }>('/review/complete'); }

  // ledger
  instruments(assetClass?: string) { return this.get<Instrument[]>('/instruments', { asset_class: assetClass }); }
  createInstrument(body: Partial<Instrument>) { return this.post<Instrument>('/instruments', body); }
  updateInstrument(id: number, body: Partial<Instrument>) { return this.put<Instrument>(`/instruments/${id}`, body); }
  deleteInstrument(id: number) { return this.delete(`/instruments/${id}`); }
  transactions(p?: Params) { return this.get<Transaction[]>('/transactions', p); }
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
  orderReportPreview(fileData: string) { return this.post<any>('/p2p/import/order-report/preview', { file_data: fileData }); }
  orderReportCommit(rows: unknown[]) { return this.post<any>('/p2p/import/order-report/commit', { rows }); }
  statementPreview(fileData: string) { return this.post<any>('/p2p/import/statement/preview', { file_data: fileData }); }
  statementCommit(rows: unknown[], statusUpdates: unknown[]) { return this.post<any>('/p2p/import/statement/commit', { rows, status_updates: statusUpdates }); }
  addFd(body: unknown) { return this.post<Instrument>('/fixed-deposits', body); }
  matureFd(id: number, body: unknown) { return this.post(`/fixed-deposits/${id}/mature`, body); }
  addForex(body: unknown) { return this.post<Transaction>('/forex', body); }

  refreshPrices(force = false) { return this.post<{ refreshed: boolean; last_refresh: string; failed?: string[]; updated?: number }>('/prices/refresh', { force }); }
  searchSymbols(q: string, assetClass?: string) { return this.get<SymbolHit[]>('/symbols/search', { q, asset_class: assetClass }); }

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
