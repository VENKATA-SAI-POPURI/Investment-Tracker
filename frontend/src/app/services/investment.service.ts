import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, shareReplay } from 'rxjs';
import { tap } from 'rxjs/operators';
import { EquityEntry, CommodityEntry, MutualFundEntry, P2PEntry, P2PRepayment, P2PEscrow, FixedDepositEntry, ForexEntry, Summary } from '../models/investment.model';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class InvestmentService {
  private baseUrl = environment.apiUrl;
  private cache: Record<string, Observable<any>> = {};

  private cached<T>(key: string, url: string): Observable<T> {
    if (!this.cache[key]) {
      this.cache[key] = this.http.get<T>(url).pipe(shareReplay(1));
    }
    return this.cache[key] as Observable<T>;
  }

  private invalidate(key: string): void {
    delete this.cache[key];
  }

  constructor(private http: HttpClient) {}

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

  // ── AI Analysis ──
  aiCache: { text: string; html: string; time: Date } | null = null;
  chatHistory: { role: 'user' | 'assistant'; content: string; html?: string; time: Date }[] = [];

  getAIAnalysis(): Observable<{ analysis: string }> {
    return this.http.post<{ analysis: string }>(`${this.baseUrl}/ai/analyze`, {});
  }

  sendChatMessage(message: string, history: { role: string; content: string }[]): Observable<{ reply: string }> {
    return this.http.post<{ reply: string }>(`${this.baseUrl}/ai/chat`, { message, history });
  }
}
