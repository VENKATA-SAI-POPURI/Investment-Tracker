import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { EquityEntry, CommodityEntry, MutualFundEntry, P2PEntry, P2PRepayment, P2PEscrow, FixedDepositEntry, ForexEntry, Summary } from '../models/investment.model';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class InvestmentService {
  private baseUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  // ── Equity ──
  getEquity(): Observable<EquityEntry[]> {
    return this.http.get<EquityEntry[]>(`${this.baseUrl}/equity`);
  }

  addEquity(entry: EquityEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/equity`, entry);
  }

  updateEquity(id: number, entry: EquityEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/equity/${id}`, entry);
  }

  deleteEquity(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/equity/${id}`);
  }

  // ── Commodity ──
  getCommodity(): Observable<CommodityEntry[]> {
    return this.http.get<CommodityEntry[]>(`${this.baseUrl}/commodity`);
  }

  addCommodity(entry: CommodityEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/commodity`, entry);
  }

  updateCommodity(id: number, entry: CommodityEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/commodity/${id}`, entry);
  }

  deleteCommodity(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/commodity/${id}`);
  }

  // ── Mutual Funds ──
  getMutualFunds(): Observable<MutualFundEntry[]> {
    return this.http.get<MutualFundEntry[]>(`${this.baseUrl}/mutual-funds`);
  }

  addMutualFund(entry: MutualFundEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/mutual-funds`, entry);
  }

  updateMutualFund(id: number, entry: MutualFundEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/mutual-funds/${id}`, entry);
  }

  deleteMutualFund(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/mutual-funds/${id}`);
  }

  // ── P2P ──
  getP2P(): Observable<P2PEntry[]> {
    return this.http.get<P2PEntry[]>(`${this.baseUrl}/p2p`);
  }

  addP2P(entry: P2PEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/p2p`, entry);
  }

  updateP2P(id: number, entry: P2PEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/p2p/${id}`, entry);
  }

  deleteP2P(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/p2p/${id}`);
  }

  // ── P2P Repayments ──
  getP2PRepayments(): Observable<P2PRepayment[]> {
    return this.http.get<P2PRepayment[]>(`${this.baseUrl}/p2p-repayments`);
  }

  addP2PRepayment(entry: P2PRepayment): Observable<any> {
    return this.http.post(`${this.baseUrl}/p2p-repayments`, entry);
  }

  updateP2PRepayment(id: number, entry: P2PRepayment): Observable<any> {
    return this.http.put(`${this.baseUrl}/p2p-repayments/${id}`, entry);
  }

  deleteP2PRepayment(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/p2p-repayments/${id}`);
  }

  // ── P2P Escrow ──
  getP2PEscrow(): Observable<P2PEscrow[]> {
    return this.http.get<P2PEscrow[]>(`${this.baseUrl}/p2p-escrow`);
  }

  addP2PEscrow(entry: P2PEscrow): Observable<any> {
    return this.http.post(`${this.baseUrl}/p2p-escrow`, entry);
  }

  updateP2PEscrow(id: number, entry: P2PEscrow): Observable<any> {
    return this.http.put(`${this.baseUrl}/p2p-escrow/${id}`, entry);
  }

  deleteP2PEscrow(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/p2p-escrow/${id}`);
  }

  // ── Fixed Deposits ──
  getFixedDeposits(): Observable<FixedDepositEntry[]> {
    return this.http.get<FixedDepositEntry[]>(`${this.baseUrl}/fixed-deposits`);
  }

  addFixedDeposit(entry: FixedDepositEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/fixed-deposits`, entry);
  }

  updateFixedDeposit(id: number, entry: FixedDepositEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/fixed-deposits/${id}`, entry);
  }

  deleteFixedDeposit(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/fixed-deposits/${id}`);
  }

  // ── Summary ──
  getSummary(): Observable<Summary> {
    return this.http.get<Summary>(`${this.baseUrl}/summary`);
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
    return this.http.get<ForexEntry[]>(`${this.baseUrl}/forex`);
  }

  addForex(entry: ForexEntry): Observable<any> {
    return this.http.post(`${this.baseUrl}/forex`, entry);
  }

  updateForex(id: number, entry: ForexEntry): Observable<any> {
    return this.http.put(`${this.baseUrl}/forex/${id}`, entry);
  }

  deleteForex(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/forex/${id}`);
  }

  // ── AI Analysis ──
  getAIAnalysis(): Observable<{ analysis: string }> {
    return this.http.post<{ analysis: string }>(`${this.baseUrl}/ai/analyze`, {});
  }
}
