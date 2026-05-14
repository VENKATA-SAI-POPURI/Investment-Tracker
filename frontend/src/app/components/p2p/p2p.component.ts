import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { InvestmentService } from '../../services/investment.service';
import { P2PEntry, P2PRepayment } from '../../models/investment.model';

@Component({
  selector: 'app-p2p',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './p2p.component.html',
  styleUrl: './p2p.component.scss'
})
export class P2PComponent implements OnInit {
  entries: P2PEntry[] = [];
  allEntries: P2PEntry[] = [];
  repayments: P2PRepayment[] = [];
  loading = true;
  showForm = false;
  showRepaymentForm = false;
  editingId: number | null = null;
  editingRepaymentId: number | null = null;
  expandedLendingId: string | null = null;
  searchQuery = '';
  statusFilter: 'All' | 'Active' = 'Active';
  sortColumn = '';
  sortDirection: 'asc' | 'desc' = 'asc';
  toasts: { msg: string; type: string }[] = [];

  form: P2PEntry = this.emptyForm();
  repaymentForm: P2PRepayment = this.emptyRepaymentForm();

  constructor(private investmentService: InvestmentService) {}

  ngOnInit(): void { this.loadData(); }

  emptyForm(): P2PEntry {
    return {
      lending_id: '',
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
      amount: null,
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
    const d = new Date(this.form.date);
    d.setMonth(d.getMonth() + this.form.tenure);
    return d.toISOString().split('T')[0];
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

  // For a single repayment: principal = min(repayment, lent/tenure)
  getRepaymentPrincipal(repAmount: number, entry: P2PEntry): number {
    const pp = this.getPrincipalPerInstallment(entry);
    return Math.min(repAmount, pp);
  }

  // For a single repayment: interest = max(0, repayment - principal)
  getRepaymentInterest(repAmount: number, entry: P2PEntry): number {
    const pp = this.getPrincipalPerInstallment(entry);
    return Math.max(0, repAmount - pp);
  }

  // Received = sum of principal portions only
  getTotalRepaid(lendingId: string): number {
    const entry = this.allEntries.find(e => e.lending_id === lendingId);
    if (!entry) return 0;
    const pp = this.getPrincipalPerInstallment(entry);
    return this.getRepayments(lendingId).reduce((s, r) => s + Math.min(r.amount || 0, pp), 0);
  }

  // Total interest earned for a lending
  getTotalInterest(lendingId: string): number {
    const entry = this.allEntries.find(e => e.lending_id === lendingId);
    if (!entry) return 0;
    const pp = this.getPrincipalPerInstallment(entry);
    return this.getRepayments(lendingId).reduce((s, r) => s + Math.max(0, (r.amount || 0) - pp), 0);
  }

  getReturns(entry: P2PEntry): number | null {
    const interest = this.getTotalInterest(entry.lending_id);
    if (interest === 0 && entry.amount == null) return null;
    return interest;
  }

  getInterestRate(entry: P2PEntry): number | null {
    const received = this.getTotalRepaid(entry.lending_id);
    const interest = this.getTotalInterest(entry.lending_id);
    if (received === 0 || interest === 0) return null;
    return (interest / received) * 100;
  }

  getPendingAmount(entry: P2PEntry): number {
    return (entry.amount || 0) - this.getTotalRepaid(entry.lending_id);
  }

  getNextInstallmentDate(entry: P2PEntry): string {
    if (entry.status !== 'Active' || !entry.date || !entry.tenure) return '-';
    const reps = this.getRepayments(entry.lending_id);
    const repCount = reps.length;
    // Assume monthly installments starting 1 month after lending date
    const nextMonth = repCount + 1;
    if (nextMonth > entry.tenure) return '-';
    const d = new Date(entry.date);
    d.setMonth(d.getMonth() + nextMonth);
    return d.toISOString().split('T')[0];
  }

  // ── Summary getters ──

  get totalLent(): number {
    return this.allEntries.reduce((s, e) => s + (e.amount || 0), 0);
  }

  get totalRepaid(): number {
    // Sum of principal portions across all repayments
    return this.allEntries.reduce((s, e) => s + this.getTotalRepaid(e.lending_id), 0);
  }

  get totalReturns(): number {
    return this.allEntries.reduce((s, e) => s + this.getTotalInterest(e.lending_id), 0);
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
    return this.totalPending * (this.activeAvgInterestRateNum / 100);
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

  // ── Feature: Platform breakdown ──
  get platformBreakdown(): { platform: string; lent: number; active: number }[] {
    const map = new Map<string, { lent: number; active: number }>();
    this.allEntries.forEach(e => {
      const p = e.platform || 'Unknown';
      const existing = map.get(p) || { lent: 0, active: 0 };
      existing.lent += (e.amount || 0);
      if (e.status === 'Active') existing.active++;
      map.set(p, existing);
    });
    return Array.from(map.entries()).map(([platform, data]) => ({ platform, ...data }));
  }

  // ── Feature: This month's expected inflow ──
  get thisMonthInflow(): number {
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();
    return this.allEntries.filter(e => e.status === 'Active').reduce((sum, e) => {
      const nextDate = this.getNextInstallmentDate(e);
      if (nextDate === '-') return sum;
      const d = new Date(nextDate);
      if (d.getMonth() === thisMonth && d.getFullYear() === thisYear) {
        // Expected inflow = principal + interest per installment
        const pp = this.getPrincipalPerInstallment(e);
        const avgRate = this.getInterestRate(e);
        const interestPer = avgRate != null ? pp * (avgRate / 100) : 0;
        return sum + pp + interestPer;
      }
      return sum;
    }, 0);
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

  loadData(): void {
    this.loading = true;
    this.investmentService.getP2P().subscribe({
      next: (data) => {
        this.allEntries = data;
        this.investmentService.getP2PRepayments().subscribe({
          next: (rep) => { this.repayments = rep; this.applyFilter(); this.loading = false; },
          error: () => { this.repayments = []; this.applyFilter(); this.loading = false; }
        });
      },
      error: () => { this.toast('Failed to load entries', 'error'); this.loading = false; }
    });
  }

  applyFilter(): void {
    let filtered = this.allEntries;
    if (this.statusFilter === 'Active') {
      filtered = filtered.filter(e => e.status === 'Active');
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

  openEditForm(entry: P2PEntry): void {
    this.form = { ...entry };
    this.editingId = entry.id!;
    this.showForm = true;
  }

  cancelForm(): void { this.showForm = false; this.editingId = null; }

  saveEntry(): void {
    if (!this.form.platform?.trim()) { this.toast('Platform is required', 'error'); return; }
    if (!this.form.name?.trim()) { this.toast('Name is required', 'error'); return; }
    if (!this.form.amount || this.form.amount <= 0) { this.toast('Amount is required', 'error'); return; }
    if (!this.form.tenure || this.form.tenure <= 0) { this.toast('Tenure is required', 'error'); return; }

    this.form.maturity_date = this.computeMaturityDate();

    if (this.editingId) {
      this.investmentService.updateP2P(this.editingId, this.form).subscribe({
        next: () => { this.toast('Lending updated', 'success'); this.showForm = false; this.editingId = null; this.loadData(); },
        error: () => this.toast('Failed to update', 'error')
      });
    } else {
      this.investmentService.addP2P(this.form).subscribe({
        next: () => { this.toast('Lending added', 'success'); this.showForm = false; this.loadData(); },
        error: () => this.toast('Failed to add', 'error')
      });
    }
  }

  deleteEntry(id: number): void {
    if (confirm('Delete this lending and all its repayments?')) {
      this.investmentService.deleteP2P(id).subscribe({
        next: () => { this.toast('Lending deleted', 'success'); this.loadData(); },
        error: () => this.toast('Failed to delete', 'error')
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

  openEditRepaymentForm(rep: P2PRepayment): void {
    this.repaymentForm = { ...rep };
    this.editingRepaymentId = rep.id!;
    this.showRepaymentForm = true;
  }

  cancelRepaymentForm(): void { this.showRepaymentForm = false; this.editingRepaymentId = null; }

  saveRepayment(): void {
    if (!this.repaymentForm.amount || this.repaymentForm.amount <= 0) { this.toast('Repayment amount is required', 'error'); return; }

    if (this.editingRepaymentId) {
      this.investmentService.updateP2PRepayment(this.editingRepaymentId, this.repaymentForm).subscribe({
        next: () => { this.toast('Repayment updated', 'success'); this.showRepaymentForm = false; this.editingRepaymentId = null; this.loadData(); this.checkAutoClose(this.repaymentForm.lending_id); },
        error: () => this.toast('Failed to update repayment', 'error')
      });
    } else {
      this.investmentService.addP2PRepayment(this.repaymentForm).subscribe({
        next: () => { this.toast('Repayment recorded', 'success'); this.showRepaymentForm = false; this.loadData(); this.checkAutoClose(this.repaymentForm.lending_id); },
        error: () => this.toast('Failed to add repayment', 'error')
      });
    }
  }

  deleteRepayment(id: number): void {
    if (confirm('Delete this repayment entry?')) {
      this.investmentService.deleteP2PRepayment(id).subscribe({
        next: () => { this.toast('Repayment deleted', 'success'); this.loadData(); },
        error: () => this.toast('Failed to delete repayment', 'error')
      });
    }
  }

  toast(msg: string, type: string): void {
    const t = { msg, type };
    this.toasts.push(t);
    setTimeout(() => { this.toasts = this.toasts.filter(x => x !== t); }, 3500);
  }

  checkAutoClose(lendingId: string): void {
    // Wait for loadData to complete, then check
    setTimeout(() => {
      const entry = this.allEntries.find(e => e.lending_id === lendingId);
      if (!entry || entry.status === 'Closed' || entry.status === 'Defaulted') return;
      const received = this.getTotalRepaid(lendingId);
      if (received >= (entry.amount || 0)) {
        // Auto-close
        const updated = { ...entry, status: 'Closed' };
        this.investmentService.updateP2P(entry.id!, updated).subscribe({
          next: () => { this.toast('Lending auto-closed (fully repaid)', 'success'); this.loadData(); },
          error: () => {}
        });
      }
    }, 1000);
  }
}
