import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { InvestmentService } from '../../services/investment.service';
import { FixedDepositEntry } from '../../models/investment.model';

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
  selector: 'app-fixed-deposits',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './fixed-deposits.component.html',
  styleUrl: './fixed-deposits.component.scss'
})
export class FixedDepositsComponent implements OnInit {
  entries: FixedDepositEntry[] = [];
  allEntries: FixedDepositEntry[] = [];
  loading = true;
  showForm = false;
  editingId: number | null = null;
  searchQuery = '';
  sortColumn = '';
  sortDirection: 'asc' | 'desc' = 'asc';
  fyOptions = getFYOptions();
  toasts: { msg: string; type: string }[] = [];

  form: FixedDepositEntry = this.emptyForm();

  get bankNameSuggestions(): string[] {
    return [...new Set(this.allEntries.map(e => e.bank_name).filter(Boolean))];
  }

  constructor(private investmentService: InvestmentService) {}

  ngOnInit(): void { this.loadEntries(); }

  emptyForm(): FixedDepositEntry {
    return {
      year: getCurrentFY(),
      platform: '',
      bank_name: '',
      date: new Date().toISOString().split('T')[0],
      fd_value: null,
      interest: null,
      maturity_date: '',
      return_value: null,
      remarks: ''
    };
  }

  loadEntries(): void {
    this.loading = true;
    this.investmentService.getFixedDeposits().subscribe({
      next: (data) => { this.allEntries = data; this.applyFilter(); this.loading = false; },
      error: () => { this.toast('Failed to load entries', 'error'); this.loading = false; }
    });
  }

  applyFilter(): void {
    let filtered = this.allEntries;
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(e =>
        (e.bank_name || '').toLowerCase().includes(q) ||
        (e.platform || '').toLowerCase().includes(q) ||
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
  openEditForm(entry: FixedDepositEntry): void { this.form = { ...entry }; this.editingId = entry.id!; this.showForm = true; }
  cancelForm(): void { this.showForm = false; this.editingId = null; }

  saveEntry(): void {
    if (!this.form.bank_name?.trim()) { this.toast('Bank name is required', 'error'); return; }
    if (this.editingId) {
      this.investmentService.updateFixedDeposit(this.editingId, this.form).subscribe({
        next: () => { this.toast('Entry updated successfully', 'success'); this.showForm = false; this.editingId = null; this.loadEntries(); },
        error: () => this.toast('Failed to update entry', 'error')
      });
    } else {
      this.investmentService.addFixedDeposit(this.form).subscribe({
        next: (res) => { this.toast(res.upserted ? 'Existing entry updated (values added)' : 'Entry added successfully', 'success'); this.showForm = false; this.loadEntries(); },
        error: () => this.toast('Failed to add entry', 'error')
      });
    }
  }

  deleteEntry(id: number): void {
    if (confirm('Are you sure you want to delete this entry?')) {
      this.investmentService.deleteFixedDeposit(id).subscribe({
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
