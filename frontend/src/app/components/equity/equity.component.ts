import { Component, HostListener, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, Subscription } from 'rxjs';
import { InvestmentService } from '../../services/investment.service';
import { UiActionService } from '../../services/ui-action.service';
import { CsvExportService } from '../../services/csv-export.service';
import { InrPipe } from '../../pipes/inr.pipe';
import { AuthService } from '../../services/auth.service';
import { EquityEntry, ForexEntry, EquityDividend } from '../../models/investment.model';


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
  realizedPnL: number;
  realizedPnLPct: number;
  // FIFO holding-period buckets (quantity)
  lt6m: number;   // < 6 months
  lt1y: number;   // 6 months – 1 year
  lt2y: number;   // 1 year – 2 years
  gt2y: number;   // > 2 years
}

@Component({
  selector: 'app-equity',
  standalone: true,
  imports: [CommonModule, FormsModule, InrPipe],
  templateUrl: './equity.component.html',
  styleUrl: './equity.component.scss'
})
export class EquityComponent implements OnInit, OnDestroy {
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
  formTicker = '';
  tickerMap: Record<string, string> = {};
  livePrices: Record<string, number | null> = {};
  pricesFetching = false;
  pricesLastFetched: Date | null = null;
  livePricesVisible = false;

  // Dividend modal state
  dividendData: EquityDividend[] = [];
  showDividendModal = false;
  dividendStockName = '';
  dividendStockBuyValue = 0;
  dividendForm: { date: string; amount: string; remarks: string } = { date: '', amount: '', remarks: '' };
  dividendEditingId: number | null = null;
  dividendSubmitting = false;

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
  globalNameSuggestions: string[] = [];
  globalEquityMetaMap: Record<string, { market: string; market_cap: string; sector: string }> = {};

  get nameSuggestions(): string[] {
    return [...new Set([
      ...this.allEntries.map(e => e.name).filter(Boolean),
      ...this.globalNameSuggestions
    ])] as string[];
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

    // 1. Same-day netting + FIFO: sells on a given date first cancel out same-day
    //    buys (intraday); any remaining sell qty is consumed oldest-first (FIFO).
    const buysByNameDate = new Map<string, Map<string, { qty: number; value: number; valueUsd: number }>>();
    const sellsByNameDate = new Map<string, Map<string, number>>();
    const sellValueByName = new Map<string, number>();
    for (const e of this.allEntries) {
      if (e.buy_sell === 'Buy') {
        if (!buysByNameDate.has(e.name)) buysByNameDate.set(e.name, new Map());
        const dm = buysByNameDate.get(e.name)!;
        const prev = dm.get(e.date) || { qty: 0, value: 0, valueUsd: 0 };
        dm.set(e.date, { qty: prev.qty + (e.quantity || 0), value: prev.value + (e.value || 0), valueUsd: prev.valueUsd + (e.value_usd || 0) });
      } else {
        if (!sellsByNameDate.has(e.name)) sellsByNameDate.set(e.name, new Map());
        const dm = sellsByNameDate.get(e.name)!;
        dm.set(e.date, (dm.get(e.date) || 0) + (e.quantity || 0));
        sellValueByName.set(e.name, (sellValueByName.get(e.name) || 0) + (e.value || 0));
      }
    }

    const buckets = new Map<string, { lt6m: number; lt1y: number; lt2y: number; gt2y: number }>();
    const fifoNetValue = new Map<string, { inr: number; usd: number }>();
    const fifoRealizedCost = new Map<string, number>();
    const allStockNames = new Set<string>([...buysByNameDate.keys(), ...sellsByNameDate.keys()]);

    for (const name of allStockNames) {
      // Mutable copies for same-day netting
      const buyMap = new Map<string, { qty: number; value: number; valueUsd: number }>();
      for (const [d, v] of (buysByNameDate.get(name) || new Map())) buyMap.set(d, { ...v });
      const sellMap = new Map<string, number>();
      for (const [d, q] of (sellsByNameDate.get(name) || new Map())) sellMap.set(d, q);

      // Priority: net off sells against same-day buys first; track realized cost from netting
      let realizedCostInr = 0;
      for (const [date, sellQty] of sellMap) {
        const bd = buyMap.get(date);
        if (bd && bd.qty > 0 && sellQty > 0) {
          const netted = Math.min(bd.qty, sellQty);
          const ratio = (bd.qty - netted) / bd.qty;
          realizedCostInr += bd.value * (1 - ratio); // cost of netted (same-day) portion
          buyMap.set(date, { qty: bd.qty - netted, value: bd.value * ratio, valueUsd: bd.valueUsd * ratio });
          sellMap.set(date, sellQty - netted);
        }
      }

      // Effective buy lots remaining after same-day netting, sorted oldest-first
      const effectiveLots = [...buyMap.entries()]
        .filter(([, bd]) => bd.qty > 0)
        .map(([date, bd]) => ({ date, qty: bd.qty, value: bd.value, valueUsd: bd.valueUsd }))
        .sort((a, b) => a.date.localeCompare(b.date));

      let remSells = 0;
      for (const q of sellMap.values()) remSells += q;

      const b = { lt6m: 0, lt1y: 0, lt2y: 0, gt2y: 0 };
      let netInr = 0, netUsd = 0;
      for (const lot of effectiveLots) {
        let rem = lot.qty;
        const cpuInr = lot.qty > 0 ? lot.value / lot.qty : 0;
        const cpuUsd = lot.qty > 0 ? lot.valueUsd / lot.qty : 0;
        if (remSells >= rem) { remSells -= rem; realizedCostInr += lot.value; continue; }
        if (remSells > 0) { realizedCostInr += remSells * cpuInr; rem -= remSells; remSells = 0; }
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
      fifoRealizedCost.set(name, Math.round(realizedCostInr * 100) / 100);
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
          realizedPnL: 0, realizedPnLPct: 0,
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
      const rc = fifoRealizedCost.get(h.name) || 0;
      const sv = sellValueByName.get(h.name) || 0;
      return {
        ...h,
        netQty: h.totalBuyQty - h.totalSellQty,
        netValue: fifo.inr,
        netValueUsd: fifo.usd,
        costPerUnit: h.totalBuyQty > 0 ? Math.round((h.totalBuyValue / h.totalBuyQty) * 100) / 100 : 0,
        costPerUnitUsd: h.totalBuyQty > 0 ? Math.round((h.totalBuyValueUsd / h.totalBuyQty) * 100) / 100 : 0,
        realizedPnL: rc > 0 || sv > 0 ? Math.round((sv - rc) * 100) / 100 : 0,
        realizedPnLPct: rc > 0 ? Math.round(((sv - rc) / rc) * 10000) / 100 : 0,
      };
    }).sort((a, b) => b.netValue - a.netValue);
  }

  private addSub?: Subscription;

  constructor(private investmentService: InvestmentService, private uiActionService: UiActionService, private csvExport: CsvExportService, public authService: AuthService) {}

  get canWrite(): boolean { return this.authService.canWrite(); }

  ngOnInit(): void {
    this.addSub = this.uiActionService.addEntry.subscribe(page => { if (page === 'equity') this.openAddForm(); });
    this.addSub.add(this.uiActionService.refresh.subscribe(() => { this.uiActionService.beginRefresh(); this.loadEntries(() => this.uiActionService.endRefresh()); this.loadDividends(); }));
    this.addSub.add(this.uiActionService.equityPrices$.subscribe(prices => {
      if (Object.keys(prices).length > 0) {
        this.livePrices = { ...this.livePrices, ...prices };
        this.pricesLastFetched = new Date();
        this.livePricesVisible = true;
      }
    }));
    this.loadForexData();
    this.loadEntries();
    this.loadTickerMap();
    this.loadDividends();
    this.investmentService.getNameSuggestions().subscribe({
      next: (s) => {
        this.globalNameSuggestions = s.equity ?? [];
        this.globalEquityMetaMap = s.equity_meta ?? {};
      },
      error: () => {}
    });
  }

  ngOnDestroy(): void { this.addSub?.unsubscribe(); }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.showForm) { this.showForm = false; this.editingId = null; }
    if (this.showDividendModal) { this.showDividendModal = false; }
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

  loadEntries(onComplete?: () => void): void {
    if (this.allEntries.length === 0) this.loading = true;
    this.investmentService.getEquity().subscribe({
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

  loadDividends(): void {
    // Always bypass cache to get fresh data
    delete (this.investmentService as any).cache['equity-dividends'];
    this.investmentService.getEquityDividends().subscribe({
      next: (data) => { this.dividendData = data; },
      error: () => {}
    });
  }

  // ── Dividend helpers ──

  getDividendsForStock(name: string): EquityDividend[] {
    return this.dividendData
      .filter(d => d.name === name)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  getDividendTotalForStock(name: string): number {
    return this.dividendData
      .filter(d => d.name === name)
      .reduce((s, d) => s + (d.amount || 0), 0);
  }

  getDividendPctForStock(h: HoldingRow): number {
    if (!h.totalBuyValue || h.totalBuyValue === 0) return 0;
    return Math.round((this.getDividendTotalForStock(h.name) / h.totalBuyValue) * 10000) / 100;
  }

  getDividendPctByValue(name: string, buyValue: number): number {
    if (!buyValue || buyValue === 0) return 0;
    return Math.round((this.getDividendTotalForStock(name) / buyValue) * 10000) / 100;
  }

  openDividendModal(h: HoldingRow): void {
    this.dividendStockName = h.name;
    this.dividendStockBuyValue = h.totalBuyValue;
    this.dividendEditingId = null;
    this.dividendForm = { date: new Date().toISOString().split('T')[0], amount: '', remarks: '' };
    this.showDividendModal = true;
  }

  closeDividendModal(): void {
    this.showDividendModal = false;
    this.dividendEditingId = null;
  }

  editDividend(d: EquityDividend): void {
    this.dividendEditingId = d.id!;
    this.dividendForm = { date: d.date, amount: String(d.amount), remarks: d.remarks || '' };
  }

  cancelDividendEdit(): void {
    this.dividendEditingId = null;
    this.dividendForm = { date: new Date().toISOString().split('T')[0], amount: '', remarks: '' };
  }

  submitDividend(): void {
    if (!this.dividendForm.amount || isNaN(+this.dividendForm.amount)) return;
    this.dividendSubmitting = true;
    const payload = { name: this.dividendStockName, date: this.dividendForm.date, amount: +this.dividendForm.amount, remarks: this.dividendForm.remarks };

    if (this.dividendEditingId) {
      this.investmentService.updateEquityDividend(this.dividendEditingId, payload).subscribe({
        next: () => {
          this.investmentService.getEquityDividends().subscribe(data => { this.dividendData = data; });
          this.dividendSubmitting = false;
          this.dividendEditingId = null;
          this.dividendForm = { date: new Date().toISOString().split('T')[0], amount: '', remarks: '' };
          this.uiActionService.triggerSilentRefresh();
        },
        error: () => { this.dividendSubmitting = false; this.toast('Failed to update dividend', 'error'); }
      });
    } else {
      this.investmentService.addEquityDividend(payload).subscribe({
        next: () => {
          this.investmentService.getEquityDividends().subscribe(data => { this.dividendData = data; });
          this.dividendSubmitting = false;
          this.dividendForm = { date: new Date().toISOString().split('T')[0], amount: '', remarks: '' };
          this.uiActionService.triggerSilentRefresh();
        },
        error: () => { this.dividendSubmitting = false; this.toast('Failed to add dividend', 'error'); }
      });
    }
  }

  deleteDividend(d: EquityDividend): void {
    if (!confirm('Delete this dividend entry?')) return;
    this.investmentService.deleteEquityDividend(d.id!).subscribe({
      next: () => {
        this.dividendData = this.dividendData.filter(x => x.id !== d.id);
        this.uiActionService.triggerSilentRefresh();
      },
      error: () => { this.toast('Failed to delete dividend', 'error'); }
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
    this.formTicker = '';
    this.editingId = null;
    this.showForm = true;
  }

  openEditForm(entry: EquityEntry): void {
    this.form = { ...entry };
    this.formTicker = this.tickerMap[entry.name] ?? '';
    this.editingId = entry.id!;
    this.showForm = true;
  }

  cancelForm(): void {
    this.showForm = false;
    this.editingId = null;
    this.formTicker = '';
  }

  toggleExpand(name: string): void {
    this.expandedName = this.expandedName === name ? null : name;
  }

  getTransactionsForStock(name: string): EquityEntry[] {
    return this.entries.filter(e => e.name === name).sort((a, b) => b.date.localeCompare(a.date));
  }

  onNameChange(): void {
    if (this.editingId) return;
    const name = this.form.name?.toLowerCase().trim() ?? '';
    const match = this.allEntries.find(e => e.name?.toLowerCase() === name);
    if (match) {
      this.form.market = match.market;
      this.form.market_cap = match.market_cap;
      this.form.sector = match.sector;
    } else {
      const global = this.globalEquityMetaMap[this.form.name?.trim() ?? ''];
      if (global) {
        this.form.market = global.market;
        this.form.market_cap = global.market_cap;
        this.form.sector = global.sector;
      }
    }
    this.formTicker = this.tickerMap[this.form.name?.trim() ?? ''] ?? '';
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

    const tickerToSave = this.formTicker.trim();
    this.submitting = true;
    if (this.editingId) {
      this.investmentService.updateEquity(this.editingId, formToSave).subscribe({
        next: () => {
          const idx = this.allEntries.findIndex(e => e.id === this.editingId!);
          if (idx >= 0) this.allEntries[idx] = { ...formToSave, id: this.editingId! };
          this.applyFilter();
          this.submitting = false;
          this.toast('Entry updated successfully', 'success');
          this.showForm = false;
          this.editingId = null;
          if (tickerToSave) {
            this.tickerMap[formToSave.name] = tickerToSave;
            this.investmentService.saveEquityTicker(formToSave.name, tickerToSave).subscribe({ error: () => {} });
          }
          this.formTicker = '';
          this.uiActionService.triggerSilentRefresh();
        },
        error: () => { this.submitting = false; this.toast('Failed to update entry', 'error'); }
      });
    } else {
      this.investmentService.addEquity(formToSave).subscribe({
        next: (res) => {
          this.allEntries.push({ ...formToSave, id: res.id });
          this.applyFilter();
          this.submitting = false;
          this.toast('Entry added successfully', 'success');
          this.showForm = false;
          if (tickerToSave) {
            this.tickerMap[formToSave.name] = tickerToSave;
            this.investmentService.saveEquityTicker(formToSave.name, tickerToSave).subscribe({ error: () => {} });
          }
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
      this.investmentService.deleteEquity(id).subscribe({
        next: () => {
          this.allEntries = this.allEntries.filter(e => e.id !== id);
          this.applyFilter();
          this.deleting = false;
          this.toast('Entry deleted successfully', 'success');
          this.uiActionService.triggerSilentRefresh();
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

  exportCsv(): void {
    if (this.viewMode === 'holdings') {
      this.csvExport.download('equity_holdings.csv',
        ['Name', 'Market', 'Sector', 'Market Cap', 'Net Qty', 'Net Value (INR)', 'Net Value (USD)', 'Cost/Unit (INR)', 'Realized P&L', 'Realized P&L %'],
        this.holdings.map(h => [h.name, h.market, h.sector, h.market_cap, h.netQty, h.netValue, h.netValueUsd, h.costPerUnit, h.realizedPnL, h.realizedPnLPct])
      );
    } else {
      this.csvExport.download('equity_transactions.csv',
        ['Date', 'Name', 'Market', 'Sector', 'Market Cap', 'Buy/Sell', 'Quantity', 'Value (INR)', 'Value (USD)', 'Remarks'],
        this.entries.map(e => [e.date, e.name, e.market, e.sector, e.market_cap, e.buy_sell, e.quantity, e.value, e.value_usd, e.remarks])
      );
    }
  }

  loadTickerMap(): void {
    this.investmentService.getEquityTickers().subscribe({
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
    this.investmentService.fetchEquityPrices(symbols).subscribe({
      next: (prices) => {
        this.livePrices = prices;
        this.uiActionService.equityPrices$.next(prices);
        this.pricesLastFetched = new Date();
        this.livePricesVisible = true;
        this.pricesFetching = false;
        this.toast('Prices updated', 'success');
      },
      error: () => {
        this.pricesFetching = false;
        this.toast('Failed to fetch live prices', 'error');
      }
    });
  }

  getCurrentPrice(h: HoldingRow): number | null {
    const ticker = this.tickerMap[h.name];
    if (!ticker) return null;
    return this.livePrices[ticker] ?? null;
  }

  getMarketValueINR(h: HoldingRow): number | null {
    const price = this.getCurrentPrice(h);
    if (price == null || h.netQty <= 0) return null;
    if (h.market === 'USA') {
      const rate = this.latestForexRate;
      if (rate <= 0) return null;
      return Math.round(price * h.netQty * rate * 100) / 100;
    }
    return Math.round(price * h.netQty * 100) / 100;
  }

  getUnrealizedPnL(h: HoldingRow): { pnl: number; pct: number } | null {
    const mv = this.getMarketValueINR(h);
    if (mv == null || h.netValue <= 0) return null;
    const pnl = Math.round((mv - h.netValue) * 100) / 100;
    const pct = Math.round((pnl / h.netValue) * 10000) / 100;
    return { pnl, pct };
  }

  get totalUnrealizedPnLINR(): number {
    return Math.round(this.holdings.reduce((sum, h) => sum + (this.getUnrealizedPnL(h)?.pnl ?? 0), 0) * 100) / 100;
  }
}

