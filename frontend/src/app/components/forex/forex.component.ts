import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { InvestmentService } from '../../services/investment.service';
import { UiActionService } from '../../services/ui-action.service';
import { CsvExportService } from '../../services/csv-export.service';
import { ForexEntry, EquityEntry } from '../../models/investment.model';

@Component({
  selector: 'app-forex',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './forex.component.html',
  styleUrl: './forex.component.scss'
})
export class ForexComponent implements OnInit, OnDestroy {
  allEntries: ForexEntry[] = [];
  entries: ForexEntry[] = [];
  equityData: EquityEntry[] = [];
  loading = true;
  showForm = false;
  submitting = false;
  deleting = false;
  editingId: number | null = null;
  searchQuery = '';
  sortColumn = 'date';
  sortDirection: 'asc' | 'desc' = 'desc';
  toasts: { msg: string; type: string }[] = [];

  form: ForexEntry = this.emptyForm();

  private addSub?: Subscription;

  constructor(private investmentService: InvestmentService, private uiActionService: UiActionService, private csvExport: CsvExportService) {}

  ngOnInit(): void {
    this.addSub = this.uiActionService.addEntry.subscribe(page => { if (page === 'forex') this.openAddForm(); });
    this.addSub.add(this.uiActionService.refresh.subscribe(() => { this.uiActionService.beginRefresh(); this.loadEntries(() => this.uiActionService.endRefresh()); }));
    this.loadEntries();
    this.investmentService.getEquity().subscribe({
      next: (data) => this.equityData = data,
      error: () => {}
    });
  }

  ngOnDestroy(): void { this.addSub?.unsubscribe(); }

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
    const usaEquity = this.equityData.filter(e => e.market === 'USA');
    const totalBuyUSD = usaEquity.filter(e => e.buy_sell === 'Buy').reduce((s, e) => s + (e.value_usd || 0), 0);
    const totalSellUSD = usaEquity.filter(e => e.buy_sell === 'Sell').reduce((s, e) => s + (e.value_usd || 0), 0);
    return Math.round((totalBuyUSD - totalSellUSD) * 100) / 100;
  }

  get indiaInvestedINR(): number {
    const indiaEquity = this.equityData.filter(e => e.market !== 'USA');
    const totalBuy = indiaEquity.filter(e => e.buy_sell === 'Buy').reduce((s, e) => s + (e.value || 0), 0);
    const totalSell = indiaEquity.filter(e => e.buy_sell === 'Sell').reduce((s, e) => s + (e.value || 0), 0);
    return Math.round((totalBuy - totalSell) * 100) / 100;
  }

  get usaInvestedINR(): number {
    return Math.round(this.totalInvestedUSD * this.avgDepositRateNum * 100) / 100;
  }

  get totalPortfolioINR(): number {
    return this.indiaInvestedINR + this.usaInvestedINR;
  }

  get indiaPct(): number {
    const total = this.totalPortfolioINR;
    if (total <= 0) return 0;
    return Math.round((this.indiaInvestedINR / total) * 100);
  }

  get usaPct(): number {
    return 100 - this.indiaPct;
  }

  get totalSalesUSD(): number {
    const usaEquity = this.equityData.filter(e => e.market === 'USA' && e.buy_sell === 'Sell');
    return Math.round(usaEquity.reduce((s, e) => s + (e.value_usd || 0), 0) * 100) / 100;
  }

  get avgDepositRateNum(): number {
    const totalUSD = this.totalDepositsUSD;
    if (totalUSD <= 0) return 0;
    return this.totalDepositsINR / totalUSD;
  }

  get avgDepositRate(): string {
    const rate = this.avgDepositRateNum;
    if (rate <= 0) return '-';
    return rate.toFixed(4);
  }

  get avgWithdrawalRate(): string {
    const rate = this.avgWithdrawalRateNum;
    if (rate <= 0) return '-';
    return rate.toFixed(4);
  }

  private get avgWithdrawalRateNum(): number {
    const totalUSD = this.totalWithdrawalsUSD;
    if (totalUSD <= 0) return 0;
    return this.totalWithdrawalsINR / totalUSD;
  }

  get latestRateNum(): number {
    const entries = this.allEntries.filter(e => (e.rate || 0) > 0);
    if (entries.length === 0) return 0;
    const latest = entries.reduce((a, b) => (a.date >= b.date ? a : b));
    return latest.rate || 0;
  }

  // Positive = avg deposit was more expensive than latest (bad for deposits)
  get depositRateDiff(): number {
    return this.avgDepositRateNum - this.latestRateNum;
  }

  // Positive = avg withdrawal was better than latest (good for withdrawals)
  get withdrawalRateDiff(): number {
    return this.avgWithdrawalRateNum - this.latestRateNum;
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

  loadEntries(onComplete?: () => void): void {
    this.loading = true;
    this.investmentService.getForex().subscribe({
      next: (data) => {
        this.allEntries = data;
        this.applyFilter();
        this.loading = false;
        onComplete?.();
      },
      error: () => {
        this.toast('Failed to load entries', 'error');
        this.loading = false;
        onComplete?.();
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
    this.submitting = true;
    if (this.editingId) {
      this.investmentService.updateForex(this.editingId, this.form).subscribe({
        next: () => {
          const idx = this.allEntries.findIndex(e => e.id === this.editingId!);
          if (idx >= 0) this.allEntries[idx] = { ...this.form, id: this.editingId! };
          this.applyFilter();
          this.submitting = false;
          this.toast('Entry updated', 'success');
          this.showForm = false;
          this.editingId = null;
        },
        error: () => { this.submitting = false; this.toast('Failed to update', 'error'); }
      });
    } else {
      this.investmentService.addForex(this.form).subscribe({
        next: (res) => {
          this.allEntries.push({ ...this.form, id: res.id });
          this.applyFilter();
          this.submitting = false;
          this.toast('Entry added', 'success');
          this.showForm = false;
        },
        error: () => { this.submitting = false; this.toast('Failed to add', 'error'); }
      });
    }
  }

  deleteEntry(id: number): void {
    if (!confirm('Delete this entry?')) return;
    this.deleting = true;
    this.investmentService.deleteForex(id).subscribe({
      next: () => {
        this.allEntries = this.allEntries.filter(e => e.id !== id);
        this.applyFilter();
        this.deleting = false;
        this.toast('Entry deleted', 'success');
      },
      error: () => { this.deleting = false; this.toast('Failed to delete', 'error'); }
    });
  }

  toast(msg: string, type: string): void {
    this.toasts.push({ msg, type });
    setTimeout(() => this.toasts.shift(), 3000);
  }

  exportCsv(): void {
    this.csvExport.download('forex.csv',
      ['Date', 'Type', 'INR Amount', 'USD Amount', 'Rate', 'Remarks'],
      this.entries.map(e => [e.date, e.type, e.inr_amount, e.usd_amount, e.rate, e.remarks])
    );
  }
}
