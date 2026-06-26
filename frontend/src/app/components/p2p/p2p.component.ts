import { Component, HostListener, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription, forkJoin } from 'rxjs';
import { InvestmentService } from '../../services/investment.service';
import { AuthService } from '../../services/auth.service';
import { UiActionService } from '../../services/ui-action.service';
import { CsvExportService } from '../../services/csv-export.service';
import { InrPipe } from '../../pipes/inr.pipe';
import { P2PEntry, P2PRepayment, P2PEscrow, LendenStatementRow, LendenStatementWarning, LendenParseResult, OrderReportRow, OrderReportParseResult } from '../../models/investment.model';

@Component({
  selector: 'app-p2p',
  standalone: true,
  imports: [CommonModule, FormsModule, InrPipe],
  templateUrl: './p2p.component.html',
  styleUrl: './p2p.component.scss'
})
export class P2PComponent implements OnInit, OnDestroy {
  entries: P2PEntry[] = [];
  allEntries: P2PEntry[] = [];
  repayments: P2PRepayment[] = [];
  escrowTransactions: P2PEscrow[] = [];
  loading = true;
  showForm = false;
  showRepaymentForm = false;
  showEscrowForm = false;
  submitting = false;
  deleting = false;
  submittingRepayment = false;
  deletingRepayment = false;
  submittingEscrow = false;
  deletingEscrow = false;
  showEscrowPanel = false;
  editingId: number | null = null;
  editingRepaymentId: number | null = null;
  editingRepaymentOriginalAmount: number = 0;
  editingRepaymentOriginalDate: string = '';
  editingEscrowId: number | null = null;
  expandedLendingId: string | null = null;
  searchQuery = '';
  statusFilter: 'All' | 'Active' | 'Overdue' | 'Closed' = 'Active';
  sortColumn = '';
  sortDirection: 'asc' | 'desc' = 'asc';
  toasts: { msg: string; type: string }[] = [];

  // ── LenDen Statement Import ──
  showImportModal = false;
  importParsing = false;
  importSubmitting = false;
  importParseResult: LendenParseResult | null = null;
  importError = '';
  importSelectedFile: File | null = null;
  quickAddLoanWarning: LendenStatementWarning | null = null;
  quickAddForm: P2PEntry = this.emptyForm();
  quickAddSubmitting = false;

  // ── Order Report Bulk Import ──
  showOrderReportModal = false;
  orderReportParsing = false;
  orderReportSubmitting = false;
  orderReportParseResult: OrderReportParseResult | null = null;
  orderReportError = '';
  orderReportFile: File | null = null;

  form: P2PEntry = this.emptyForm();
  repaymentForm: P2PRepayment = this.emptyRepaymentForm();
  escrowForm: P2PEscrow = this.emptyEscrowForm();

  private addSub?: Subscription;

  constructor(private investmentService: InvestmentService, private uiActionService: UiActionService, private csvExport: CsvExportService, public authService: AuthService) {}

  get canWrite(): boolean { return this.authService.canWrite(); }

  ngOnInit(): void {
    this.addSub = this.uiActionService.addEntry.subscribe(page => { if (page === 'p2p') this.openAddForm(); });
    this.addSub.add(this.uiActionService.refresh.subscribe(() => { this.uiActionService.beginRefresh(); this.loadData(() => this.uiActionService.endRefresh()); }));
    this.loadData();
    // When fresh bulk-load data arrives, update the view automatically.
    this.addSub.add(this.investmentService.getBulkLoad().subscribe({
      next: (bulk) => {
        if (bulk.p2p)              { this.allEntries = bulk.p2p; }
        if (bulk.p2p_repayments)   { this.repayments = bulk.p2p_repayments; }
        if (bulk.p2p_escrow)       { this.escrowTransactions = bulk.p2p_escrow; }
        if (bulk.p2p || bulk.p2p_repayments || bulk.p2p_escrow) {
          this.applyFilter();
          this.loading = false;
          this.autoUpdateDefaultedStatuses();
        }
      },
      error: () => {}
    }));
  }

  ngOnDestroy(): void { this.addSub?.unsubscribe(); }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.showForm) { this.showForm = false; this.editingId = null; }
    if (this.showRepaymentForm) { this.showRepaymentForm = false; this.editingRepaymentId = null; }
    if (this.showEscrowForm) { this.showEscrowForm = false; }
  }

  emptyForm(): P2PEntry {
    return {
      lending_id: '',
      loan_id: '',
      platform: '',
      name: '',
      date: new Date().toISOString().split('T')[0],
      amount: null,
      tenure: null,
      maturity_date: '',
      status: 'Active',
      remarks: ''
    };
  }

  emptyRepaymentForm(): P2PRepayment {
    return {
      lending_id: '',
      date: new Date().toISOString().split('T')[0],
      principal: null,
      interest: null,
      platform_fee: null,
      amount: null,
      remarks: ''
    };
  }

  emptyEscrowForm(): P2PEscrow {
    return {
      date: new Date().toISOString().split('T')[0],
      type: 'Deposit',
      amount: null,
      platform: '',
      remarks: ''
    };
  }

  generateLendingId(): string {
    const maxNum = this.allEntries.reduce((max, e) => {
      const match = (e.lending_id || '').match(/P2P-(\d+)/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    return `P2P-${String(maxNum + 1).padStart(3, '0')}`;
  }

  computeMaturityDate(): string {
    if (!this.form.date || !this.form.tenure) return '';
    return this._getInstallmentDate(this.form, this.form.tenure).toISOString().split('T')[0];
  }

  onDateOrTenureChange(): void {
    this.form.maturity_date = this.computeMaturityDate();
  }

  // ── Repayment aggregation helpers ──

  getRepayments(lendingId: string): P2PRepayment[] {
    return this.repayments.filter(r => r.lending_id === lendingId);
  }

  // Principal component per installment = lent_amount / tenure
  getPrincipalPerInstallment(entry: P2PEntry): number {
    if (!entry.amount || !entry.tenure || entry.tenure === 0) return 0;
    return entry.amount / entry.tenure;
  }

  // For a single repayment: returns explicit principal if stored, else legacy calculated value
  getRepaymentPrincipal(rep: P2PRepayment, entry: P2PEntry, repIndex?: number): number {
    if (rep.principal != null) return rep.principal;
    // Legacy fallback: calculate from amount
    const repAmount = rep.amount || 0;
    const pp = this.getPrincipalPerInstallment(entry);
    if (repIndex !== undefined) {
      const reps = this.getRepayments(entry.lending_id);
      let cumulativePrincipal = 0;
      for (let i = 0; i < repIndex; i++) {
        const r = reps[i];
        if (r.principal != null) {
          cumulativePrincipal += r.principal;
        } else {
          const ra = r.amount || 0;
          const rem = (entry.amount || 0) - cumulativePrincipal;
          cumulativePrincipal += ra >= rem ? rem : Math.min(ra, pp);
        }
      }
      const remaining = (entry.amount || 0) - cumulativePrincipal;
      if (repAmount >= remaining) return remaining;
    }
    return Math.min(repAmount, pp);
  }

  // For a single repayment: returns explicit interest if stored, else legacy calculated value
  getRepaymentInterest(rep: P2PRepayment, entry: P2PEntry, repIndex?: number): number {
    if (rep.interest != null) return rep.interest;
    return (rep.amount || 0) - this.getRepaymentPrincipal(rep, entry, repIndex);
  }

  // Amount credited to account (platform fee is informational only, does not reduce received amount)
  getRepaymentNetCredited(rep: P2PRepayment): number {
    return rep.principal != null
      ? (rep.principal || 0) + (rep.interest || 0)
      : (rep.amount || 0);
  }

  // Received = sum of principal portions only
  getTotalRepaid(lendingId: string): number {
    const entry = this.allEntries.find(e => e.lending_id === lendingId);
    if (!entry) return 0;
    const reps = this.getRepayments(lendingId);
    const pp = this.getPrincipalPerInstallment(entry);
    let cumPrincipal = 0;
    for (let i = 0; i < reps.length; i++) {
      const rep = reps[i];
      if (rep.principal != null) {
        cumPrincipal += rep.principal;
      } else {
        const repAmount = rep.amount || 0;
        const remaining = (entry.amount || 0) - cumPrincipal;
        if (repAmount >= remaining) cumPrincipal += remaining;
        else cumPrincipal += Math.min(repAmount, pp);
      }
    }
    return cumPrincipal;
  }

  // Total gross interest earned for a lending (before platform fees)
  getTotalInterest(lendingId: string): number {
    const entry = this.allEntries.find(e => e.lending_id === lendingId);
    if (!entry) return 0;
    const reps = this.getRepayments(lendingId);
    const pp = this.getPrincipalPerInstallment(entry);
    let cumPrincipal = 0;
    let totalInterest = 0;
    for (let i = 0; i < reps.length; i++) {
      const rep = reps[i];
      if (rep.principal != null && rep.interest != null) {
        cumPrincipal += rep.principal;
        totalInterest += rep.interest;
      } else {
        const repAmount = rep.amount || 0;
        const remaining = (entry.amount || 0) - cumPrincipal;
        if (repAmount >= remaining) {
          cumPrincipal += remaining;
          totalInterest += repAmount - remaining;
        } else {
          const principal = Math.min(repAmount, pp);
          cumPrincipal += principal;
          totalInterest += repAmount - principal;
        }
      }
    }
    return totalInterest;
  }

  // Total platform fees paid for a lending
  getTotalPlatformFees(lendingId: string): number {
    return this.getRepayments(lendingId).reduce((s, r) => s + (r.platform_fee || 0), 0);
  }

  getReturns(entry: P2PEntry): number | null {
    const interest = this.getTotalInterest(entry.lending_id);
    if (interest === 0 && entry.amount == null) return null;
    return interest;
  }

  getInterestRate(entry: P2PEntry): number | null {
    const netInterest = this.getTotalNetInterest(entry.lending_id);
    if (!entry.amount || netInterest <= 0 || !entry.date) return null;
    const start = new Date(entry.date);
    const reps = this.getRepayments(entry.lending_id);
    const end = reps.length > 0 ? new Date(reps[reps.length - 1].date) : new Date();
    const daysElapsed = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
    // Annualized net yield: (net interest / principal) * (365 / days) * 100
    return (netInterest / entry.amount) * (365 / daysElapsed) * 100;
  }

  getRepaymentAnnualizedRate(entry: P2PEntry, repIndex: number): number | null {
    if (!entry.amount || !entry.date) return null;
    const reps = this.getRepayments(entry.lending_id);
    if (repIndex >= reps.length) return null;
    // Cumulative interest up to this repayment
    let cumulativeNetInterest = 0;
    for (let i = 0; i <= repIndex; i++) {
      cumulativeNetInterest += this.getRepaymentInterest(reps[i], entry, i);
    }
    if (cumulativeNetInterest <= 0) return null;
    const start = new Date(entry.date);
    const end = new Date(reps[repIndex].date);
    const daysElapsed = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
    return (cumulativeNetInterest / entry.amount) * (365 / daysElapsed) * 100;
  }

  getPendingAmount(entry: P2PEntry): number {
    return (entry.amount || 0) - this.getTotalRepaid(entry.lending_id);
  }

  getNextInstallmentDate(entry: P2PEntry): string {
    if (entry.status !== 'Active' || !entry.date || !entry.tenure) return '-';
    const pp = this.getPrincipalPerInstallment(entry);
    if (!pp) return '-';
    const principalReceived = this.getTotalRepaid(entry.lending_id);
    // Round ratio to 2 decimal places before flooring to handle stored amounts
    // being truncated (e.g. 250/3 = 83.333... stored as 83.33 → ratio 0.99996 → should be 1)
    const completedInstallments = Math.floor(Math.round(principalReceived / pp * 100) / 100);
    const nextInstallmentNum = completedInstallments + 1;
    if (nextInstallmentNum > entry.tenure) return '-';
    return this._getInstallmentDate(entry, nextInstallmentNum).toISOString().split('T')[0];
  }

  /**
   * Returns the due date for installment `num` (1-indexed).
   * Rule: if disbursed on/before 20th → 1st installment = 5th of next month
   *        if disbursed after 20th    → 1st installment = 5th of the month after next
   * Subsequent installments are on the 5th of each following month.
   */
  private _getInstallmentDate(entry: P2PEntry, installmentNum: number): Date {
    if (!entry.date) return new Date(0);
    const start = new Date(entry.date);
    const baseOffset = start.getDate() <= 20 ? 1 : 2;
    return new Date(start.getFullYear(), start.getMonth() + baseOffset + (installmentNum - 1), 5);
  }

  // ── Summary getters ──

  get totalLent(): number {
    return this.allEntries.reduce((s, e) => s + (e.amount || 0), 0);
  }

  get totalRepaid(): number {
    // Sum of principal portions across all repayments
    return this.allEntries.reduce((s, e) => s + this.getTotalRepaid(e.lending_id), 0);
  }

  // Total interest earned for a lending (platform fee is informational only)
  getTotalNetInterest(lendingId: string): number {
    return this.getTotalInterest(lendingId);
  }

  get totalReturns(): number {
    return this.allEntries.reduce((s, e) => s + this.getTotalNetInterest(e.lending_id), 0);
  }

  get avgInterestRateNum(): number {
    const withRate = this.allEntries.filter(e => this.getInterestRate(e) != null);
    if (withRate.length === 0) return 0;
    const sum = withRate.reduce((s, e) => s + (this.getInterestRate(e) || 0), 0);
    return sum / withRate.length;
  }

  get activeAvgInterestRateNum(): number {
    const withRate = this.allEntries.filter(e => e.status === 'Active' && this.getInterestRate(e) != null);
    if (withRate.length === 0) return 0;
    const sum = withRate.reduce((s, e) => s + (this.getInterestRate(e) || 0), 0);
    return sum / withRate.length;
  }

  get expectedReturn(): number {
    const fallbackRate = this.activeAvgInterestRateNum || this.avgInterestRateNum;
    return this.allEntries
      .filter(e => e.status === 'Active')
      .reduce((sum, e) => {
        const pending = (e.amount || 0) - this.getTotalRepaid(e.lending_id);
        if (pending <= 0 || !e.tenure) return sum;
        const rate = this.getInterestRate(e) ?? fallbackRate;
        const repsDone = this.getRepayments(e.lending_id).length;
        const remainingInstallments = Math.max(0, e.tenure - repsDone);
        if (remainingInstallments === 0) return sum;
        // Declining balance: interest on average outstanding across remaining installments
        // Each installment repays pending/remaining principal, so avg outstanding = pending * (n+1) / (2*n)
        // Expected interest = avg_outstanding * rate/100 * remaining_months/12
        const avgOutstanding = pending * (remainingInstallments + 1) / (2 * remainingInstallments);
        return sum + avgOutstanding * (rate / 100) * (remainingInstallments / 12);
      }, 0);
  }

  get totalPending(): number {
    return this.totalLent - this.totalRepaid;
  }

  get activeLendings(): number {
    return this.allEntries.filter(e => e.status === 'Active').length;
  }

  get activeLentAmount(): number {
    return this.allEntries.filter(e => e.status === 'Active').reduce((s, e) => s + (e.amount || 0), 0);
  }

  get pendingActiveLentAmount(): number {
    return this.allEntries
      .filter(e => e.status === 'Active')
      .reduce((s, e) => s + this.getPendingAmount(e), 0);
  }

  get defaultedCount(): number {
    return this.allEntries.filter(e => e.status === 'Defaulted').length;
  }

  get defaultedAmount(): number {
    return this.allEntries.filter(e => e.status === 'Defaulted').reduce((s, e) => {
      const repaid = this.getTotalRepaid(e.lending_id);
      return s + ((e.amount || 0) - repaid);
    }, 0);
  }

  get avgInterestRate(): string {
    if (this.avgInterestRateNum === 0) return '-';
    return this.avgInterestRateNum.toFixed(2) + '%';
  }

  // ── Feature: Overdue check ──
  isOverdue(entry: P2PEntry): boolean {
    if (entry.status !== 'Active') return false;
    const nextDate = this.getNextInstallmentDate(entry);
    if (nextDate === '-') return false;
    return new Date(nextDate) < new Date();
  }

  getOverdueDays(entry: P2PEntry): number {
    const nextDate = this.getNextInstallmentDate(entry);
    if (nextDate === '-') return 0;
    const diff = new Date().getTime() - new Date(nextDate).getTime();
    return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
  }

  autoUpdateDefaultedStatuses(): void {
    const toDefault = this.allEntries.filter(e => this.isAutoDefaulted(e));
    toDefault.forEach(e => {
      this.investmentService.updateP2P(e.id!, { ...e, status: 'Defaulted' }).subscribe({
        next: () => { e.status = 'Defaulted'; },
        error: () => {}
      });
    });
  }

  isAutoDefaulted(entry: P2PEntry): boolean {
    return entry.status === 'Active' && this.isOverdue(entry) && this.getOverdueDays(entry) > 90;
  }

  get overdueCount(): number {
    return this.allEntries.filter(e => this.isOverdue(e)).length;
  }

  get overdueAmount(): number {
    return this.allEntries.filter(e => this.isOverdue(e)).reduce((s, e) => s + this.getPendingAmount(e), 0);
  }

  // ── Feature: Foreclosure check ──
  isForeclosed(entry: P2PEntry): boolean {
    if (entry.status !== 'Closed') return false;
    const reps = this.getRepayments(entry.lending_id);
    return reps.length < (entry.tenure || 0);
  }

  get foreclosedCount(): number {
    return this.allEntries.filter(e => this.isForeclosed(e)).length;
  }

  // ── Feature: Platform breakdown ──
  get platformBreakdown(): { platform: string; lent: number; active: number; avgRate: string }[] {
    const map = new Map<string, { lent: number; active: number; rates: number[] }>();
    this.allEntries.forEach(e => {
      const p = e.platform || 'Unknown';
      const existing = map.get(p) || { lent: 0, active: 0, rates: [] };
      existing.lent += (e.amount || 0);
      if (e.status === 'Active') existing.active++;
      const rate = this.getInterestRate(e);
      if (rate != null) existing.rates.push(rate);
      map.set(p, existing);
    });
    return Array.from(map.entries()).map(([platform, data]) => ({
      platform,
      lent: data.lent,
      active: data.active,
      avgRate: data.rates.length > 0 ? (data.rates.reduce((s, r) => s + r, 0) / data.rates.length).toFixed(1) + '%' : '-'
    }));
  }

  // ── Feature: Monthly Return % trend (last 6 months + next 3 projected) ──
  get monthlyReturnTrend(): { month: string; returnPct: number; returnAmount: number; projectedPct: number | null; projectedAmount: number | null; isFuture: boolean; isCurrent: boolean }[] {
    const now = new Date();
    const result: { month: string; returnPct: number; returnAmount: number; projectedPct: number | null; projectedAmount: number | null; isFuture: boolean; isCurrent: boolean }[] = [];

    // Historical: last 5 months (excluding current)
    for (let i = 5; i >= 1; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthLabel = d.toLocaleString('default', { month: 'short', year: '2-digit' });
      const m = d.getMonth();
      const y = d.getFullYear();
      let interest = 0;
      let principal = 0;
      this.repayments.forEach(rep => {
        const repDate = new Date(rep.date);
        if (repDate.getMonth() === m && repDate.getFullYear() === y) {
          const entry = this.allEntries.find(e => e.lending_id === rep.lending_id);
          if (entry) {
            const idx = this.getRepayments(entry.lending_id).indexOf(rep);
            const intAmt = this.getRepaymentInterest(rep, entry, idx >= 0 ? idx : undefined);
            interest += intAmt;
            principal += rep.principal != null ? rep.principal : (rep.amount || 0) - intAmt;
          }
        }
      });
      result.push({ month: monthLabel, returnPct: principal > 0 ? (interest / principal) * 100 : 0, returnAmount: interest, projectedPct: null, projectedAmount: null, isFuture: false, isCurrent: false });
    }

    // Current month: actual so far + projected
    const curLabel = now.toLocaleString('default', { month: 'short', year: '2-digit' });
    const cm = now.getMonth();
    const cy = now.getFullYear();
    let curInterest = 0;
    let curPrincipal = 0;
    this.repayments.forEach(rep => {
      const repDate = new Date(rep.date);
      if (repDate.getMonth() === cm && repDate.getFullYear() === cy) {
        const entry = this.allEntries.find(e => e.lending_id === rep.lending_id);
        if (entry) {
          const idx = this.getRepayments(entry.lending_id).indexOf(rep);
          const intAmt = this.getRepaymentInterest(rep, entry, idx >= 0 ? idx : undefined);
          curInterest += intAmt;
          curPrincipal += rep.principal != null ? rep.principal : (rep.amount || 0) - intAmt;
        }
      }
    });
    const curProj = this._expectedReturnForMonth(0);
    result.push({
      month: curLabel,
      returnPct: curPrincipal > 0 ? (curInterest / curPrincipal) * 100 : 0,
      returnAmount: curInterest,
      projectedPct: curProj.pct,
      projectedAmount: curProj.interest,
      isFuture: false,
      isCurrent: true
    });

    // Projected: next 3 months
    for (let offset = 1; offset <= 3; offset++) {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      const monthLabel = d.toLocaleString('default', { month: 'short', year: '2-digit' });
      const proj = this._expectedReturnForMonth(offset);
      result.push({ month: monthLabel, returnPct: proj.pct, returnAmount: proj.interest, projectedPct: null, projectedAmount: null, isFuture: true, isCurrent: false });
    }

    return result;
  }

  private _expectedReturnForMonth(offset: number): { pct: number; interest: number } {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const tm = target.getMonth();
    const ty = target.getFullYear();
    const fallbackRate = this.activeAvgInterestRateNum || this.avgInterestRateNum;
    let totalPrincipal = 0;
    let totalInterest = 0;
    this.allEntries.filter(e => e.status === 'Active').forEach(e => {
      if (!e.date || !e.tenure || !e.amount) return;
      const repsDone = this.getRepayments(e.lending_id).length;
      const pp = this.getPrincipalPerInstallment(e);
      const pending = this.getPendingAmount(e);
      const rate = this.getInterestRate(e) ?? fallbackRate;
      for (let i = 1; i <= e.tenure; i++) {
        const instDate = this._getInstallmentDate(e, i);
        if (instDate.getMonth() === tm && instDate.getFullYear() === ty) {
          if (i <= repsDone) break;
          const k = i - repsDone;
          const balanceBeforePayment = Math.max(0, pending - (k - 1) * pp);
          totalPrincipal += pp;
          totalInterest += balanceBeforePayment * (rate / 100 / 12);
          break;
        }
      }
    });
    return { pct: totalPrincipal > 0 ? (totalInterest / totalPrincipal) * 100 : 0, interest: totalInterest };
  }

  private _expectedReturnPctForMonth(offset: number): number {
    return this._expectedReturnForMonth(offset).pct;
  }

  // ── Feature: IRR per lending ──
  getIRR(entry: P2PEntry): number | null {
    if (!entry.date || !entry.amount) return null;
    const reps = this.getRepayments(entry.lending_id);
    if (reps.length === 0) return null;

    // Cash flows: initial outflow (negative), then net-credited amounts (positive)
    const startDate = new Date(entry.date);
    const cashFlows: { amount: number; days: number }[] = [{ amount: -entry.amount, days: 0 }];
    reps.forEach(rep => {
      const repDate = new Date(rep.date);
      const days = Math.round((repDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      cashFlows.push({ amount: this.getRepaymentNetCredited(rep), days });
    });

    // If still active, add pending as future cash flow at maturity
    if (entry.status === 'Active') {
      const pending = this.getPendingAmount(entry);
      if (pending > 0 && entry.maturity_date) {
        const matDate = new Date(entry.maturity_date);
        const days = Math.round((matDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        cashFlows.push({ amount: pending, days });
      }
    }

    // Newton's method to find daily rate, then annualize
    let rate = 0.0001; // initial guess (daily)
    for (let iter = 0; iter < 100; iter++) {
      let npv = 0;
      let dnpv = 0;
      for (const cf of cashFlows) {
        const pv = cf.amount / Math.pow(1 + rate, cf.days);
        npv += pv;
        dnpv -= cf.days * cf.amount / Math.pow(1 + rate, cf.days + 1);
      }
      if (Math.abs(npv) < 0.01) break;
      if (dnpv === 0) break;
      rate = rate - npv / dnpv;
      if (rate <= -1) return null; // diverged
    }
    // Annualize: (1 + daily_rate)^365 - 1
    const annualRate = (Math.pow(1 + rate, 365) - 1) * 100;
    return isFinite(annualRate) ? annualRate : null;
  }

  get portfolioIRR(): number | null {
    // Amount-weighted IRR across all lendings with data
    const eligible = this.allEntries.filter(e => this.getIRR(e) != null && (e.amount || 0) > 0);
    if (eligible.length === 0) return null;
    const totalWeight = eligible.reduce((s, e) => s + (e.amount || 0), 0);
    if (totalWeight === 0) return null;
    return eligible.reduce((s, e) => s + (this.getIRR(e)! * (e.amount || 0)), 0) / totalWeight;
  }

  get maxMonthlyReturnPct(): number {
    return Math.max(
      ...this.monthlyReturnTrend.map(m => Math.max(m.returnPct, m.projectedPct ?? 0)),
      1
    );
  }

  get maxActualReturnPct(): number {
    return Math.max(
      ...this.monthlyReturnTrend.filter(m => !m.isFuture).map(m => m.returnPct),
      1
    );
  }

  get maxProjectedReturnPct(): number {
    return Math.max(
      ...this.monthlyReturnTrend.filter(m => m.isFuture).map(m => m.returnPct),
      ...this.monthlyReturnTrend.filter(m => m.isCurrent).map(m => m.projectedPct ?? 0),
      1
    );
  }

  // ── Feature: This month's expected inflow ──
  get thisMonthInflow(): number {
    return this.getExpectedInflowForMonth(0);
  }

  // ── Monthly Inflow KPI helpers ──

  private getExpectedInflowForMonth(offset: number): number {
    const now = new Date();
    const targetDate = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const targetMonth = targetDate.getMonth();
    const targetYear = targetDate.getFullYear();
    const targetStart = targetDate.getTime();

    return this.allEntries.filter(e => e.status === 'Active').reduce((sum, e) => {
      if (!e.date || !e.tenure) return sum;
      const pp = this.getPrincipalPerInstallment(e);

      // Sum principal already received before the target month started
      const reps = this.getRepayments(e.lending_id).slice().sort((a, b) => a.date < b.date ? -1 : 1);
      let principalBeforeMonth = 0;
      reps.forEach((r, idx) => {
        if (new Date(r.date).getTime() < targetStart) {
          principalBeforeMonth += this.getRepaymentPrincipal(r, e, idx);
        }
      });
      const completedInstallments = Math.floor(Math.round(principalBeforeMonth / pp * 100) / 100);
      const excessPrincipal = principalBeforeMonth - completedInstallments * pp;

      for (let i = 1; i <= e.tenure; i++) {
        const instDate = this._getInstallmentDate(e, i);
        if (instDate.getMonth() === targetMonth && instDate.getFullYear() === targetYear) {
          // Already fully paid early
          if (completedInstallments >= i) return sum;
          // This is the next due installment — reduce by any excess already paid
          if (i === completedInstallments + 1) {
            const remaining = Math.max(0, pp - excessPrincipal);
            return sum + remaining;
          }
          return sum + pp;
        }
      }
      return sum;
    }, 0);
  }

  private getActualInflowForMonth(offset: number): number {
    const now = new Date();
    const targetDate = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const targetMonth = targetDate.getMonth();
    const targetYear = targetDate.getFullYear();

    return this.repayments.reduce((sum, r) => {
      if (!r.date || !r.amount) return sum;
      const d = new Date(r.date);
      if (d.getMonth() === targetMonth && d.getFullYear() === targetYear) {
        const entry = this.allEntries.find(e => e.lending_id === r.lending_id);
        if (!entry) return sum + (r.principal ?? r.amount);
        const reps = this.getRepayments(entry.lending_id);
        const idx = reps.indexOf(r);
        return sum + this.getRepaymentPrincipal(r, entry, idx >= 0 ? idx : undefined);
      }
      return sum;
    }, 0);
  }

  get prevMonthExpected(): number { return this.getExpectedInflowForMonth(-1); }
  get prevMonthActual(): number { return this.getActualInflowForMonth(-1); }
  get currentMonthExpected(): number { return this.getExpectedInflowForMonth(0); }
  get currentMonthActual(): number { return this.getActualInflowForMonth(0); }
  get nextMonthExpected(): number { return this.getExpectedInflowForMonth(1); }
  get nextMonthActual(): number { return this.getActualInflowForMonth(1); }

  getMonthLabel(offset: number): string {
    const d = new Date();
    d.setMonth(d.getMonth() + offset);
    return d.toLocaleString('default', { month: 'short', year: 'numeric' });
  }

  formatReturnPct(pct: number): string {
    return pct.toFixed(2) + '%';
  }

  // ── Feature: Recovery rate for defaulted ──
  get recoveryRate(): string {
    const defaulted = this.allEntries.filter(e => e.status === 'Defaulted');
    if (defaulted.length === 0) return '-';
    const totalLent = defaulted.reduce((s, e) => s + (e.amount || 0), 0);
    if (totalLent === 0) return '-';
    const totalRecovered = defaulted.reduce((s, e) => s + this.getTotalRepaid(e.lending_id), 0);
    return ((totalRecovered / totalLent) * 100).toFixed(1) + '%';
  }

  // ── Data operations ──

  loadData(onComplete?: () => void): void {
    if (this.allEntries.length === 0) this.loading = true;
    forkJoin({
      p2p: this.investmentService.getP2P(),
      repayments: this.investmentService.getP2PRepayments(),
      escrow: this.investmentService.getP2PEscrow()
    }).subscribe({
      next: ({ p2p, repayments, escrow }) => {
        this.allEntries = p2p;
        this.repayments = repayments;
        this.escrowTransactions = escrow;
        this.applyFilter();
        this.loading = false;
        this.autoUpdateDefaultedStatuses();
        onComplete?.();
      },
      error: () => { this.toast('Failed to load entries', 'error'); this.loading = false; onComplete?.(); }
    });
  }

  setStatusFilter(f: 'All' | 'Active' | 'Overdue' | 'Closed'): void {
    this.statusFilter = f;
    this.applyFilter();
  }

  applyFilter(): void {
    let filtered = this.allEntries;
    if (this.statusFilter === 'Active') {
      filtered = filtered.filter(e => e.status === 'Active');
    } else if (this.statusFilter === 'Overdue') {
      filtered = filtered.filter(e => this.isOverdue(e));
    } else if (this.statusFilter === 'Closed') {
      filtered = filtered.filter(e => e.status !== 'Active');
    }
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(e =>
        (e.lending_id || '').toLowerCase().includes(q) ||
        (e.name || '').toLowerCase().includes(q) ||
        (e.platform || '').toLowerCase().includes(q) ||
        (e.status || '').toLowerCase().includes(q) ||
        (e.date || '').includes(q)
      );
    }
    if (this.sortColumn) {
      filtered = [...filtered].sort((a, b) => {
        let va: any, vb: any;
        if (this.sortColumn === 'nextInstallment') {
          va = this.getNextInstallmentDate(a);
          vb = this.getNextInstallmentDate(b);
          if (va === '-') va = null;
          if (vb === '-') vb = null;
        } else {
          va = (a as any)[this.sortColumn];
          vb = (b as any)[this.sortColumn];
        }
        let cmp = 0;
        if (va == null && vb == null) cmp = 0;
        else if (va == null) cmp = -1;
        else if (vb == null) cmp = 1;
        else if (typeof va === 'number') cmp = va - (vb as number);
        else cmp = String(va).localeCompare(String(vb));
        return this.sortDirection === 'asc' ? cmp : -cmp;
      });
    }
    this.entries = filtered;
  }

  onSearch(): void { this.applyFilter(); }

  sort(column: string): void {
    if (this.sortColumn === column) { this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc'; }
    else { this.sortColumn = column; this.sortDirection = 'asc'; }
    this.applyFilter();
  }

  sortIcon(column: string): string {
    if (this.sortColumn !== column) return '↕';
    return this.sortDirection === 'asc' ? '↑' : '↓';
  }

  // ── Lending form ──

  openAddForm(): void {
    this.form = this.emptyForm();
    this.form.lending_id = this.generateLendingId();
    this.editingId = null;
    this.showForm = true;
  }

  onNameChange(): void {
    if (this.editingId) return;
    const match = this.allEntries.find(e => e.name?.toLowerCase() === this.form.name?.toLowerCase().trim());
    if (match) {
      this.form.platform = match.platform;
    }
  }

  openEditForm(entry: P2PEntry): void {
    this.form = { ...entry };
    this.editingId = entry.id!;
    this.showForm = true;
  }

  cancelForm(): void { this.showForm = false; this.editingId = null; }

  saveEntry(): void {
    if (!this.form.platform?.trim()) { this.toast('Platform is required', 'error'); return; }
    if (!this.form.loan_id?.trim()) { this.toast('Loan ID is required', 'error'); return; }
    if (!this.form.name?.trim()) { this.toast('Name is required', 'error'); return; }
    if (!this.form.amount || this.form.amount <= 0) { this.toast('Amount is required', 'error'); return; }
    if (!this.form.tenure || this.form.tenure <= 0) { this.toast('Tenure is required', 'error'); return; }

    // Normalize loan_id: uppercase and trim
    if (this.form.loan_id) this.form.loan_id = this.form.loan_id.trim().toUpperCase();

    this.form.maturity_date = this.computeMaturityDate();

    this.submitting = true;
    if (this.editingId) {
      this.investmentService.updateP2P(this.editingId, this.form).subscribe({
        next: () => {
          const idx = this.allEntries.findIndex(e => e.id === this.editingId!);
          if (idx >= 0) this.allEntries[idx] = { ...this.form, id: this.editingId! };
          this.applyFilter();
          this.submitting = false; this.toast('Lending updated', 'success'); this.showForm = false; this.editingId = null;
          this.uiActionService.triggerSilentRefresh();
        },
        error: () => { this.submitting = false; this.toast('Failed to update', 'error'); }
      });
    } else {
      this.investmentService.addP2P(this.form).subscribe({
        next: (res) => {
          this.allEntries.push({ ...this.form, id: res.id });
          this.applyFilter();
          this.submitting = false; this.toast('Lending added', 'success'); this.showForm = false;
          this.uiActionService.triggerSilentRefresh();
        },
        error: () => { this.submitting = false; this.toast('Failed to add', 'error'); }
      });
    }
  }

  deleteEntry(id: number): void {
    if (confirm('Delete this lending and all its repayments?')) {
      this.deleting = true;
      this.investmentService.deleteP2P(id).subscribe({
        next: () => {
          const entry = this.allEntries.find(e => e.id === id);
          if (entry) {
            this.repayments = this.repayments.filter(r => r.lending_id !== entry.lending_id);
            this.escrowTransactions = this.escrowTransactions.filter(t =>
              !t.remarks?.startsWith(`Auto: ${entry.lending_id}`)
            );
          }
          this.allEntries = this.allEntries.filter(e => e.id !== id);
          this.applyFilter();
          this.deleting = false; this.toast('Lending deleted', 'success');
          this.uiActionService.triggerSilentRefresh();
        },
        error: () => { this.deleting = false; this.toast('Failed to delete', 'error'); }
      });
    }
  }

  // ── Repayment form ──

  toggleExpand(lendingId: string): void {
    this.expandedLendingId = this.expandedLendingId === lendingId ? null : lendingId;
  }

  openRepaymentForm(lendingId: string): void {
    this.repaymentForm = this.emptyRepaymentForm();
    this.repaymentForm.lending_id = lendingId;
    // Auto-fill remarks with installment number
    const entry = this.allEntries.find(e => e.lending_id === lendingId);
    const repCount = this.getRepayments(lendingId).length;
    const tenure = entry?.tenure || 0;
    this.repaymentForm.remarks = `Installment ${repCount + 1} of ${tenure}`;
    this.editingRepaymentId = null;
    this.showRepaymentForm = true;
  }

  getRepaymentPendingAmount(): number {
    const entry = this.allEntries.find(e => e.lending_id === this.repaymentForm.lending_id);
    return entry ? this.getPendingAmount(entry) : 0;
  }

  // Called when Principal or Interest changes — auto-populates platform fee and updates remarks
  onRepaymentComponentChange(): void {
    if (this.editingRepaymentId) return;
    const principal = this.repaymentForm.principal || 0;
    // Auto-populate platform fee as 1% of principal (user can override before submitting)
    if (principal > 0) {
      this.repaymentForm.platform_fee = Math.round(principal * 0.01 * 100) / 100;
    } else {
      this.repaymentForm.platform_fee = null;
    }
    const pending = this.getRepaymentPendingAmount();
    const entry = this.allEntries.find(e => e.lending_id === this.repaymentForm.lending_id);
    const repCount = this.getRepayments(this.repaymentForm.lending_id).length;
    const tenure = entry?.tenure || 0;
    if (principal > 0 && pending > 0 && principal >= pending) {
      this.repaymentForm.remarks = 'Final Settlement';
    } else {
      this.repaymentForm.remarks = `Installment ${repCount + 1} of ${tenure}`;
    }
  }

  // Computed net credited for the repayment form preview
  get repaymentGrossAmount(): number {
    return (this.repaymentForm.principal || 0) + (this.repaymentForm.interest || 0);
  }

  get repaymentNetCreditedPreview(): number {
    return this.repaymentGrossAmount;
  }

  openEditRepaymentForm(rep: P2PRepayment): void {
    this.repaymentForm = { ...rep };
    // Pre-fill principal/interest from calculated values for legacy records missing them
    if (rep.principal == null && rep.amount) {
      const entry = this.allEntries.find(e => e.lending_id === rep.lending_id);
      if (entry) {
        const reps = this.getRepayments(rep.lending_id);
        const idx = reps.findIndex(r => r.id === rep.id);
        const calcPrincipal = this.getRepaymentPrincipal(rep, entry, idx >= 0 ? idx : undefined);
        this.repaymentForm.principal = calcPrincipal;
        this.repaymentForm.interest = (rep.amount || 0) - calcPrincipal;
        this.repaymentForm.platform_fee = null;
      }
    }
    this.editingRepaymentId = rep.id!;
    this.editingRepaymentOriginalAmount = rep.amount || 0;
    this.editingRepaymentOriginalDate = rep.date;
    this.showRepaymentForm = true;
  }

  cancelRepaymentForm(): void { this.showRepaymentForm = false; this.editingRepaymentId = null; }

  saveRepayment(): void {
    if (!this.repaymentForm.principal || this.repaymentForm.principal <= 0) { this.toast('Principal is required', 'error'); return; }
    if (this.repaymentForm.interest == null || this.repaymentForm.interest < 0) { this.toast('Interest is required (0 is allowed)', 'error'); return; }

    // Compute total repayment amount = principal + interest
    this.repaymentForm.amount = (this.repaymentForm.principal || 0) + (this.repaymentForm.interest || 0);

    // Check if this is a final settlement (principal >= pending)
    const entry = this.allEntries.find(e => e.lending_id === this.repaymentForm.lending_id);
    const pending = entry ? this.getPendingAmount(entry) : 0;
    const isFinalSettlement = entry && (this.repaymentForm.principal || 0) >= pending && pending > 0;
    const platformFee = this.repaymentForm.platform_fee || 0;

    if (isFinalSettlement && !this.editingRepaymentId) {
      const feeStr = platformFee > 0 ? `, Fee: ₹${platformFee.toFixed(2)}` : '';
      this.repaymentForm.remarks = `Final Settlement (P: ₹${pending.toFixed(2)}, I: ₹${(this.repaymentForm.interest || 0).toFixed(2)}${feeStr})`;
    }

    const editingId = this.editingRepaymentId; // capture before any async nullification
    const origAmount = this.editingRepaymentOriginalAmount;
    const origDate = this.editingRepaymentOriginalDate;

    const afterSave = (savedRepaymentId?: number) => {
      // Update local repayments array
      if (editingId) {
        const idx = this.repayments.findIndex(r => r.id === editingId);
        if (idx >= 0) this.repayments[idx] = { ...this.repaymentForm, id: editingId };

        // Sync auto-created escrow entry
        const escrowMatch = this.escrowTransactions.find(e =>
          e.date === origDate &&
          e.type === 'Repayment' &&
          (e.remarks || '').includes(this.repaymentForm.lending_id) &&
          e.amount === origAmount
        );
        if (escrowMatch?.id) {
          const updated = { ...escrowMatch, amount: this.repaymentForm.amount || 0, date: this.repaymentForm.date };
          this.investmentService.updateP2PEscrow(escrowMatch.id, updated).subscribe({
            next: () => {
              const i = this.escrowTransactions.findIndex(e => e.id === escrowMatch.id);
              if (i >= 0) this.escrowTransactions[i] = updated;
            }
          });
        }

        // Sync auto-created capital flow entry
        this.investmentService.getCapitalFlows().subscribe({
          next: (flows) => {
            const flowMatch = flows.find((f: any) =>
              f.date === origDate &&
              f.type === 'Withdrawal' &&
              f.category === 'P2P' &&
              f.amount === origAmount
            );
            if (flowMatch?.id) {
              this.investmentService.updateCapitalFlow(flowMatch.id, { ...flowMatch, amount: this.repaymentForm.amount || 0, date: this.repaymentForm.date }).subscribe();
            }
          }
        });

      } else if (savedRepaymentId !== undefined) {
        this.repayments.push({ ...this.repaymentForm, id: savedRepaymentId });
      }

      // Auto-post amount received (principal + interest) as escrow entry — only for new repayments
      if (!editingId && entry) {
        const netCredited = this.repaymentForm.amount || 0;
        if (netCredited > 0) {
          const escrowEntry: P2PEscrow = {
            date: this.repaymentForm.date,
            type: 'Repayment',
            amount: netCredited,
            platform: entry.platform,
            remarks: `Auto: ${entry.lending_id} - ${entry.name}`
          };
          this.investmentService.addP2PEscrow(escrowEntry).subscribe({
            next: (esc) => { this.escrowTransactions.push({ ...escrowEntry, id: esc.id }); this.applyFilter(); }
          });
        }
      }

      if (isFinalSettlement && entry && !editingId) {
        // Auto-close the lending, update maturity_date to repayment date
        const updated = { ...entry, status: 'Closed', maturity_date: this.repaymentForm.date };
        this.investmentService.updateP2P(entry.id!, updated).subscribe({
          next: () => {
            const idx = this.allEntries.findIndex(e => e.id === entry!.id);
            if (idx >= 0) this.allEntries[idx] = updated;
            this.applyFilter();
            this.toast('Lending closed (full & final settlement)', 'success');
          },
          error: () => this.applyFilter()
        });
      } else {
        this.applyFilter();
        this.checkAutoClose(this.repaymentForm.lending_id);
      }
    };

    this.submittingRepayment = true;
    if (editingId) {
      this.investmentService.updateP2PRepayment(editingId, this.repaymentForm).subscribe({
        next: () => { this.submittingRepayment = false; this.toast('Repayment updated', 'success'); this.showRepaymentForm = false; this.editingRepaymentId = null; afterSave(); this.uiActionService.triggerSilentRefresh(); },
        error: () => { this.submittingRepayment = false; this.toast('Failed to update repayment', 'error'); }
      });
    } else {
      this.investmentService.addP2PRepayment(this.repaymentForm).subscribe({
        next: (res) => { this.submittingRepayment = false; this.toast('Repayment recorded', 'success'); this.showRepaymentForm = false; afterSave(res.id); this.uiActionService.triggerSilentRefresh(); },
        error: () => { this.submittingRepayment = false; this.toast('Failed to add repayment', 'error'); }
      });
    }
  }

  deleteRepayment(id: number): void {
    if (confirm('Delete this repayment entry?')) {
      this.deletingRepayment = true;
      const rep = this.repayments.find(r => r.id === id);
      this.investmentService.deleteP2PRepayment(id).subscribe({
        next: () => {
          this.deletingRepayment = false;
          this.toast('Repayment deleted', 'success');
          // Remove from local repayments
          this.repayments = this.repayments.filter(r => r.id !== id);
          // Clean up auto-created escrow entry for this repayment
          if (rep) {
            const entry = this.allEntries.find(e => e.lending_id === rep.lending_id);
            if (entry) {
              const matchingEscrow = this.escrowTransactions.find(t =>
                t.type === 'Repayment' && t.date === rep.date &&
                t.remarks?.startsWith(`Auto: ${entry.lending_id}`)
              );
              if (matchingEscrow) {
                this.investmentService.deleteP2PEscrow(matchingEscrow.id!).subscribe();
                this.escrowTransactions = this.escrowTransactions.filter(t => t.id !== matchingEscrow.id);
              }
            }
          }
          // Check if lending needs re-activation
          const lendingId = rep?.lending_id;
          if (lendingId) {
            const entry = this.allEntries.find(e => e.lending_id === lendingId);
            if (entry && entry.status === 'Closed') {
              const pending = this.getPendingAmount(entry);
              if (pending > 0) {
                const updated = { ...entry, status: 'Active' };
                this.investmentService.updateP2P(entry.id!, updated).subscribe({
                  next: () => {
                    const idx = this.allEntries.findIndex(e => e.lending_id === lendingId);
                    if (idx >= 0) this.allEntries[idx] = updated;
                    this.applyFilter();
                    this.toast('Lending re-activated (pending amount remaining)', 'success');
                    this.uiActionService.triggerSilentRefresh();
                  },
                  error: () => this.applyFilter()
                });
                return;
              }
            }
          }
          this.applyFilter();
          this.uiActionService.triggerSilentRefresh();
        },
        error: () => { this.deletingRepayment = false; this.toast('Failed to delete repayment', 'error'); }
      });
    }
  }

  // ── LenDen Statement Import ──

  openImportModal(): void {
    this.showImportModal = true;
    this.importParseResult = null;
    this.importError = '';
    this.importSelectedFile = null;
  }

  closeImportModal(): void {
    this.showImportModal = false;
    this.importParseResult = null;
    this.importError = '';
    this.importSelectedFile = null;
    this.quickAddLoanWarning = null;
  }

  onImportFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] || null;
    this.importParseResult = null;
    if (file && !file.name.toLowerCase().endsWith('.xlsx')) {
      this.importSelectedFile = null;
      this.importError = 'Invalid file format. Please select a .xlsx file.';
      input.value = '';
    } else {
      this.importSelectedFile = file;
      this.importError = '';
    }
  }

  parseStatement(): void {
    if (!this.importSelectedFile) return;
    this.importParsing = true;
    this.importError = '';
    this.importParseResult = null;
    this.investmentService.parseLendenStatement(this.importSelectedFile).subscribe({
      next: (result) => {
        // Merge status_change warnings into suggested rows
        result.warnings.forEach(w => {
          if (w.type === 'status_change') {
            const row = result.suggested.find(s => s.loan_id === w.loan_id);
            if (row) {
              row.new_status = w.new_status;
              row.old_status = w.old_status;
            }
          }
        });
        this.importParseResult = result;
        this.importParsing = false;
      },
      error: (e) => {
        this.importError = e.error?.error || 'Failed to parse statement';
        this.importParsing = false;
      }
    });
  }

  get importUnmatchedWarnings(): LendenStatementWarning[] {
    return (this.importParseResult?.warnings || []).filter(w => w.type === 'unmatched');
  }

  get importSelectedRows(): LendenStatementRow[] {
    return (this.importParseResult?.suggested || []).filter(r => r.selected);
  }

  get entriesMissingLoanId(): number {
    return this.allEntries.filter(e => !e.loan_id?.trim()).length;
  }

  toggleAllImportRows(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.importParseResult?.suggested.forEach(r => r.selected = checked);
  }

  submitImport(): void {
    const rows = this.importSelectedRows;
    if (!rows.length) return;
    this.importSubmitting = true;

    const payload = rows.map(r => ({
      loan_id:          r.loan_id,
      lending_id:       r.lending_id,
      platform:         r.platform,
      entry_id:         r.entry_id,
      date:             r.date,
      delta_principal:  r.delta_principal,
      delta_interest:   r.delta_interest,
      delta_platform_fee: r.delta_platform_fee,
      remarks:          r.remarks,
      to_date:          this.importParseResult?.to_date || '',
      new_status:       r.new_status || null,
    }));

    this.investmentService.importLendenStatement(payload).subscribe({
      next: (resp) => {
        this.importSubmitting = false;
        const allResults = (resp.results || []);
        const failures = allResults.filter((r: any) => !r.success);
        const posted = allResults.filter((r: any) => r.success && !r.skipped).length;
        if (failures.length === 0) {
          this.toast(`Successfully posted ${posted} repayment(s)`, 'success');
          this.closeImportModal();
          this.loadData();
          this.uiActionService.triggerSilentRefresh();
        } else {
          const failedIds = failures.map((f: any) => f.loan_id).join(', ');
          this.toast(`${posted} posted, ${failures.length} failed: ${failedIds}`, 'error');
        }
      },
      error: (e) => {
        this.importSubmitting = false;
        this.toast(e.error?.error || 'Import failed', 'error');
      }
    });
  }

  // ── Quick Add Loan from Import Warning ──

  openQuickAddLoan(w: LendenStatementWarning): void {
    this.quickAddLoanWarning = w;
    this.quickAddForm = this.emptyForm();
    this.quickAddForm.loan_id = w.loan_id;
    this.quickAddForm.lending_id = this.generateLendingId();
    this.quickAddForm.platform = 'LenDen';
    if (w.disbursement_date) this.quickAddForm.date = w.disbursement_date;
    if (w.disbursed_amount)  this.quickAddForm.amount = w.disbursed_amount;
  }

  cancelQuickAdd(): void {
    this.quickAddLoanWarning = null;
  }

  onQuickAddDateOrTenureChange(): void {
    if (this.quickAddForm.date && this.quickAddForm.tenure) {
      this.quickAddForm.maturity_date = this._getInstallmentDate(this.quickAddForm, this.quickAddForm.tenure).toISOString().split('T')[0];
    } else {
      this.quickAddForm.maturity_date = '';
    }
  }

  submitQuickAdd(): void {
    if (!this.quickAddForm.name?.trim())                              { this.toast('Name is required', 'error'); return; }
    if (!this.quickAddForm.amount || this.quickAddForm.amount <= 0)  { this.toast('Amount is required', 'error'); return; }
    if (!this.quickAddForm.tenure || this.quickAddForm.tenure <= 0)  { this.toast('Tenure is required', 'error'); return; }
    if (this.quickAddForm.loan_id) this.quickAddForm.loan_id = this.quickAddForm.loan_id.trim().toUpperCase();
    this.onQuickAddDateOrTenureChange();
    this.quickAddSubmitting = true;
    this.investmentService.addP2P(this.quickAddForm).subscribe({
      next: (res) => {
        this.allEntries.push({ ...this.quickAddForm, id: res.id });
        this.quickAddSubmitting = false;
        this.quickAddLoanWarning = null;
        this.toast(`Loan ${this.quickAddForm.loan_id} added`, 'success');
        this.uiActionService.triggerSilentRefresh();
        // Re-parse the statement so the newly added entry gets matched
        if (this.importSelectedFile) this.parseStatement();
      },
      error: () => { this.quickAddSubmitting = false; this.toast('Failed to add loan', 'error'); }
    });
  }

  // ── Order Report Bulk Loan Import ──

  openOrderReportModal(): void {
    this.showOrderReportModal = true;
    this.orderReportParseResult = null;
    this.orderReportError = '';
    this.orderReportFile = null;
  }

  closeOrderReportModal(): void {
    this.showOrderReportModal = false;
    this.orderReportParseResult = null;
    this.orderReportError = '';
    this.orderReportFile = null;
  }

  onOrderReportFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] || null;
    this.orderReportParseResult = null;
    if (file && !file.name.toLowerCase().endsWith('.xlsx')) {
      this.orderReportFile = null;
      this.orderReportError = 'Invalid file format. Please select a .xlsx file.';
      input.value = '';
    } else {
      this.orderReportFile = file;
      this.orderReportError = '';
    }
  }

  parseOrderReport(): void {
    if (!this.orderReportFile) return;
    this.orderReportParsing = true;
    this.orderReportError = '';
    this.orderReportParseResult = null;
    this.investmentService.parseOrderReport(this.orderReportFile).subscribe({
      next: (result) => {
        this.orderReportParseResult = result;
        this.orderReportParsing = false;
      },
      error: (e) => {
        this.orderReportError = e.error?.error || 'Failed to parse file';
        this.orderReportParsing = false;
      }
    });
  }

  get orderReportSelectedRows(): OrderReportRow[] {
    return (this.orderReportParseResult?.rows || []).filter(r => r.selected);
  }

  get orderReportNewRows(): OrderReportRow[] {
    return (this.orderReportParseResult?.rows || []).filter(r => !r.already_exists);
  }

  toggleAllOrderReportRows(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.orderReportParseResult?.rows.forEach(r => { if (!r.already_exists) r.selected = checked; });
  }

  onOrderReportTenureChange(row: OrderReportRow): void {
    if (row.date && row.tenure) {
      const d = new Date(row.date);
      const baseOffset = d.getDate() <= 20 ? 1 : 2;
      const totalMonths = d.getMonth() + baseOffset + row.tenure - 1;
      row.maturity_date = new Date(d.getFullYear(), totalMonths, 5).toISOString().split('T')[0];
    }
  }

  submitOrderReport(): void {
    const rows = this.orderReportSelectedRows;
    if (!rows.length) return;
    const missing = rows.filter(r => !r.name?.trim());
    if (missing.length > 0) {
      this.toast(`Fill in the Name field for all selected rows (${missing.length} missing)`, 'error');
      return;
    }
    this.orderReportSubmitting = true;
    this.investmentService.bulkAddLoans(rows).subscribe({
      next: (resp) => {
        this.orderReportSubmitting = false;
        const results = resp.results || [];
        const added = results.filter((r: any) => r.success).length;
        const failed = results.filter((r: any) => !r.success).length;
        if (failed === 0) {
          this.toast(`${added} loan(s) added successfully`, 'success');
          this.closeOrderReportModal();
          this.loadData();
          this.uiActionService.triggerSilentRefresh();
        } else {
          this.toast(`${added} added, ${failed} failed`, 'error');
        }
      },
      error: (e) => {
        this.orderReportSubmitting = false;
        this.toast(e.error?.error || 'Bulk add failed', 'error');
      }
    });
  }

  toast(msg: string, type: string): void {    const t = { msg, type };
    this.toasts.push(t);
    setTimeout(() => { this.toasts = this.toasts.filter(x => x !== t); }, 3500);
  }

  checkAutoClose(lendingId: string): void {
    const entry = this.allEntries.find(e => e.lending_id === lendingId);
    if (!entry || entry.status === 'Closed' || entry.status === 'Defaulted') return;
    const received = this.getTotalRepaid(lendingId);
    if (received >= (entry.amount || 0)) {
      const reps = this.getRepayments(lendingId);
      const lastRepDate = reps.length > 0 ? reps[reps.length - 1].date : entry.maturity_date;
      const updated = { ...entry, status: 'Closed', maturity_date: lastRepDate };
      this.investmentService.updateP2P(entry.id!, updated).subscribe({
        next: () => {
          const idx = this.allEntries.findIndex(e => e.lending_id === lendingId);
          if (idx >= 0) this.allEntries[idx] = updated;
          this.applyFilter();
          this.toast('Lending auto-closed (fully repaid)', 'success');
        },
        error: () => {}
      });
    }
  }

  // ── Escrow ──

  get escrowBalance(): number {
    return this.escrowTransactions.reduce((sum, t) => {
      if (t.type === 'Deposit') return sum + (t.amount || 0);
      return sum - (t.amount || 0);
    }, 0);
  }

  /** True when pending principal exceeds escrow balance by more than 5% */
  get isEscrowUnderFunded(): boolean {
    return this.totalPending > this.escrowBalance * 1.05;
  }

  get escrowImpactPreview(): { netPendingLent: number; deficiency: number; needsDeposit: boolean } {
    const netPendingLent = this.pendingActiveLentAmount - this.totalReturns;
    const deficiency = netPendingLent - this.escrowBalance;
    return { netPendingLent, deficiency, needsDeposit: deficiency > 0 };
  }

  get escrowTransactionsSorted(): P2PEscrow[] {
    return [...this.escrowTransactions].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  get escrowTotalDeposits(): number {
    return this.escrowTransactions.filter(t => t.type === 'Deposit').reduce((s, t) => s + (t.amount || 0), 0);
  }

  get escrowTotalWithdrawals(): number {
    return this.escrowTransactions.filter(t => t.type === 'Withdrawal').reduce((s, t) => s + (t.amount || 0), 0);
  }

  openEscrowForm(): void {
    this.editingEscrowId = null;
    this.escrowForm = this.emptyEscrowForm();
    this.showEscrowForm = true;
  }

  openEditEscrowForm(txn: P2PEscrow): void {
    this.editingEscrowId = txn.id!;
    this.escrowForm = { ...txn };
    this.showEscrowForm = true;
  }

  saveEscrow(): void {
    this.submittingEscrow = true;
    if (this.editingEscrowId) {
      this.investmentService.updateP2PEscrow(this.editingEscrowId, this.escrowForm).subscribe({
        next: () => {
          const idx = this.escrowTransactions.findIndex(t => t.id === this.editingEscrowId!);
          if (idx >= 0) this.escrowTransactions[idx] = { ...this.escrowForm, id: this.editingEscrowId! };
          this.applyFilter();
          this.submittingEscrow = false; this.toast('Transaction updated', 'success'); this.showEscrowForm = false; this.editingEscrowId = null;
        },
        error: () => { this.submittingEscrow = false; this.toast('Failed to update', 'error'); }
      });
    } else {
      this.investmentService.addP2PEscrow(this.escrowForm).subscribe({
        next: (res) => {
          this.escrowTransactions.push({ ...this.escrowForm, id: res.id });
          this.applyFilter();
          this.submittingEscrow = false; this.toast('Transaction added', 'success'); this.showEscrowForm = false;
        },
        error: () => { this.submittingEscrow = false; this.toast('Failed to add', 'error'); }
      });
    }
  }

  deleteEscrow(id: number): void {
    if (!confirm('Delete this escrow transaction?')) return;
    this.deletingEscrow = true;
    this.investmentService.deleteP2PEscrow(id).subscribe({
      next: () => {
        this.escrowTransactions = this.escrowTransactions.filter(t => t.id !== id);
        this.applyFilter();
        this.deletingEscrow = false; this.toast('Transaction deleted', 'success');
      },
      error: () => { this.deletingEscrow = false; this.toast('Failed to delete', 'error'); }
    });
  }

  exportLendingsCsv(): void {
    this.csvExport.download('p2p_lendings.csv',
      ['Lending ID', 'Platform', 'Name', 'Date', 'Amount', 'Tenure (months)', 'Maturity Date', 'Status', 'Repaid', 'Pending', 'Interest Earned', 'Remarks'],
      this.entries.map(e => [
        e.lending_id, e.platform, e.name, e.date, e.amount, e.tenure, e.maturity_date, e.status,
        this.getTotalRepaid(e.lending_id),
        this.getPendingAmount(e),
        this.getTotalNetInterest(e.lending_id),
        e.remarks
      ])
    );
  }

  exportEscrowCsv(): void {
    this.csvExport.download('p2p_escrow.csv',
      ['Date', 'Type', 'Amount', 'Platform', 'Remarks'],
      this.escrowTransactionsSorted.map(t => [t.date, t.type, t.amount, t.platform, t.remarks])
    );
  }
}
