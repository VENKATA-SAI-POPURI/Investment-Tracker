import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { InvestmentService } from '../../services/investment.service';
import { EquityEntry, ForexEntry } from '../../models/investment.model';


interface HoldingRow {
  name: string;
  market: string;
  market_cap: string;
  sector: string;
  totalBuyQty: number;
  totalSellQty: number;
  totalBuyValue: number;
  totalSellValue: number;
  totalBuyValueUsd: number;
  totalSellValueUsd: number;
  netQty: number;
  netValue: number;
  netValueUsd: number;
  costPerUnit: number;
  costPerUnitUsd: number;
  // FIFO holding-period buckets (quantity)
  lt6m: number;   // < 6 months
  lt1y: number;   // 6 months – 1 year
  lt2y: number;   // 1 year – 2 years
  gt2y: number;   // > 2 years
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
  submitting = false;
  deleting = false;
  editingId: number | null = null;
  message = '';
  messageType: 'success' | 'error' = 'success';
  showAll = false;
  searchQuery = '';
  sortColumn = '';
  sortDirection: 'asc' | 'desc' = 'asc';
  expandedName: string | null = null;
  viewMode: 'transactions' | 'holdings' = 'holdings';
  selectedFYs: string[] = [];
  fyDropdownOpen = false;
  toasts: { msg: string; type: string }[] = [];
  sectors = [
    'Communication Services',
    'Consumer Discretionary',
    'Consumer Staples',
    'Energy',
    'Financials',
    'Health Care',
    'Industrials',
    'Information Technology',
    'Materials',
    'Real Estate',
    'Utilities',
    'Others'
  ];

  form: EquityEntry = this.emptyForm();

  get nameSuggestions(): string[] {
    return [...new Set(this.allEntries.map(e => e.name).filter(Boolean))];
  }

  get indiaNetINR(): number {
    return Math.round(this.holdings.filter(h => h.market === 'India').reduce((s, h) => s + h.netValue, 0) * 100) / 100;
  }

  get usaNetINR(): number {
    return Math.round(this.holdings.filter(h => h.market === 'USA').reduce((s, h) => s + h.netValue, 0) * 100) / 100;
  }

  get usaNetUSD(): number {
    return Math.round(this.holdings.filter(h => h.market === 'USA').reduce((s, h) => s + h.netValueUsd, 0) * 100) / 100;
  }

  get latestForexRate(): number {
    const entries = this.forexEntries.filter(e => (e.rate || 0) > 0);
    if (entries.length === 0) return 0;
    return entries.reduce((a, b) => (a.date >= b.date ? a : b)).rate || 0;
  }

  get totalNetINR(): number {
    return this.indiaNetINR + this.usaNetINR;
  }

  get indiaPct(): number {
    if (this.totalNetINR <= 0) return 0;
    return (this.indiaNetINR / this.totalNetINR) * 100;
  }

  get usaPct(): number {
    if (this.totalNetINR <= 0) return 0;
    return (this.usaNetINR / this.totalNetINR) * 100;
  }

  get availableFYs(): string[] {
    return [...new Set(this.allEntries.map(e => this.dateToFY(e.date)).filter(Boolean))].sort();
  }

  get taxTermSummary(): { stcg: number; ltcg: number; total: number; stcgPct: number; ltcgPct: number } {
    // Equity: STCG < 1Y, LTCG >= 1Y (FIFO-based, proportional value)
    let stcg = 0, ltcg = 0;
    for (const h of this.holdings) {
      const totalBkt = h.lt6m + h.lt1y + h.lt2y + h.gt2y;
      if (totalBkt <= 0 || h.netValue <= 0) continue;
      const stcgFrac = (h.lt6m + h.lt1y) / totalBkt;
      stcg += h.netValue * stcgFrac;
      ltcg += h.netValue * (1 - stcgFrac);
    }
    const total = stcg + ltcg;
    return { stcg: Math.round(stcg), ltcg: Math.round(ltcg), total: Math.round(total),
      stcgPct: total > 0 ? Math.round(stcg / total * 100) : 0,
      ltcgPct: total > 0 ? Math.round(ltcg / total * 100) : 0 };
  }

  get uniqueStocksCount(): number {
    // Stocks where net quantity (buys - sells) > 0
    const map = new Map<string, number>();
    for (const e of this.entries) {
      const sign = e.buy_sell === 'Buy' ? 1 : -1;
      map.set(e.name, (map.get(e.name) || 0) + sign * (e.quantity || 0));
    }
    return [...map.values()].filter(q => q > 0).length;
  }

  get holdings(): HoldingRow[] {
    const today = new Date();
    const daysSince = (d: string) =>
      Math.floor((today.getTime() - new Date(d).getTime()) / 86400000);

    // 1. FIFO holding-period buckets + FIFO net cost from ALL entries (unfiltered)
    const buyLots = new Map<string, { date: string; qty: number; value: number; valueUsd: number }[]>();
    const totalSells = new Map<string, number>();
    for (const e of this.allEntries) {
      if (e.buy_sell === 'Buy') {
        if (!buyLots.has(e.name)) buyLots.set(e.name, []);
        buyLots.get(e.name)!.push({ date: e.date, qty: e.quantity || 0, value: e.value || 0, valueUsd: e.value_usd || 0 });
      } else {
        totalSells.set(e.name, (totalSells.get(e.name) || 0) + (e.quantity || 0));
      }
    }
    const buckets = new Map<string, { lt6m: number; lt1y: number; lt2y: number; gt2y: number }>();
    const fifoNetValue = new Map<string, { inr: number; usd: number }>();
    for (const [name, lots] of buyLots) {
      const sorted = [...lots].sort((a, b) => a.date.localeCompare(b.date));
      let sells = totalSells.get(name) || 0;
      const b = { lt6m: 0, lt1y: 0, lt2y: 0, gt2y: 0 };
      let netInr = 0, netUsd = 0;
      for (const lot of sorted) {
        let rem = lot.qty;
        if (sells >= rem) { sells -= rem; continue; }
        rem -= sells; sells = 0;
        const cpuInr = lot.qty > 0 ? lot.value / lot.qty : 0;
        const cpuUsd = lot.qty > 0 ? lot.valueUsd / lot.qty : 0;
        netInr += rem * cpuInr;
        netUsd += rem * cpuUsd;
        const days = daysSince(lot.date);
        if      (days < 183) b.lt6m += rem;
        else if (days < 365) b.lt1y += rem;
        else if (days < 730) b.lt2y += rem;
        else                 b.gt2y += rem;
      }
      buckets.set(name, b);
      fifoNetValue.set(name, { inr: Math.round(netInr * 100) / 100, usd: Math.round(netUsd * 100) / 100 });
    }

    // 2. Aggregate value/qty from filtered entries
    const map = new Map<string, HoldingRow>();
    for (const e of this.entries) {
      if (!map.has(e.name)) {
        const bkt = buckets.get(e.name) || { lt6m: 0, lt1y: 0, lt2y: 0, gt2y: 0 };
        map.set(e.name, {
          name: e.name, market: e.market, market_cap: e.market_cap, sector: e.sector,
          totalBuyQty: 0, totalSellQty: 0, totalBuyValue: 0, totalSellValue: 0,
          totalBuyValueUsd: 0, totalSellValueUsd: 0,
          netQty: 0, netValue: 0, netValueUsd: 0, costPerUnit: 0, costPerUnitUsd: 0,
          lt6m: bkt.lt6m, lt1y: bkt.lt1y, lt2y: bkt.lt2y, gt2y: bkt.gt2y,
        });
      }
      const h = map.get(e.name)!;
      if (e.buy_sell === 'Buy') {
        h.totalBuyQty += (e.quantity || 0);
        h.totalBuyValue += (e.value || 0);
        h.totalBuyValueUsd += (e.value_usd || 0);
      } else {
        h.totalSellQty += (e.quantity || 0);
        h.totalSellValue += (e.value || 0);
        h.totalSellValueUsd += (e.value_usd || 0);
      }
    }
    return Array.from(map.values()).map(h => {
      const fifo = fifoNetValue.get(h.name) || { inr: 0, usd: 0 };
      return {
        ...h,
        netQty: h.totalBuyQty - h.totalSellQty,
        netValue: fifo.inr,
        netValueUsd: fifo.usd,
        costPerUnit: h.totalBuyQty > 0 ? Math.round((h.totalBuyValue / h.totalBuyQty) * 100) / 100 : 0,
        costPerUnitUsd: h.totalBuyQty > 0 ? Math.round((h.totalBuyValueUsd / h.totalBuyQty) * 100) / 100 : 0,
      };
    }).sort((a, b) => b.netValue - a.netValue);
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
      .filter(e => e.type === 'Deposit' && e.date <= tradeDate);
    if (deposits.length === 0) return null;
    const totalINR = deposits.reduce((s, e) => s + (e.inr_amount || 0), 0);
    const totalUSD = deposits.reduce((s, e) => s + (e.usd_amount || 0), 0);
    if (totalUSD <= 0) return null;
    return totalINR / totalUSD;
  }

  emptyForm(): EquityEntry {
    return {
      market: '',
      market_cap: '',
      sector: '',
      name: '',
      date: new Date().toISOString().split('T')[0],
      quantity: null,
      value: null,
      value_usd: null,
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
      // Only show stocks with net qty > 0 (still holding)
      const netQtyMap = new Map<string, number>();
      for (const e of this.allEntries) {
        const sign = e.buy_sell === 'Buy' ? 1 : -1;
        netQtyMap.set(e.name, (netQtyMap.get(e.name) || 0) + sign * (e.quantity || 0));
      }
      const activeNames = new Set([...netQtyMap.entries()].filter(([, q]) => q > 0).map(([n]) => n));
      filtered = filtered.filter(e => activeNames.has(e.name));
    }
    if (this.selectedFYs.length) {
      filtered = filtered.filter(e => this.selectedFYs.includes(this.dateToFY(e.date)));
    }
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.sector || '').toLowerCase().includes(q) ||
        (e.market || '').toLowerCase().includes(q)
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

  get fyLabel(): string { return this.selectedFYs.length === 0 ? 'All' : this.selectedFYs.join(', '); }
  isFYSelected(fy: string): boolean { return this.selectedFYs.includes(fy); }
  toggleFY(fy: string): void {
    const i = this.selectedFYs.indexOf(fy);
    if (i >= 0) this.selectedFYs.splice(i, 1); else this.selectedFYs.push(fy);
    this.applyFilter();
  }
  clearFYFilter(): void { this.selectedFYs = []; this.applyFilter(); }

  costPerUnit(entry: EquityEntry): string {
    if ((entry.quantity || 0) <= 0) return '-';
    if (entry.market === 'USA' && (entry.value_usd || 0) > 0) {
      return '$' + (entry.value_usd! / entry.quantity!).toFixed(2);
    }
    if ((entry.value || 0) > 0) {
      return '\u20b9' + (entry.value! / entry.quantity!).toFixed(2);
    }
    return '-';
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

  toggleExpand(name: string): void {
    this.expandedName = this.expandedName === name ? null : name;
  }

  getTransactionsForStock(name: string): EquityEntry[] {
    return this.entries.filter(e => e.name === name).sort((a, b) => b.date.localeCompare(a.date));
  }

  onNameChange(): void {
    if (this.editingId) return;
    const match = this.allEntries.find(e => e.name?.toLowerCase() === this.form.name?.toLowerCase().trim());
    if (match) {
      this.form.market = match.market;
      this.form.market_cap = match.market_cap;
      this.form.sector = match.sector;
    }
  }

  get formHolding(): { netQty: number; netValue: number; costPerUnit: number; currency: string } | null {
    if (this.form.buy_sell !== 'Sell' || !this.form.name?.trim()) return null;
    const name = this.form.name.toLowerCase().trim();
    const stockEntries = this.allEntries.filter(e => e.name?.toLowerCase() === name);
    if (stockEntries.length === 0) return null;
    const buys = stockEntries.filter(e => e.buy_sell === 'Buy');
    const totalBuyQty = buys.reduce((s, e) => s + (e.quantity || 0), 0);
    const totalSellQty = stockEntries.filter(e => e.buy_sell === 'Sell').reduce((s, e) => s + (e.quantity || 0), 0);
    const netQty = totalBuyQty - totalSellQty;
    if (netQty <= 0) return null;
    const market = buys[0]?.market || '';
    if (market === 'USA') {
      const totalBuyValueUsd = buys.reduce((s, e) => s + (e.value_usd || 0), 0);
      const costPerUnit = totalBuyQty > 0 ? Math.round(totalBuyValueUsd / totalBuyQty * 100) / 100 : 0;
      return { netQty, netValue: Math.round(costPerUnit * netQty * 100) / 100, costPerUnit, currency: '$' };
    }
    const totalBuyValue = buys.reduce((s, e) => s + (e.value || 0), 0);
    const costPerUnit = totalBuyQty > 0 ? Math.round(totalBuyValue / totalBuyQty * 100) / 100 : 0;
    return { netQty, netValue: Math.round(costPerUnit * netQty * 100) / 100, costPerUnit, currency: '\u20b9' };
  }

  private dateToFY(dateStr: string): string {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const fy = month >= 4 ? year + 1 : year;
    return 'FY' + fy.toString().slice(-2);
  }

  async saveEntry(): Promise<void> {
    if (!this.form.name?.trim()) {
      this.toast('Name is required', 'error');
      return;
    }
    if (!this.form.quantity || this.form.quantity <= 0) {
      this.toast('Quantity must be greater than 0', 'error');
      return;
    }
    if (!this.form.value || this.form.value <= 0) {
      this.toast('Value must be greater than 0', 'error');
      return;
    }

    const formToSave = { ...this.form };
    if (formToSave.market === 'USA') {
      try {
        this.forexEntries = await firstValueFrom(this.investmentService.getForex());
      } catch {
        this.toast('Failed to fetch forex data', 'error');
        return;
      }
      const rate = this.latestForexRate;
      if (rate <= 0) {
        this.toast('No forex rates found. Please add a forex entry first.', 'error');
        return;
      }
      formToSave.value_usd = formToSave.value;           // save USD amount
      formToSave.value = Math.round(formToSave.value! * rate * 100) / 100; // convert to INR
    }

    this.submitting = true;
    if (this.editingId) {
      this.investmentService.updateEquity(this.editingId, formToSave).subscribe({
        next: () => {
          this.submitting = false;
          this.toast('Entry updated successfully', 'success');
          this.showForm = false;
          this.editingId = null;
          this.loadEntries();
        },
        error: () => { this.submitting = false; this.toast('Failed to update entry', 'error'); }
      });
    } else {
      this.investmentService.addEquity(formToSave).subscribe({
        next: () => {
          this.submitting = false;
          this.toast('Entry added successfully', 'success');
          this.showForm = false;
          this.loadEntries();
        },
        error: () => { this.submitting = false; this.toast('Failed to add entry', 'error'); }
      });
    }
  }

  deleteEntry(id: number): void {
    if (confirm('Are you sure you want to delete this entry?')) {
      this.deleting = true;
      this.investmentService.deleteEquity(id).subscribe({
        next: () => {
          this.deleting = false;
          this.toast('Entry deleted successfully', 'success');
          this.loadEntries();
        },
        error: () => { this.deleting = false; this.toast('Failed to delete entry', 'error'); }
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
