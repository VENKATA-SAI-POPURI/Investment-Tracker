import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { InvestmentService } from '../../services/investment.service';
import { EquityEntry, ForexEntry } from '../../models/investment.model';

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
  selector: 'app-equity',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './equity.component.html',
  styleUrl: './equity.component.scss'
})
export class EquityComponent implements OnInit {
  allEntries: EquityEntry[] = [];
  entries: EquityEntry[] = [];
  forexEntries: ForexEntry[] = [];
  loading = true;
  showForm = false;
  editingId: number | null = null;
  message = '';
  messageType: 'success' | 'error' = 'success';
  showAll = false;
  searchQuery = '';
  sortColumn = '';
  sortDirection: 'asc' | 'desc' = 'asc';
  fyOptions = getFYOptions();
  toasts: { msg: string; type: string }[] = [];
  sectors = [
    'Aerospace & Defense', 'Agricultural Food & other Products', 'Agricultural, Commercial & Construction Vehicles',
    'Auto Components', 'Automobiles', 'Banks', 'Beverages', 'Capital Markets', 'Cement & Cement Products',
    'Chemicals & Petrochemicals', 'Cigarettes & Tobacco Products', 'Commercial Services & Supplies', 'Construction',
    'Consumable Fuels', 'Consumer Durables', 'Diversified', 'Diversified FMCG', 'Diversified Metals',
    'Electrical Equipment', 'Engineering Services', 'Entertainment', 'Ferrous Metals', 'Fertilizers & Agrochemicals',
    'Finance', 'Financial Technology (Fintech)', 'Food Products', 'Gas', 'Healthcare Equipment & Supplies',
    'Healthcare Services', 'Household Products', 'Industrial Manufacturing', 'Industrial Products', 'Insurance',
    'IT - Hardware', 'IT - Services', 'IT - Software', 'Leisure Services', 'Media', 'Metals & Minerals Trading',
    'Minerals & Mining', 'Non - Ferrous Metals', 'Oil', 'Other Construction Materials', 'Other Consumer Services',
    'Other Utilities', 'Paper, Forest & Jute Products', 'Personal Products', 'Petroleum Products',
    'Pharmaceuticals & Biotechnology', 'Power', 'Printing & Publication', 'Realty', 'Retailing',
    'Telecom - Equipment & Accessories', 'Telecom - Services', 'Textiles & Apparels', 'Transport Infrastructure',
    'Transport Services'
  ];

  form: EquityEntry = this.emptyForm();

  get nameSuggestions(): string[] {
    return [...new Set(this.allEntries.map(e => e.name).filter(Boolean))];
  }

  constructor(private investmentService: InvestmentService) {}

  ngOnInit(): void {
    this.loadForexData();
    this.loadEntries();
  }

  loadForexData(): void {
    this.investmentService.getForex().subscribe({
      next: (data) => this.forexEntries = data,
      error: () => {}
    });
  }

  getAvgRate(tradeDate: string): number | null {
    const deposits = this.forexEntries
      .filter(e => e.type === 'Deposit' && (e.rate || 0) > 0 && e.date <= tradeDate)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3);
    if (deposits.length === 0) return null;
    return deposits.reduce((s, e) => s + (e.rate || 0), 0) / deposits.length;
  }

  emptyForm(): EquityEntry {
    return {
      year: getCurrentFY(),
      market: '',
      market_cap: '',
      sector: '',
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
    this.investmentService.getEquity().subscribe({
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
    if (!this.showAll) {
      filtered = filtered.filter(e => (e.buy_quantity || 0) > (e.sell_quantity || 0));
    }
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.sector || '').toLowerCase().includes(q) ||
        (e.market || '').toLowerCase().includes(q) ||
        (e.year || '').toLowerCase().includes(q)
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

  toggleShowAll(): void {
    this.showAll = !this.showAll;
    this.applyFilter();
  }

  onSearch(): void {
    this.applyFilter();
  }

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

  openEditForm(entry: EquityEntry): void {
    this.form = { ...entry };
    this.editingId = entry.id!;
    this.showForm = true;
  }

  cancelForm(): void {
    this.showForm = false;
    this.editingId = null;
  }

  onBuySellChange(): void {
    if (this.form.buy_sell === 'Buy') {
      this.form.sell_quantity = null;
      this.form.sell_value = null;
    } else {
      this.form.buy_quantity = null;
      this.form.buy_value = null;
    }
  }

  async saveEntry(): Promise<void> {
    if (!this.form.name?.trim()) {
      this.toast('Name is required', 'error');
      return;
    }
    if (this.form.buy_sell === 'Buy' && (!this.form.buy_quantity || this.form.buy_quantity <= 0)) {
      this.toast('Buy quantity must be greater than 0', 'error');
      return;
    }
    if (this.form.buy_sell === 'Sell' && (!this.form.sell_quantity || this.form.sell_quantity <= 0)) {
      this.toast('Sell quantity must be greater than 0', 'error');
      return;
    }

    // For USA entries, fetch fresh forex data and convert USD values to INR
    const formToSave = { ...this.form };
    if (formToSave.market === 'USA') {
      try {
        this.forexEntries = await firstValueFrom(this.investmentService.getForex());
      } catch {
        this.toast('Failed to fetch forex data', 'error');
        return;
      }
      const rate = this.getAvgRate(formToSave.date);
      if (rate === null) {
        this.toast('No forex deposit rates found on or before this date. Please add a forex entry first.', 'error');
        return;
      }
      if (formToSave.buy_value) {
        formToSave.buy_value = Math.round(formToSave.buy_value * rate * 100) / 100;
      }
      if (formToSave.sell_value) {
        formToSave.sell_value = Math.round(formToSave.sell_value * rate * 100) / 100;
      }
    }

    if (this.editingId) {
      this.investmentService.updateEquity(this.editingId, formToSave).subscribe({
        next: () => {
          this.toast('Entry updated successfully', 'success');
          this.showForm = false;
          this.editingId = null;
          this.loadEntries();
        },
        error: () => this.toast('Failed to update entry', 'error')
      });
    } else {
      this.investmentService.addEquity(formToSave).subscribe({
        next: (res) => {
          const msg = res.upserted ? 'Existing entry updated (values added)' : 'Entry added successfully';
          this.toast(msg, 'success');
          this.showForm = false;
          this.loadEntries();
        },
        error: () => this.toast('Failed to add entry', 'error')
      });
    }
  }

  deleteEntry(id: number): void {
    if (confirm('Are you sure you want to delete this entry?')) {
      this.investmentService.deleteEquity(id).subscribe({
        next: () => {
          this.toast('Entry deleted successfully', 'success');
          this.loadEntries();
        },
        error: () => this.toast('Failed to delete entry', 'error')
      });
    }
  }

  toast(msg: string, type: string): void {
    const t = { msg, type };
    this.toasts.push(t);
    setTimeout(() => {
      this.toasts = this.toasts.filter(x => x !== t);
    }, 3500);
  }

  showMessage(msg: string, type: 'success' | 'error'): void {
    this.message = msg;
    this.messageType = type;
    setTimeout(() => this.message = '', 3000);
  }
}
