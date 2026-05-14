import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { InvestmentService } from '../../services/investment.service';
import { ForexEntry, EquityEntry } from '../../models/investment.model';

@Component({
  selector: 'app-forex',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './forex.component.html',
  styleUrl: './forex.component.scss'
})
export class ForexComponent implements OnInit {
  allEntries: ForexEntry[] = [];
  entries: ForexEntry[] = [];
  equityData: EquityEntry[] = [];
  loading = true;
  showForm = false;
  editingId: number | null = null;
  searchQuery = '';
  sortColumn = '';
  sortDirection: 'asc' | 'desc' = 'asc';
  toasts: { msg: string; type: string }[] = [];

  form: ForexEntry = this.emptyForm();

  constructor(private investmentService: InvestmentService) {}

  ngOnInit(): void {
    this.loadEntries();
    this.investmentService.getEquity().subscribe({
      next: (data) => this.equityData = data,
      error: () => {}
    });
  }

  emptyForm(): ForexEntry {
    return {
      date: new Date().toISOString().split('T')[0],
      type: 'Deposit',
      inr_amount: null,
      usd_amount: null,
      rate: null,
      remarks: ''
    };
  }

  get computedRate(): string {
    const inr = this.form.inr_amount || 0;
    const usd = this.form.usd_amount || 0;
    if (usd > 0) return (inr / usd).toFixed(4);
    return '-';
  }

  get totalDepositsINR(): number {
    return this.allEntries.filter(e => e.type === 'Deposit').reduce((s, e) => s + (e.inr_amount || 0), 0);
  }

  get totalDepositsUSD(): number {
    return this.allEntries.filter(e => e.type === 'Deposit').reduce((s, e) => s + (e.usd_amount || 0), 0);
  }

  get totalWithdrawalsINR(): number {
    return this.allEntries.filter(e => e.type === 'Withdrawal').reduce((s, e) => s + (e.inr_amount || 0), 0);
  }

  get totalWithdrawalsUSD(): number {
    return this.allEntries.filter(e => e.type === 'Withdrawal').reduce((s, e) => s + (e.usd_amount || 0), 0);
  }

  get walletBalanceUSD(): number {
    return this.totalDepositsUSD - this.totalInvestedUSD - this.totalWithdrawalsUSD;
  }

  get totalInvestedUSD(): number {
    // USD currently invested in US stocks (buy - sell value in USD terms)
    const usaEquity = this.equityData.filter(e => e.market === 'USA');
    const totalBuyINR = usaEquity.reduce((s, e) => s + (e.buy_value || 0), 0);
    const totalSellINR = usaEquity.reduce((s, e) => s + (e.sell_value || 0), 0);
    // Convert INR back to USD using avg deposit rate for approximation
    const avgRate = this.avgDepositRateNum;
    if (avgRate <= 0) return 0;
    return Math.round(((totalBuyINR - totalSellINR) / avgRate) * 100) / 100;
  }

  get totalSalesUSD(): number {
    const usaEquity = this.equityData.filter(e => e.market === 'USA');
    const totalSellINR = usaEquity.reduce((s, e) => s + (e.sell_value || 0), 0);
    const avgRate = this.avgDepositRateNum;
    if (avgRate <= 0) return 0;
    return Math.round((totalSellINR / avgRate) * 100) / 100;
  }

  get avgDepositRateNum(): number {
    const deposits = this.allEntries.filter(e => e.type === 'Deposit' && (e.rate || 0) > 0);
    if (deposits.length === 0) return 0;
    return deposits.reduce((s, e) => s + (e.rate || 0), 0) / deposits.length;
  }

  get avgDepositRate(): string {
    const deposits = this.allEntries.filter(e => e.type === 'Deposit' && (e.rate || 0) > 0);
    if (deposits.length === 0) return '-';
    const sum = deposits.reduce((s, e) => s + (e.rate || 0), 0);
    return (sum / deposits.length).toFixed(4);
  }

  get avgWithdrawalRate(): string {
    const withdrawals = this.allEntries.filter(e => e.type === 'Withdrawal' && (e.rate || 0) > 0);
    if (withdrawals.length === 0) return '-';
    const sum = withdrawals.reduce((s, e) => s + (e.rate || 0), 0);
    return (sum / withdrawals.length).toFixed(4);
  }

  private get avgWithdrawalRateNum(): number {
    const withdrawals = this.allEntries.filter(e => e.type === 'Withdrawal' && (e.rate || 0) > 0);
    if (withdrawals.length === 0) return 0;
    return withdrawals.reduce((s, e) => s + (e.rate || 0), 0) / withdrawals.length;
  }

  get forexWithdrawalImpact(): number {
    return this.totalWithdrawalsUSD * (this.avgWithdrawalRateNum - this.avgDepositRateNum);
  }

  get forexDepositImpact(): number {
    const deposits = this.allEntries.filter(e => e.type === 'Deposit' && (e.rate || 0) > 0);
    if (deposits.length === 0) return 0;
    const leastRate = Math.min(...deposits.map(e => e.rate!));
    return this.totalDepositsINR - (this.totalDepositsUSD * leastRate);
  }

  loadEntries(): void {
    this.loading = true;
    this.investmentService.getForex().subscribe({
      next: (data) => {
        this.allEntries = data;
        this.applyFilter();
        this.loading = false;
      },
      error: () => {
        this.toast('Failed to load entries', 'error');
        this.loading = false;
      }
    });
  }

  applyFilter(): void {
    let filtered = this.allEntries;
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(e =>
        (e.type || '').toLowerCase().includes(q) ||
        (e.remarks || '').toLowerCase().includes(q) ||
        (e.date || '').includes(q)
      );
    }
    if (this.sortColumn) {
      filtered = [...filtered].sort((a, b) => {
        const va = (a as any)[this.sortColumn];
        const vb = (b as any)[this.sortColumn];
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
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = column;
      this.sortDirection = 'asc';
    }
    this.applyFilter();
  }

  sortIcon(column: string): string {
    if (this.sortColumn !== column) return '↕';
    return this.sortDirection === 'asc' ? '↑' : '↓';
  }

  openAddForm(): void {
    this.form = this.emptyForm();
    this.editingId = null;
    this.showForm = true;
  }

  openEditForm(entry: ForexEntry): void {
    this.form = { ...entry };
    this.editingId = entry.id!;
    this.showForm = true;
  }

  cancelForm(): void {
    this.showForm = false;
    this.editingId = null;
  }

  saveEntry(): void {
    if (!this.form.inr_amount || this.form.inr_amount <= 0) {
      this.toast('INR amount is required', 'error');
      return;
    }
    if (!this.form.usd_amount || this.form.usd_amount <= 0) {
      this.toast('USD amount is required', 'error');
      return;
    }
    if (this.editingId) {
      this.investmentService.updateForex(this.editingId, this.form).subscribe({
        next: () => {
          this.toast('Entry updated', 'success');
          this.showForm = false;
          this.editingId = null;
          this.loadEntries();
        },
        error: () => this.toast('Failed to update', 'error')
      });
    } else {
      this.investmentService.addForex(this.form).subscribe({
        next: () => {
          this.toast('Entry added', 'success');
          this.showForm = false;
          this.loadEntries();
        },
        error: () => this.toast('Failed to add', 'error')
      });
    }
  }

  deleteEntry(id: number): void {
    if (!confirm('Delete this entry?')) return;
    this.investmentService.deleteForex(id).subscribe({
      next: () => {
        this.toast('Entry deleted', 'success');
        this.loadEntries();
      },
      error: () => this.toast('Failed to delete', 'error')
    });
  }

  toast(msg: string, type: string): void {
    this.toasts.push({ msg, type });
    setTimeout(() => this.toasts.shift(), 3000);
  }
}
