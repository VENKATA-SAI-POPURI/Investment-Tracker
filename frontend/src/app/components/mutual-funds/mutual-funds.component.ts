import { Component, HostListener, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { InvestmentService } from '../../services/investment.service';
import { AuthService } from '../../services/auth.service';
import { UiActionService } from '../../services/ui-action.service';
import { CsvExportService } from '../../services/csv-export.service';
import { InrPipe } from '../../pipes/inr.pipe';
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
  netQty: number; netValue: number; effectiveNav: number; realizedPnL: number; realizedPnLPct: number;
  lt6m: number; lt1y: number; lt2y: number; lt3y: number; gt3y: number;
}

@Component({
  selector: 'app-mutual-funds',
  standalone: true,
  imports: [CommonModule, FormsModule, InrPipe],
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
  formTicker = '';
  tickerMap: Record<string, string> = {};
  livePrices: Record<string, number | null> = {};
  pricesFetching = false;
  pricesLastFetched: Date | null = null;
  globalNameSuggestions: string[] = [];
  globalMFMetaMap: Record<string, { category: string; fund_type: string }> = {};

  get nameSuggestions(): string[] {
    return [...new Set([
      ...this.allEntries.map(e => e.name).filter(Boolean),
      ...this.globalNameSuggestions
    ])] as string[];
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
    const buyLots = new Map<string, { date: string; qty: number; value: number }[]>();
    const totalSells = new Map<string, number>();
    const totalSellValues = new Map<string, number>();
    for (const e of this.allEntries) {
      const bq = e.buy_quantity || 0;
      const sq = e.sell_quantity || 0;
      if (bq > 0) {
        if (!buyLots.has(e.name)) buyLots.set(e.name, []);
        buyLots.get(e.name)!.push({ date: e.date || '', qty: bq, value: e.buy_value || 0 });
      }
      if (sq > 0) {
        totalSells.set(e.name, (totalSells.get(e.name) || 0) + sq);
        totalSellValues.set(e.name, (totalSellValues.get(e.name) || 0) + (e.sell_value || 0));
      }
    }
    const buckets = new Map<string, { lt6m: number; lt1y: number; lt2y: number; lt3y: number; gt3y: number }>();
    const fifoRealizedCost = new Map<string, number>();
    for (const [name, lots] of buyLots) {
      const sorted = [...lots].sort((a, b) => a.date.localeCompare(b.date));
      let sells = totalSells.get(name) || 0;
      const b = { lt6m: 0, lt1y: 0, lt2y: 0, lt3y: 0, gt3y: 0 };
      let realizedCost = 0;
      for (const lot of sorted) {
        let rem = lot.qty;
        const cpv = lot.qty > 0 ? lot.value / lot.qty : 0;
        if (sells >= rem) { sells -= rem; realizedCost += lot.value; continue; }
        if (sells > 0) { realizedCost += sells * cpv; rem -= sells; sells = 0; }
        const days = daysSince(lot.date);
        if      (days < 183)  b.lt6m += rem;
        else if (days < 365)  b.lt1y += rem;
        else if (days < 730)  b.lt2y += rem;
        else if (days < 1095) b.lt3y += rem;
        else                  b.gt3y += rem;
      }
      buckets.set(name, b);
      fifoRealizedCost.set(name, Math.round(realizedCost * 100) / 100);
    }

    const map = new Map<string, HoldingRow>();
    for (const e of this.entries) {
      if (!map.has(e.name)) {
        const bkt = buckets.get(e.name) || { lt6m: 0, lt1y: 0, lt2y: 0, lt3y: 0, gt3y: 0 };
        map.set(e.name, {
          name: e.name, category: e.category, fund_type: e.fund_type,
          totalBuyQty: 0, totalSellQty: 0, totalBuyValue: 0, totalSellValue: 0,
          netQty: 0, netValue: 0, effectiveNav: 0, realizedPnL: 0, realizedPnLPct: 0,
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
        effectiveNav: h.totalBuyQty > 0 ? Math.round((h.totalBuyValue / h.totalBuyQty) * 100) / 100 : 0,
        realizedPnL: (() => { const rc = fifoRealizedCost.get(h.name) || 0; const sv = totalSellValues.get(h.name) || 0; return rc > 0 || sv > 0 ? Math.round((sv - rc) * 100) / 100 : 0; })(),
        realizedPnLPct: (() => { const rc = fifoRealizedCost.get(h.name) || 0; const sv = totalSellValues.get(h.name) || 0; return rc > 0 ? Math.round(((sv - rc) / rc) * 10000) / 100 : 0; })()
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

  constructor(private investmentService: InvestmentService, private uiActionService: UiActionService, private csvExport: CsvExportService, public authService: AuthService) {}

  get canWrite(): boolean { return this.authService.canWrite(); }

  ngOnInit(): void {
    this.addSub = this.uiActionService.addEntry.subscribe(page => { if (page === 'mutual-funds') this.openAddForm(); });
    this.addSub.add(this.uiActionService.refresh.subscribe(() => { this.uiActionService.beginRefresh(); this.loadEntries(() => this.uiActionService.endRefresh()); }));
    this.addSub.add(this.uiActionService.mfPrices$.subscribe(prices => {
      if (Object.keys(prices).length > 0) {
        this.livePrices = { ...this.livePrices, ...prices };
        this.pricesLastFetched = new Date();
      }
    }));
    this.loadEntries();
    this.loadTickerMap();
    this.investmentService.getNameSuggestions().subscribe({
      next: (s) => {
        this.globalNameSuggestions = s.mutual_funds ?? [];
        this.globalMFMetaMap = s.mf_meta ?? {};
      },
      error: () => {}
    });
  }

  ngOnDestroy(): void { this.addSub?.unsubscribe(); }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.showForm) { this.showForm = false; this.editingId = null; }
  }

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

  loadEntries(onComplete?: () => void): void {
    if (this.allEntries.length === 0) this.loading = true;
    this.investmentService.getMutualFunds().subscribe({
      next: (data) => { this.allEntries = data; this.applyFilter(); this.loading = false; onComplete?.(); },
      error: () => { this.toast('Failed to load entries', 'error'); this.loading = false; onComplete?.(); }
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

  openAddForm(): void { this.form = this.emptyForm(); this.formTicker = ''; this.editingId = null; this.showForm = true; }
  openEditForm(entry: MutualFundEntry): void { this.form = { ...entry }; this.formTicker = this.tickerMap[entry.name] ?? ''; this.editingId = entry.id!; this.showForm = true; }
  cancelForm(): void { this.showForm = false; this.editingId = null; this.formTicker = ''; }

  onNameChange(): void {
    if (this.editingId) return;
    const name = this.form.name?.toLowerCase().trim() ?? '';
    const match = this.allEntries.find(e => e.name?.toLowerCase() === name);
    if (match) {
      this.form.category = match.category;
      this.form.fund_type = match.fund_type;
    } else {
      const global = this.globalMFMetaMap[this.form.name?.trim() ?? ''];
      if (global) {
        this.form.category = global.category;
        this.form.fund_type = global.fund_type;
      }
    }
    this.formTicker = this.tickerMap[this.form.name?.trim() ?? ''] ?? '';
  }

  onBuySellChange(): void {
    if (this.form.buy_sell === 'Buy') { this.form.sell_quantity = null; this.form.sell_value = null; }
    else { this.form.buy_quantity = null; this.form.buy_value = null; }
  }

  saveEntry(): void {
    if (!this.form.name?.trim()) { this.toast('Name is required', 'error'); return; }
    if (this.form.buy_sell === 'Buy' && (!this.form.buy_quantity || this.form.buy_quantity <= 0)) { this.toast('Buy quantity must be > 0', 'error'); return; }
    if (this.form.buy_sell === 'Sell' && (!this.form.sell_quantity || this.form.sell_quantity <= 0)) { this.toast('Sell quantity must be > 0', 'error'); return; }
    const tickerToSave = this.formTicker.trim();
    this.submitting = true;
    if (this.editingId) {
      this.investmentService.updateMutualFund(this.editingId, this.form).subscribe({
        next: () => {
          const idx = this.allEntries.findIndex(e => e.id === this.editingId!);
          if (idx >= 0) this.allEntries[idx] = { ...this.form, id: this.editingId! };
          this.applyFilter();
          this.submitting = false; this.toast('Entry updated successfully', 'success'); this.showForm = false; this.editingId = null;
          if (tickerToSave) { this.tickerMap[this.form.name] = tickerToSave; this.investmentService.saveMFTicker(this.form.name, tickerToSave).subscribe({ error: () => {} }); }
          this.formTicker = '';
          this.uiActionService.triggerSilentRefresh();
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
          if (tickerToSave) { this.tickerMap[this.form.name] = tickerToSave; this.investmentService.saveMFTicker(this.form.name, tickerToSave).subscribe({ error: () => {} }); }
          this.formTicker = '';
          this.uiActionService.triggerSilentRefresh();
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
          this.uiActionService.triggerSilentRefresh();
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

  exportCsv(): void {
    if (this.viewMode === 'holdings') {
      this.csvExport.download('mutual_funds_holdings.csv',
        ['Name', 'Category', 'Fund Type', 'Net Qty', 'Net Value (INR)', 'Effective NAV', 'Realized P&L', 'Realized P&L %'],
        this.holdings.map(h => [h.name, h.category, h.fund_type, h.netQty, h.netValue, h.effectiveNav, h.realizedPnL, h.realizedPnLPct])
      );
    } else {
      this.csvExport.download('mutual_funds_transactions.csv',
        ['Year', 'Date', 'Name', 'Category', 'Fund Type', 'Buy/Sell', 'Buy Qty', 'Buy Value', 'Sell Qty', 'Sell Value', 'Remarks'],
        this.entries.map(e => [e.year, e.date, e.name, e.category, e.fund_type, e.buy_sell, e.buy_quantity, e.buy_value, e.sell_quantity, e.sell_value, e.remarks])
      );
    }
  }

  loadTickerMap(): void {
    this.investmentService.getMFTickers().subscribe({
      next: (data) => {
        this.tickerMap = {};
        for (const [name, val] of Object.entries(data)) {
          this.tickerMap[name] = val.ticker;
          if (val.price != null) {
            this.livePrices[val.ticker] = val.price;
          }
        }
      },
      error: () => {}
    });
  }

  fetchLivePrices(): void {
    const symbols = [...new Set(
      this.holdings.map(h => this.tickerMap[h.name]).filter((t): t is string => !!t)
    )];
    if (symbols.length === 0) {
      this.toast('No ticker symbols configured for current holdings', 'error');
      return;
    }
    this.pricesFetching = true;
    this.investmentService.fetchMFPrices(symbols).subscribe({
      next: (prices) => {
        this.livePrices = prices;
        this.uiActionService.mfPrices$.next(prices);
        this.pricesLastFetched = new Date();
        this.pricesFetching = false;
        this.toast('Prices updated', 'success');
      },
      error: () => {
        this.pricesFetching = false;
        this.toast('Failed to fetch live prices', 'error');
      }
    });
  }

  getUnrealizedPnL(h: HoldingRow): { pnl: number; pct: number } | null {
    const ticker = this.tickerMap[h.name];
    if (!ticker) return null;
    const price = this.livePrices[ticker] ?? null;
    if (price == null || h.netQty <= 0 || h.netValue <= 0) return null;
    const mv = Math.round(price * h.netQty * 100) / 100;
    const pnl = Math.round((mv - h.netValue) * 100) / 100;
    const pct = Math.round((pnl / h.netValue) * 10000) / 100;
    return { pnl, pct };
  }
}
