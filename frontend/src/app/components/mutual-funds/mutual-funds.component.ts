import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { InvestmentService } from '../../services/investment.service';
import { UiActionService } from '../../services/ui-action.service';
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

interface HoldingRow {
  name: string; category: string; fund_type: string;
  totalBuyQty: number; totalSellQty: number;
  totalBuyValue: number; totalSellValue: number;
  netQty: number; netValue: number; effectiveNav: number;
  lt6m: number; lt1y: number; lt2y: number; lt3y: number; gt3y: number;
}

@Component({
  selector: 'app-mutual-funds',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './mutual-funds.component.html',
  styleUrl: './mutual-funds.component.scss'
})
export class MutualFundsComponent implements OnInit, OnDestroy {
  allEntries: MutualFundEntry[] = [];
  entries: MutualFundEntry[] = [];
  loading = true;
  showForm = false;
  submitting = false;
  deleting = false;
  editingId: number | null = null;
  showAll = false;
  searchQuery = '';
  sortColumn = 'date';
  sortDirection: 'asc' | 'desc' = 'desc';
  fyOptions = getFYOptions();
  toasts: { msg: string; type: string }[] = [];
  viewMode: 'transactions' | 'holdings' = 'holdings';
  selectedFYs: string[] = [];
  fyDropdownOpen = false;

  form: MutualFundEntry = this.emptyForm();

  get nameSuggestions(): string[] {
    return [...new Set(this.allEntries.map(e => e.name).filter(Boolean))];
  }

  get availableFYs(): string[] {
    return [...new Set(this.allEntries.map(e => e.year).filter(Boolean))].sort();
  }

  get taxTermSummary(): { stcg: number; ltcg: number; total: number; stcgPct: number; ltcgPct: number } {
    // Equity/ELSS funds: STCG < 1Y, LTCG >= 1Y. Debt/Hybrid: STCG < 3Y, LTCG >= 3Y.
    // Using 1Y as the primary threshold (applies to equity-oriented funds).
    let stcg = 0, ltcg = 0;
    for (const h of this.holdings) {
      const totalBkt = h.lt6m + h.lt1y + h.lt2y + h.lt3y + h.gt3y;
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

  get netInvested(): number {
    return this.entries.reduce((s, e) => s + (e.buy_value || 0) - (e.sell_value || 0), 0);
  }

  get uniqueFundsCount(): number {
    return new Set(
      this.entries.filter(e => (e.buy_quantity || 0) > (e.sell_quantity || 0)).map(e => e.name)
    ).size;
  }

  get categoryTotals(): { category: string; value: number; pct: number; color: string }[] {
    const colors: Record<string, string> = {
      'Equity': '#3b82f6', 'Debt': '#10b981', 'Hybrid': '#8b5cf6',
      'Index': '#f59e0b', 'ELSS': '#ef4444', 'Sectoral': '#f97316'
    };
    const totals: Record<string, number> = {};
    for (const e of this.entries) {
      const cat = e.category || 'Other';
      totals[cat] = (totals[cat] || 0) + (e.buy_value || 0) - (e.sell_value || 0);
    }
    const total = Object.values(totals).reduce((s, v) => s + v, 0);
    if (total <= 0) return [];
    return Object.entries(totals)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, val]) => ({
        category: cat, value: val,
        pct: Math.round((val / total) * 100),
        color: colors[cat] || '#94a3b8'
      }));
  }

  get holdings(): HoldingRow[] {
    const today = new Date();
    const daysSince = (d: string) =>
      Math.floor((today.getTime() - new Date(d).getTime()) / 86400000);

    // FIFO holding-period buckets
    const buyLots = new Map<string, { date: string; qty: number }[]>();
    const totalSells = new Map<string, number>();
    for (const e of this.allEntries) {
      const bq = e.buy_quantity || 0;
      const sq = e.sell_quantity || 0;
      if (bq > 0) {
        if (!buyLots.has(e.name)) buyLots.set(e.name, []);
        buyLots.get(e.name)!.push({ date: e.date || '', qty: bq });
      }
      if (sq > 0) totalSells.set(e.name, (totalSells.get(e.name) || 0) + sq);
    }
    const buckets = new Map<string, { lt6m: number; lt1y: number; lt2y: number; lt3y: number; gt3y: number }>();
    for (const [name, lots] of buyLots) {
      const sorted = [...lots].sort((a, b) => a.date.localeCompare(b.date));
      let sells = totalSells.get(name) || 0;
      const b = { lt6m: 0, lt1y: 0, lt2y: 0, lt3y: 0, gt3y: 0 };
      for (const lot of sorted) {
        let rem = lot.qty;
        if (sells >= rem) { sells -= rem; continue; }
        rem -= sells; sells = 0;
        const days = daysSince(lot.date);
        if      (days < 183)  b.lt6m += rem;
        else if (days < 365)  b.lt1y += rem;
        else if (days < 730)  b.lt2y += rem;
        else if (days < 1095) b.lt3y += rem;
        else                  b.gt3y += rem;
      }
      buckets.set(name, b);
    }

    const map = new Map<string, HoldingRow>();
    for (const e of this.entries) {
      if (!map.has(e.name)) {
        const bkt = buckets.get(e.name) || { lt6m: 0, lt1y: 0, lt2y: 0, lt3y: 0, gt3y: 0 };
        map.set(e.name, {
          name: e.name, category: e.category, fund_type: e.fund_type,
          totalBuyQty: 0, totalSellQty: 0, totalBuyValue: 0, totalSellValue: 0,
          netQty: 0, netValue: 0, effectiveNav: 0,
          lt6m: bkt.lt6m, lt1y: bkt.lt1y, lt2y: bkt.lt2y, lt3y: bkt.lt3y, gt3y: bkt.gt3y,
        });
      }
      const h = map.get(e.name)!;
      h.totalBuyQty += e.buy_quantity || 0;
      h.totalSellQty += e.sell_quantity || 0;
      h.totalBuyValue += e.buy_value || 0;
      h.totalSellValue += e.sell_value || 0;
    }
    return [...map.values()]
      .map(h => ({
        ...h,
        netQty: Math.round((h.totalBuyQty - h.totalSellQty) * 1000) / 1000,
        netValue: Math.round((h.totalBuyValue - h.totalSellValue) * 100) / 100,
        effectiveNav: h.totalBuyQty > 0 ? Math.round((h.totalBuyValue / h.totalBuyQty) * 100) / 100 : 0
      }))
      .filter(h => h.netQty > 0)
      .sort((a, b) => b.netValue - a.netValue);
  }

  getCategoryColor(category: string): string {
    const colors: Record<string, string> = {
      'Equity': '#3b82f6', 'Debt': '#10b981', 'Hybrid': '#8b5cf6',
      'Index': '#f59e0b', 'ELSS': '#ef4444', 'Sectoral': '#f97316'
    };
    return colors[category] || '#94a3b8';
  }

  rowClass(category: string): Record<string, boolean> {
    return {
      'row-cat-equity': category === 'Equity',
      'row-cat-debt': category === 'Debt',
      'row-cat-hybrid': category === 'Hybrid',
      'row-cat-index': category === 'Index',
      'row-cat-elss': category === 'ELSS',
      'row-cat-sectoral': category === 'Sectoral'
    };
  }

  private addSub?: Subscription;

  constructor(private investmentService: InvestmentService, private uiActionService: UiActionService) {}

  ngOnInit(): void {
    this.addSub = this.uiActionService.addEntry.subscribe(() => this.openAddForm());
    this.loadEntries();
  }

  ngOnDestroy(): void { this.addSub?.unsubscribe(); }

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
    if (this.selectedFYs.length) { filtered = filtered.filter(e => this.selectedFYs.includes(e.year || '')); }
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.category || '').toLowerCase().includes(q) ||
        (e.fund_type || '').toLowerCase().includes(q) ||
        (e.year || '').toLowerCase().includes(q)
      );
    }
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
    this.entries = filtered;
  }

  get fyLabel(): string { return this.selectedFYs.length === 0 ? 'All' : this.selectedFYs.join(', '); }
  isFYSelected(fy: string): boolean { return this.selectedFYs.includes(fy); }
  toggleFY(fy: string): void {
    const i = this.selectedFYs.indexOf(fy);
    if (i >= 0) this.selectedFYs.splice(i, 1); else this.selectedFYs.push(fy);
    this.applyFilter();
  }
  clearFYFilter(): void { this.selectedFYs = []; this.applyFilter(); }
  toggleShowAll(): void { this.showAll = !this.showAll; this.applyFilter(); }
  onSearch(): void { this.applyFilter(); }

  expandedFundName: string | null = null;
  toggleExpand(name: string): void {
    this.expandedFundName = this.expandedFundName === name ? null : name;
  }
  getFundTransactions(name: string): MutualFundEntry[] {
    return this.allEntries.filter(e => e.name === name).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

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

  onNameChange(): void {
    if (this.editingId) return;
    const match = this.allEntries.find(e => e.name?.toLowerCase() === this.form.name?.toLowerCase().trim());
    if (match) {
      this.form.category = match.category;
      this.form.fund_type = match.fund_type;
    }
  }

  onBuySellChange(): void {
    if (this.form.buy_sell === 'Buy') { this.form.sell_quantity = null; this.form.sell_value = null; }
    else { this.form.buy_quantity = null; this.form.buy_value = null; }
  }

  saveEntry(): void {
    if (!this.form.name?.trim()) { this.toast('Name is required', 'error'); return; }
    if (this.form.buy_sell === 'Buy' && (!this.form.buy_quantity || this.form.buy_quantity <= 0)) { this.toast('Buy quantity must be > 0', 'error'); return; }
    if (this.form.buy_sell === 'Sell' && (!this.form.sell_quantity || this.form.sell_quantity <= 0)) { this.toast('Sell quantity must be > 0', 'error'); return; }
    this.submitting = true;
    if (this.editingId) {
      this.investmentService.updateMutualFund(this.editingId, this.form).subscribe({
        next: () => {
          const idx = this.allEntries.findIndex(e => e.id === this.editingId!);
          if (idx >= 0) this.allEntries[idx] = { ...this.form, id: this.editingId! };
          this.applyFilter();
          this.submitting = false; this.toast('Entry updated successfully', 'success'); this.showForm = false; this.editingId = null;
        },
        error: () => { this.submitting = false; this.toast('Failed to update entry', 'error'); }
      });
    } else {
      this.investmentService.addMutualFund(this.form).subscribe({
        next: (res) => {
          if (res.upserted) {
            const existing = this.allEntries.find(e => e.id === res.id);
            if (existing) {
              existing.buy_quantity = (existing.buy_quantity || 0) + (this.form.buy_quantity || 0);
              existing.buy_value = (existing.buy_value || 0) + (this.form.buy_value || 0);
              existing.sell_quantity = (existing.sell_quantity || 0) + (this.form.sell_quantity || 0);
              existing.sell_value = (existing.sell_value || 0) + (this.form.sell_value || 0);
            }
          } else {
            this.allEntries.push({ ...this.form, id: res.id });
          }
          this.applyFilter();
          this.submitting = false; this.toast(res.upserted ? 'Existing entry updated (values added)' : 'Entry added successfully', 'success'); this.showForm = false;
        },
        error: () => { this.submitting = false; this.toast('Failed to add entry', 'error'); }
      });
    }
  }

  deleteEntry(id: number): void {
    if (confirm('Are you sure you want to delete this entry?')) {
      this.deleting = true;
      this.investmentService.deleteMutualFund(id).subscribe({
        next: () => {
          this.allEntries = this.allEntries.filter(e => e.id !== id);
          this.applyFilter();
          this.deleting = false; this.toast('Entry deleted successfully', 'success');
        },
        error: () => { this.deleting = false; this.toast('Failed to delete entry', 'error'); }
      });
    }
  }

  toast(msg: string, type: string): void {
    const t = { msg, type };
    this.toasts.push(t);
    setTimeout(() => { this.toasts = this.toasts.filter(x => x !== t); }, 3500);
  }
}
