import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { InvestmentService } from '../../services/investment.service';
import { MutualFundEntry } from '../../models/investment.model';

function getCurrentFY(): string {
  const now = new Date();
  const yr = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
  return 'FY' + yr.toString().slice(-2);
}

function getFYOptions(): string[] {
  const opts: string[] = [];
  for (let y = 23; y <= 30; y++) opts.push('FY' + y);
  return opts;
}

@Component({
  selector: 'app-mutual-funds',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './mutual-funds.component.html',
  styleUrl: './mutual-funds.component.scss'
})
export class MutualFundsComponent implements OnInit {
  allEntries: MutualFundEntry[] = [];
  entries: MutualFundEntry[] = [];
  loading = true;
  showForm = false;
  editingId: number | null = null;
  showAll = false;
  searchQuery = '';
  sortColumn = '';
  sortDirection: 'asc' | 'desc' = 'asc';
  fyOptions = getFYOptions();
  toasts: { msg: string; type: string }[] = [];

  form: MutualFundEntry = this.emptyForm();

  get nameSuggestions(): string[] {
    return [...new Set(this.allEntries.map(e => e.name).filter(Boolean))];
  }

  constructor(private investmentService: InvestmentService) {}

  ngOnInit(): void { this.loadEntries(); }

  emptyForm(): MutualFundEntry {
    return {
      year: getCurrentFY(),
      category: '',
      fund_type: '',
      name: '',
      date: new Date().toISOString().split('T')[0],
      buy_quantity: null,
      buy_value: null,
      sell_quantity: null,
      sell_value: null,
      buy_sell: 'Buy',
      remarks: ''
    };
  }

  loadEntries(): void {
    this.loading = true;
    this.investmentService.getMutualFunds().subscribe({
      next: (data) => { this.allEntries = data; this.applyFilter(); this.loading = false; },
      error: () => { this.toast('Failed to load entries', 'error'); this.loading = false; }
    });
  }

  applyFilter(): void {
    let filtered = this.allEntries;
    if (!this.showAll) { filtered = filtered.filter(e => (e.buy_quantity || 0) > (e.sell_quantity || 0)); }
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.category || '').toLowerCase().includes(q) ||
        (e.fund_type || '').toLowerCase().includes(q) ||
        (e.year || '').toLowerCase().includes(q)
      );
    }
    if (this.sortColumn) {
      filtered = [...filtered].sort((a, b) => {
        const va = (a as any)[this.sortColumn]; const vb = (b as any)[this.sortColumn];
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

  toggleShowAll(): void { this.showAll = !this.showAll; this.applyFilter(); }
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

  openAddForm(): void { this.form = this.emptyForm(); this.editingId = null; this.showForm = true; }
  openEditForm(entry: MutualFundEntry): void { this.form = { ...entry }; this.editingId = entry.id!; this.showForm = true; }
  cancelForm(): void { this.showForm = false; this.editingId = null; }

  onBuySellChange(): void {
    if (this.form.buy_sell === 'Buy') { this.form.sell_quantity = null; this.form.sell_value = null; }
    else { this.form.buy_quantity = null; this.form.buy_value = null; }
  }

  saveEntry(): void {
    if (!this.form.name?.trim()) { this.toast('Name is required', 'error'); return; }
    if (this.form.buy_sell === 'Buy' && (!this.form.buy_quantity || this.form.buy_quantity <= 0)) { this.toast('Buy quantity must be > 0', 'error'); return; }
    if (this.form.buy_sell === 'Sell' && (!this.form.sell_quantity || this.form.sell_quantity <= 0)) { this.toast('Sell quantity must be > 0', 'error'); return; }
    if (this.editingId) {
      this.investmentService.updateMutualFund(this.editingId, this.form).subscribe({
        next: () => { this.toast('Entry updated successfully', 'success'); this.showForm = false; this.editingId = null; this.loadEntries(); },
        error: () => this.toast('Failed to update entry', 'error')
      });
    } else {
      this.investmentService.addMutualFund(this.form).subscribe({
        next: (res) => { this.toast(res.upserted ? 'Existing entry updated (values added)' : 'Entry added successfully', 'success'); this.showForm = false; this.loadEntries(); },
        error: () => this.toast('Failed to add entry', 'error')
      });
    }
  }

  deleteEntry(id: number): void {
    if (confirm('Are you sure you want to delete this entry?')) {
      this.investmentService.deleteMutualFund(id).subscribe({
        next: () => { this.toast('Entry deleted successfully', 'success'); this.loadEntries(); },
        error: () => this.toast('Failed to delete entry', 'error')
      });
    }
  }

  toast(msg: string, type: string): void {
    const t = { msg, type };
    this.toasts.push(t);
    setTimeout(() => { this.toasts = this.toasts.filter(x => x !== t); }, 3500);
  }
}
