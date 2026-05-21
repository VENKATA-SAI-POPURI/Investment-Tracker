import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { InvestmentService } from '../../services/investment.service';
import { Summary, EquityEntry, CommodityEntry, MutualFundEntry, P2PEntry, P2PRepayment, FixedDepositEntry, ForexEntry } from '../../models/investment.model';

interface PieSlice {
  label: string;
  value: number;
  pct: number;
  color: string;
}

interface PieChart {
  title: string;
  total: number;
  slices: PieSlice[];
  gradient: string;
}

interface BarItem {
  label: string;
  value: number;
  pct: number;
  pnlPct: number;
  isPositive: boolean;
}

interface BarChart {
  title: string;
  items: BarItem[];
  maxAbs: number;
  totalProfit: number;
  totalLoss: number;
  netTotal: number;
  netPnLPct: number;
}

interface CategoryDef {
  key: string;
  route: string;
  icon: string;
}

const PIE_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#a855f7', '#06b6d4'];

const DEFAULT_TARGET_ALLOCATION: Record<string, number> = {
  'Equity (India)': 35,
  'Equity (USA)': 30,
  'Mutual Funds': 20,
  'Commodity': 10,
  'P2P': 5
};

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink, FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss'
})
export class DashboardComponent implements OnInit {
  summary: Summary = {};
  loading = true;
  refreshing = false;
  showTargetEditor = false;
  targetAllocation: Record<string, number> = { ...DEFAULT_TARGET_ALLOCATION };

  saveTargets(): void {
    this.investmentService.saveSetting('targetAllocation', JSON.stringify(this.targetAllocation)).subscribe();
  }

  get targetAllocationKeys(): string[] {
    return Object.keys(this.targetAllocation);
  }
  darkMode = false;

  equityData: EquityEntry[] = [];
  commodityData: CommodityEntry[] = [];
  mfData: MutualFundEntry[] = [];
  p2pData: P2PEntry[] = [];
  p2pRepayments: P2PRepayment[] = [];
  fdData: FixedDepositEntry[] = [];
  forexData: ForexEntry[] = [];
  showForexPopup = false;

  selectedCategory = 'Equity';
  selectedMetric = 'Current Holdings';
  selectedYear = 'All';

  metrics = ['Current Holdings', 'Total Investments', 'Net P&L'];

  categories: CategoryDef[] = [
    { key: 'Equity', route: '/equity', icon: '📈' },
    { key: 'Mutual Funds', route: '/mutual-funds', icon: '📊' },
    { key: 'Commodity', route: '/commodity', icon: '🥇' },
    { key: 'P2P', route: '/p2p', icon: '🤝' },
    { key: 'Fixed Deposits', route: '/fixed-deposits', icon: '🏦' },
    { key: 'Forex', route: '/forex', icon: '💱' },
  ];

  analysisCategories: CategoryDef[] = [
    { key: 'Equity', route: '/equity', icon: '📈' },
    { key: 'Mutual Funds', route: '/mutual-funds', icon: '📊' },
    { key: 'Commodity', route: '/commodity', icon: '🥇' },
    { key: 'P2P', route: '/p2p', icon: '🤝' },
    { key: 'Fixed Deposits', route: '/fixed-deposits', icon: '🏦' },
  ];

  private systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  constructor(private investmentService: InvestmentService) {}

  ngOnInit(): void {
    const saved = localStorage.getItem('darkMode');
    if (saved !== null) {
      this.darkMode = saved === 'true';
    } else {
      this.darkMode = this.systemDarkQuery.matches;
    }
    this.applyDarkMode();

    this.systemDarkQuery.addEventListener('change', (e) => {
      if (localStorage.getItem('darkMode') === null) {
        this.darkMode = e.matches;
        this.applyDarkMode();
      }
    });

    this.loadAll();
    this.restoreAICache();
    this.investmentService.getSetting('targetAllocation').subscribe(res => {
      if (res.value) {
        try {
          this.targetAllocation = { ...DEFAULT_TARGET_ALLOCATION, ...JSON.parse(res.value) };
        } catch {}
      }
    });
  }

  toggleDarkMode(): void {
    this.darkMode = !this.darkMode;
    localStorage.setItem('darkMode', String(this.darkMode));
    this.applyDarkMode();
  }

  private applyDarkMode(): void {
    document.body.classList.toggle('dark', this.darkMode);
    document.body.classList.toggle('light', !this.darkMode);
  }

  refreshData(): void {
    if (this.refreshing) return;
    this.investmentService.clearAllCache();
    this.refreshing = true;
    forkJoin({
      summary: this.investmentService.getSummary(),
      equity: this.investmentService.getEquity(),
      commodity: this.investmentService.getCommodity(),
      mf: this.investmentService.getMutualFunds(),
      p2p: this.investmentService.getP2P(),
      p2pRep: this.investmentService.getP2PRepayments(),
      fd: this.investmentService.getFixedDeposits(),
      forex: this.investmentService.getForex()
    }).subscribe({
      next: (data) => {
        this.summary = data.summary;
        this.equityData = data.equity;
        this.commodityData = data.commodity;
        this.mfData = data.mf;
        this.p2pData = data.p2p;
        this.p2pRepayments = data.p2pRep;
        this.fdData = data.fd;
        this.forexData = data.forex;
        this.refreshing = false;
      },
      error: () => this.refreshing = false
    });
  }

  loadAll(): void {
    this.loading = true;
    forkJoin({
      summary: this.investmentService.getSummary(),
      equity: this.investmentService.getEquity(),
      commodity: this.investmentService.getCommodity(),
      mf: this.investmentService.getMutualFunds(),
      p2p: this.investmentService.getP2P(),
      p2pRep: this.investmentService.getP2PRepayments(),
      fd: this.investmentService.getFixedDeposits(),
      forex: this.investmentService.getForex()
    }).subscribe({
      next: (data) => {
        this.summary = data.summary;
        this.equityData = data.equity;
        this.commodityData = data.commodity;
        this.mfData = data.mf;
        this.p2pData = data.p2p;
        this.p2pRepayments = data.p2pRep;
        this.fdData = data.fd;
        this.forexData = data.forex;
        this.loading = false;
      },
      error: () => this.loading = false
    });
  }

  // ── Available Years ──

  get availableYears(): string[] {
    const years = new Set<string>();
    // Equity: derive FY from date (no year field)
    this.equityData.forEach(e => { const fy = this.dateToFY(e.date); if (fy) years.add(fy); });
    // Others still use year field
    [...this.commodityData, ...this.mfData, ...this.fdData]
      .forEach((e: any) => { if (e.year) years.add(e.year); });
    return ['All', ...Array.from(years).sort()];
  }

  selectYear(year: string): void {
    this.selectedYear = year;
  }

  // ── Global KPIs ──

  getCategoryActiveCount(key: string): number {
    switch (key) {
      case 'Equity': {
        // Count stocks with net positive value (buy > sell)
        const netMap = new Map<string, number>();
        this.equityData.forEach(e => {
          const sign = e.buy_sell === 'Sell' ? -1 : 1;
          netMap.set(e.name, (netMap.get(e.name) || 0) + sign * (e.value || 0));
        });
        return [...netMap.values()].filter(v => v > 0).length;
      }
      case 'Mutual Funds': {
        const netMap = new Map<string, number>();
        this.mfData.forEach(e => {
          netMap.set(e.name, (netMap.get(e.name) || 0) + (e.buy_quantity || 0) - (e.sell_quantity || 0));
        });
        return [...netMap.values()].filter(v => v > 0).length;
      }
      case 'Commodity': {
        const netMap = new Map<string, number>();
        this.commodityData.forEach(e => {
          netMap.set(e.name, (netMap.get(e.name) || 0) + (e.buy_quantity || 0) - (e.sell_quantity || 0));
        });
        return [...netMap.values()].filter(v => v > 0).length;
      }
      case 'P2P':
        return this.p2pData.filter(e => e.status === 'Active').length;
      case 'Fixed Deposits':
        return this.fdData.filter(e => !e.return_value || e.return_value === 0).length;
      default:
        return this.summary[key]?.count || 0;
    }
  }

  private calcInvestment(buyQty: number | null, sellQty: number | null, buyValue: number | null): number {
    const bq = buyQty || 0;
    const sq = sellQty || 0;
    if (bq <= sq) return 0;
    const pricePerUnit = bq > 0 ? (buyValue || 0) / bq : 0;
    return pricePerUnit * (bq - sq);
  }

  get currentInvestment(): number {
    let total = 0;

    // Equity: FIFO cost of remaining lots, clamped per stock (fully-exited positions = 0)
    total += this.equityFifoHoldings.reduce((s, h) => s + h.value, 0);

    total += this.mfData.reduce((sum, e) => sum + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
    total += this.commodityData.reduce((sum, e) => sum + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
    // P2P: use backend-computed pending (amount - repaid)
    const p2pSummary = this.summary['P2P'];
    if (p2pSummary) {
      total += (p2pSummary as any).current_invested || 0;
    }
    // FD: only active (not yet matured) deposits
    total += this.fdData.filter(e => !e.return_value || e.return_value === 0).reduce((sum, e) => sum + (e.fd_value || 0), 0);
    return Math.round(total * 100) / 100;
  }

  get totalInvestment(): number {
    return Object.entries(this.summary)
      .filter(([key]) => key !== 'Forex')
      .reduce((sum, [, s]) => sum + s.total_buy, 0);
  }

  get totalSaleValue(): number {
    return Object.entries(this.summary)
      .filter(([key]) => key !== 'Forex')
      .reduce((sum, [, s]) => sum + s.total_sell, 0);
  }

  get netPnL(): number {
    return this.totalSaleValue - (this.totalInvestment - this.currentInvestment);
  }

  get costOfSold(): number {
    return Math.round((this.totalInvestment - this.currentInvestment) * 100) / 100;
  }

  get netPnLPct(): number {
    const exitedValue = this.totalInvestment - this.currentInvestment;
    return exitedValue > 0 ? Math.round((this.netPnL / exitedValue) * 10000) / 100 : 0;
  }

  // ── Equity FIFO holdings (per-stock cost of remaining lots, always from all data) ──

  private get equityFifoHoldings(): { name: string; value: number; market: string; market_cap: string; sector: string }[] {
    const buyLots = new Map<string, { date: string; qty: number; value: number; meta: { market: string; market_cap: string; sector: string } }[]>();
    const totalSells = new Map<string, number>();
    for (const e of this.equityData) {
      if (e.buy_sell === 'Buy') {
        if (!buyLots.has(e.name)) buyLots.set(e.name, []);
        buyLots.get(e.name)!.push({ date: e.date, qty: e.quantity || 0, value: e.value || 0,
          meta: { market: e.market, market_cap: e.market_cap, sector: e.sector } });
      } else {
        totalSells.set(e.name, (totalSells.get(e.name) || 0) + (e.quantity || 0));
      }
    }
    const result: { name: string; value: number; market: string; market_cap: string; sector: string }[] = [];
    for (const [name, lots] of buyLots) {
      const sorted = [...lots].sort((a, b) => a.date.localeCompare(b.date));
      let sells = totalSells.get(name) || 0;
      let fifoValue = 0;
      for (const lot of sorted) {
        let rem = lot.qty;
        if (sells >= rem) { sells -= rem; continue; }
        rem -= sells; sells = 0;
        fifoValue += rem * (lot.qty > 0 ? lot.value / lot.qty : 0);
      }
      if (fifoValue > 0) {
        result.push({ name, value: Math.round(fifoValue * 100) / 100, ...sorted[0].meta });
      }
    }
    return result;
  }

  // ── Equity net holdings helper (per-stock, clamped to 0) — used for analysis charts ──

  private equityNetHoldings(entries: EquityEntry[]): { name: string; value: number; market: string; market_cap: string; sector: string }[] {
    const map = new Map<string, { value: number; market: string; market_cap: string; sector: string }>();
    entries.forEach(e => {
      const sign = e.buy_sell === 'Sell' ? -1 : 1;
      const existing = map.get(e.name) || { value: 0, market: e.market, market_cap: e.market_cap, sector: e.sector };
      map.set(e.name, { ...existing, value: existing.value + sign * (e.value || 0) });
    });
    return [...map.entries()].map(([name, d]) => ({ name, ...d, value: Math.max(0, d.value) }));
  }

  // ── Category Allocation Pie ──

  get categoryAllocationPie(): PieChart {
    const catData: { label: string; value: number }[] = [];

    // Split Equity by market — FIFO cost of remaining lots per stock
    const eqHoldings = this.equityFifoHoldings;
    const eqIndiaVal = eqHoldings.filter(h => h.market === 'India').reduce((s, h) => s + h.value, 0);
    const eqUSAVal   = eqHoldings.filter(h => h.market === 'USA').reduce((s, h) => s + h.value, 0);
    const eqOtherVal = eqHoldings.filter(h => h.market !== 'India' && h.market !== 'USA').reduce((s, h) => s + h.value, 0);

    if (eqIndiaVal > 0) catData.push({ label: 'Equity (India)', value: Math.round(eqIndiaVal * 100) / 100 });
    if (eqUSAVal > 0) catData.push({ label: 'Equity (USA)', value: Math.round(eqUSAVal * 100) / 100 });
    if (eqOtherVal > 0) catData.push({ label: 'Equity (Other)', value: Math.round(eqOtherVal * 100) / 100 });

    const otherCats = [
      { label: 'Mutual Funds', data: this.mfData, fn: (e: MutualFundEntry) => this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value) },
      { label: 'Commodity', data: this.commodityData, fn: (e: CommodityEntry) => this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value) },
      // Only active (not yet matured) FDs
      { label: 'Fixed Deposits', data: this.fdData.filter(e => !e.return_value || e.return_value === 0), fn: (e: FixedDepositEntry) => (e.fd_value || 0) },
    ];
    otherCats.forEach(c => {
      const val = (c.data as any[]).reduce((sum, e) => sum + c.fn(e), 0);
      if (val > 0) catData.push({ label: c.label, value: Math.round(val * 100) / 100 });
    });

    // P2P: use current_invested (outstanding loan principal) — same metric as the KPI card
    const p2pSummary = this.summary['P2P'];
    if (p2pSummary) {
      const p2pVal = (p2pSummary as any).current_invested || 0;
      if (p2pVal > 0) catData.push({ label: 'P2P', value: Math.round(p2pVal * 100) / 100 });
    }

    const total = catData.reduce((s, d) => s + d.value, 0);
    const slices: PieSlice[] = catData.map((d, i) => ({
      label: d.label,
      value: d.value,
      pct: total > 0 ? Math.round((d.value / total) * 1000) / 10 : 0,
      color: PIE_COLORS[i % PIE_COLORS.length]
    })).sort((a, b) => b.pct - a.pct);

    let gradientParts: string[] = [];
    let cumPct = 0;
    slices.forEach(s => {
      const start = cumPct;
      cumPct += s.pct;
      gradientParts.push(`${s.color} ${start}% ${cumPct}%`);
    });
    const gradient = slices.length > 0 ? `conic-gradient(${gradientParts.join(', ')})` : 'conic-gradient(#e2e8f0 0% 100%)';

    return { title: 'Category Allocation', total, slices, gradient };
  }

  // ── Equity Analysis ──

  // Per-stock realized P&L helper: sell value − proportional buy cost.
  // Stocks with no sells contribute 0 (unrealized P&L is unknown without live prices).
  private equityPnL(entries: EquityEntry[]): { name: string; pnl: number; market: string; market_cap: string; sector: string }[] {
    // Collect sells from passed (possibly year-filtered) entries
    const sellsByName = new Map<string, { qty: number; value: number; market: string; market_cap: string; sector: string }>();
    const metaByName = new Map<string, { market: string; market_cap: string; sector: string }>();
    for (const e of entries) {
      metaByName.set(e.name, { market: e.market, market_cap: e.market_cap, sector: e.sector });
      if (e.buy_sell === 'Sell') {
        const d = sellsByName.get(e.name) || { qty: 0, value: 0, market: e.market, market_cap: e.market_cap, sector: e.sector };
        d.qty += e.quantity || 0;
        d.value += e.value || 0;
        sellsByName.set(e.name, d);
      }
    }
    // Build ALL buy lots per stock from all equity data, sorted oldest-first (FIFO)
    const allBuyLots = new Map<string, { date: string; qty: number; value: number }[]>();
    for (const e of this.equityData) {
      if (e.buy_sell === 'Buy') {
        if (!allBuyLots.has(e.name)) allBuyLots.set(e.name, []);
        allBuyLots.get(e.name)!.push({ date: e.date, qty: e.quantity || 0, value: e.value || 0 });
      }
    }
    const result: { name: string; pnl: number; market: string; market_cap: string; sector: string }[] = [];
    // Stocks with no sells → pnl 0
    for (const [name, meta] of metaByName) {
      if (!sellsByName.has(name)) result.push({ name, pnl: 0, ...meta });
    }
    // Stocks with sells → FIFO cost
    for (const [name, sellData] of sellsByName) {
      const lots = [...(allBuyLots.get(name) || [])].sort((a, b) => a.date.localeCompare(b.date));
      let remaining = sellData.qty;
      let fifoCost = 0;
      for (const lot of lots) {
        if (remaining <= 0) break;
        const used = Math.min(lot.qty, remaining);
        fifoCost += used * (lot.qty > 0 ? lot.value / lot.qty : 0);
        remaining -= used;
      }
      result.push({ name, pnl: Math.round((sellData.value - fifoCost) * 100) / 100, market: sellData.market, market_cap: sellData.market_cap, sector: sellData.sector });
    }
    return result;
  }

  private equityEntryValue(e: EquityEntry): number {
    const sign = e.buy_sell === 'Sell' ? -1 : 1;
    switch (this.selectedMetric) {
      case 'Current Holdings': return sign * (e.value || 0);
      case 'Total Investments': return e.buy_sell === 'Buy' ? (e.value || 0) : 0;
      case 'Net P&L': return e.buy_sell === 'Sell' ? (e.value || 0) : -(e.value || 0);
      default: return 0;
    }
  }

  get equityFilteredEntries(): EquityEntry[] {
    return this.selectedYear === 'All'
      ? this.equityData
      : this.equityData.filter(e => this.dateToFY(e.date) === this.selectedYear);
  }

  get equityPnLDiverging(): { dimension: string; items: { label: string; pnl: number; barPct: number }[] }[] {
    const pnlData = this.equityPnL(this.equityFilteredEntries).filter(h => h.pnl !== 0);
    if (pnlData.length === 0) return [];
    const groupBy = (dimension: string, keyFn: (h: { pnl: number; market: string; market_cap: string; sector: string }) => string) => {
      const map = new Map<string, number>();
      pnlData.forEach(h => { const k = keyFn(h) || 'Unknown'; map.set(k, (map.get(k) || 0) + h.pnl); });
      const items = [...map.entries()].map(([label, pnl]) => ({ label, pnl: Math.round(pnl * 100) / 100 }))
        .sort((a, b) => b.pnl - a.pnl);
      const maxAbs = Math.max(...items.map(i => Math.abs(i.pnl)), 1);
      return { dimension, items: items.map(i => ({ ...i, barPct: Math.round(Math.abs(i.pnl) / maxAbs * 100) })) };
    };
    return [
      groupBy('By Market',     h => h.market),
      groupBy('By Market Cap', h => h.market_cap),
      groupBy('By Sector',     h => h.sector),
    ];
  }

  get equityMarketSplit(): { india: number; usa: number; total: number; indiaPct: number; usaPct: number } {
    const entries = this.equityFilteredEntries;
    let india: number, usa: number;
    if (this.selectedMetric === 'Current Holdings') {
      const holdings = this.equityNetHoldings(entries);
      india = holdings.filter(h => h.market === 'India').reduce((s, h) => s + h.value, 0);
      usa   = holdings.filter(h => h.market === 'USA').reduce((s, h) => s + h.value, 0);
    } else if (this.selectedMetric === 'Net P&L') {
      const pnl = this.equityPnL(entries);
      india = pnl.filter(h => h.market === 'India').reduce((s, h) => s + h.pnl, 0);
      usa   = pnl.filter(h => h.market === 'USA').reduce((s, h) => s + h.pnl, 0);
    } else {
      india = entries.filter(e => e.market === 'India').reduce((s, e) => s + this.equityEntryValue(e), 0);
      usa   = entries.filter(e => e.market === 'USA').reduce((s, e) => s + this.equityEntryValue(e), 0);
    }
    const absTotal = Math.abs(india) + Math.abs(usa);
    return {
      india:    Math.round(india * 100) / 100,
      usa:      Math.round(usa * 100) / 100,
      total:    Math.round((india + usa) * 100) / 100,
      indiaPct: absTotal > 0 ? Math.round((Math.abs(india) / absTotal) * 100) : 0,
      usaPct:   absTotal > 0 ? Math.round((Math.abs(usa)   / absTotal) * 100) : 0
    };
  }

  get equityYearlyBreakdown(): { year: string; india: number; usa: number; total: number; indiaPct: number; usaPct: number; barPct: number }[] {
    const entries = this.equityFilteredEntries;
    const years = [...new Set(entries.map(e => this.dateToFY(e.date)).filter(Boolean))].sort();
    const rows = years.map(year => {
      const ye = entries.filter(e => this.dateToFY(e.date) === year);
      let india: number, usa: number;
      if (this.selectedMetric === 'Current Holdings') {
        const holdings = this.equityNetHoldings(ye);
        india = holdings.filter(h => h.market === 'India').reduce((s, h) => s + h.value, 0);
        usa   = holdings.filter(h => h.market === 'USA').reduce((s, h) => s + h.value, 0);
      } else if (this.selectedMetric === 'Net P&L') {
        const pnl = this.equityPnL(ye);
        india = pnl.filter(h => h.market === 'India').reduce((s, h) => s + h.pnl, 0);
        usa   = pnl.filter(h => h.market === 'USA').reduce((s, h) => s + h.pnl, 0);
      } else {
        india = ye.filter(e => e.market === 'India').reduce((s, e) => s + this.equityEntryValue(e), 0);
        usa   = ye.filter(e => e.market === 'USA').reduce((s, e) => s + this.equityEntryValue(e), 0);
      }
      const absTotal = Math.abs(india) + Math.abs(usa);
      return {
        year,
        india:    Math.round(india * 100) / 100,
        usa:      Math.round(usa * 100) / 100,
        total:    Math.round((india + usa) * 100) / 100,
        indiaPct: absTotal > 0 ? Math.round((Math.abs(india) / absTotal) * 100) : 0,
        usaPct:   absTotal > 0 ? Math.round((Math.abs(usa)   / absTotal) * 100) : 0,
        barPct: 0
      };
    }).filter(r => r.india !== 0 || r.usa !== 0);
    const maxAbs = Math.max(...rows.map(r => Math.abs(r.india) + Math.abs(r.usa)), 1);
    return rows.map(r => ({ ...r, barPct: Math.round(((Math.abs(r.india) + Math.abs(r.usa)) / maxAbs) * 100) }));
  }

  get equityMarketCapSplit(): { cap: string; value: number; pct: number; color: string }[] {
    const capOrder = ['Mega Cap', 'Large Cap', 'Mid Cap', 'Small Cap', 'Micro Cap'];
    const capColors: Record<string, string> = {
      'Mega Cap': '#6366f1', 'Large Cap': '#3b82f6', 'Mid Cap': '#10b981',
      'Small Cap': '#f59e0b', 'Micro Cap': '#ef4444'
    };
    const map = new Map<string, number>();
    if (this.selectedMetric === 'Current Holdings') {
      this.equityNetHoldings(this.equityFilteredEntries).forEach(h => {
        const cap = h.market_cap || 'Unknown';
        map.set(cap, (map.get(cap) || 0) + h.value);
      });
    } else if (this.selectedMetric === 'Net P&L') {
      this.equityPnL(this.equityFilteredEntries).forEach(h => {
        const cap = h.market_cap || 'Unknown';
        map.set(cap, (map.get(cap) || 0) + h.pnl);
      });
    } else {
      this.equityFilteredEntries.forEach(e => {
        const cap = e.market_cap || 'Unknown';
        map.set(cap, (map.get(cap) || 0) + this.equityEntryValue(e));
      });
    }
    const absTotal = [...map.values()].reduce((s, v) => s + Math.abs(v), 0);
    return [...map.entries()]
      .filter(([, v]) => v !== 0)
      .sort((a, b) => {
        const ai = capOrder.indexOf(a[0]);
        const bi = capOrder.indexOf(b[0]);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })
      .map(([cap, val]) => ({
        cap,
        value: Math.round(val * 100) / 100,
        pct:   absTotal > 0 ? Math.round((Math.abs(val) / absTotal) * 100) : 0,
        color: capColors[cap] || '#94a3b8'
      }));
  }

  get equitySectorData(): { sector: string; value: number; pct: number; color: string }[] {
    const map = new Map<string, number>();
    if (this.selectedMetric === 'Current Holdings') {
      this.equityNetHoldings(this.equityFilteredEntries).forEach(h => {
        const sector = h.sector || 'Unknown';
        map.set(sector, (map.get(sector) || 0) + h.value);
      });
    } else if (this.selectedMetric === 'Net P&L') {
      this.equityPnL(this.equityFilteredEntries).forEach(h => {
        const sector = h.sector || 'Unknown';
        map.set(sector, (map.get(sector) || 0) + h.pnl);
      });
    } else {
      this.equityFilteredEntries.forEach(e => {
        const sector = e.sector || 'Unknown';
        map.set(sector, (map.get(sector) || 0) + this.equityEntryValue(e));
      });
    }
    const absTotal = [...map.values()].reduce((s, v) => s + Math.abs(v), 0);
    return [...map.entries()]
      .filter(([, v]) => v !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([sector, val], i) => ({
        sector,
        value: Math.round(val * 100) / 100,
        pct:   absTotal > 0 ? Math.round((Math.abs(val) / absTotal) * 100) : 0,
        color: PIE_COLORS[i % PIE_COLORS.length]
      }));
  }

  // ── Mutual Fund Analysis ──

  // Cost-per-unit map built from ALL buy rows (used for correct per-row Net P&L on sell rows)
  private get mfCostPerUnitMap(): Map<string, number> {
    const agg = new Map<string, { buyQty: number; buyVal: number }>();
    this.mfData.forEach(e => {
      if ((e.buy_quantity || 0) > 0) {
        const d = agg.get(e.name) || { buyQty: 0, buyVal: 0 };
        d.buyQty += e.buy_quantity || 0; d.buyVal += e.buy_value || 0;
        agg.set(e.name, d);
      }
    });
    const out = new Map<string, number>();
    agg.forEach((d, name) => out.set(name, d.buyQty > 0 ? d.buyVal / d.buyQty : 0));
    return out;
  }

  private mfEntryValue(e: MutualFundEntry): number {
    switch (this.selectedMetric) {
      case 'Current Holdings': return this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value);
      case 'Total Investments': return e.buy_value || 0;
      case 'Net P&L': {
        if (!(e.sell_quantity || 0)) return 0; // no realized P&L if nothing sold
        const costPerUnit = this.mfCostPerUnitMap.get(e.name) || 0;
        return (e.sell_value || 0) - costPerUnit * (e.sell_quantity || 0);
      }
      default: return 0;
    }
  }

  get mfFilteredEntries(): MutualFundEntry[] {
    return this.selectedYear === 'All' ? this.mfData : this.mfData.filter(e => e.year === this.selectedYear);
  }

  get mfCategorySplit(): { cat: string; value: number; pct: number; color: string }[] {
    const colors: Record<string, string> = {
      'Equity': '#3b82f6', 'Debt': '#10b981', 'Hybrid': '#8b5cf6',
      'Index': '#f59e0b', 'ELSS': '#ef4444', 'Sectoral': '#f97316'
    };
    const order = ['Equity', 'ELSS', 'Index', 'Sectoral', 'Hybrid', 'Debt'];
    const map = new Map<string, number>();
    this.mfFilteredEntries.forEach(e => {
      const cat = e.category || 'Other';
      map.set(cat, (map.get(cat) || 0) + this.mfEntryValue(e));
    });
    const absTotal = [...map.values()].reduce((s, v) => s + Math.abs(v), 0);
    return [...map.entries()]
      .filter(([, v]) => v !== 0)
      .sort((a, b) => { const ai = order.indexOf(a[0]); const bi = order.indexOf(b[0]); return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi); })
      .map(([cat, val], i) => ({ cat, value: Math.round(val * 100) / 100, pct: absTotal > 0 ? Math.round((Math.abs(val) / absTotal) * 100) : 0, color: colors[cat] || PIE_COLORS[i % PIE_COLORS.length] }));
  }

  get mfFundTypeSplit(): { type: string; value: number; pct: number; color: string }[] {
    const map = new Map<string, number>();
    this.mfFilteredEntries.forEach(e => {
      const t = e.fund_type || 'Other';
      map.set(t, (map.get(t) || 0) + this.mfEntryValue(e));
    });
    const absTotal = [...map.values()].reduce((s, v) => s + Math.abs(v), 0);
    return [...map.entries()]
      .filter(([, v]) => v !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([type, val], i) => ({ type, value: Math.round(val * 100) / 100, pct: absTotal > 0 ? Math.round((Math.abs(val) / absTotal) * 100) : 0, color: PIE_COLORS[i % PIE_COLORS.length] }));
  }

  get mfYearlyBreakdown(): { year: string; total: number; barPct: number; segments: { cat: string; pct: number; color: string }[] }[] {
    const colors: Record<string, string> = { 'Equity': '#3b82f6', 'Debt': '#10b981', 'Hybrid': '#8b5cf6', 'Index': '#f59e0b', 'ELSS': '#ef4444', 'Sectoral': '#f97316' };
    const entries = this.mfFilteredEntries;
    const years = [...new Set(entries.map(e => e.year).filter(Boolean))].sort();
    const rows = years.map(year => {
      const ye = entries.filter(e => e.year === year);
      const cMap = new Map<string, number>();
      ye.forEach(e => { const cat = e.category || 'Other'; cMap.set(cat, (cMap.get(cat) || 0) + this.mfEntryValue(e)); });
      const total = [...cMap.values()].reduce((s, v) => s + Math.abs(v), 0);
      const segments = [...cMap.entries()].filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([cat, val]) => ({ cat, pct: total > 0 ? Math.round((Math.abs(val) / total) * 100) : 0, color: colors[cat] || '#94a3b8' }));
      return { year, total: Math.round(total * 100) / 100, barPct: 0, segments };
    }).filter(r => r.total !== 0);
    const maxTotal = Math.max(...rows.map(r => r.total), 1);
    return rows.map(r => ({ ...r, barPct: Math.round((r.total / maxTotal) * 100) }));
  }

  get mfTopFunds(): { name: string; value: number; pct: number; color: string }[] {
    const map = new Map<string, number>();
    this.mfFilteredEntries.forEach(e => {
      const name = e.name || 'Unknown';
      map.set(name, (map.get(name) || 0) + this.mfEntryValue(e));
    });
    const absTotal = [...map.values()].reduce((s, v) => s + Math.abs(v), 0);
    return [...map.entries()].filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([name, val], i) => ({ name, value: Math.round(val * 100) / 100, pct: absTotal > 0 ? Math.round((Math.abs(val) / absTotal) * 100) : 0, color: PIE_COLORS[i % PIE_COLORS.length] }));
  }

  // ── Commodity Analysis ──

  // Cost-per-unit map built from ALL buy rows (used for correct per-row Net P&L on sell rows)
  private get commCostPerUnitMap(): Map<string, number> {
    const agg = new Map<string, { buyQty: number; buyVal: number }>();
    this.commodityData.forEach(e => {
      if ((e.buy_quantity || 0) > 0) {
        const d = agg.get(e.name) || { buyQty: 0, buyVal: 0 };
        d.buyQty += e.buy_quantity || 0; d.buyVal += e.buy_value || 0;
        agg.set(e.name, d);
      }
    });
    const out = new Map<string, number>();
    agg.forEach((d, name) => out.set(name, d.buyQty > 0 ? d.buyVal / d.buyQty : 0));
    return out;
  }

  private commEntryValue(e: CommodityEntry): number {
    switch (this.selectedMetric) {
      case 'Current Holdings': return this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value);
      case 'Total Investments': return e.buy_value || 0;
      case 'Net P&L': {
        if (!(e.sell_quantity || 0)) return 0; // no realized P&L if nothing sold
        const costPerUnit = this.commCostPerUnitMap.get(e.name) || 0;
        return (e.sell_value || 0) - costPerUnit * (e.sell_quantity || 0);
      }
      default: return 0;
    }
  }

  get commFilteredEntries(): CommodityEntry[] {
    return this.selectedYear === 'All' ? this.commodityData : this.commodityData.filter(e => e.year === this.selectedYear);
  }

  get commCommoditySplit(): { commodity: string; value: number; pct: number; color: string }[] {
    const colors: Record<string, string> = { 'Gold': '#f59e0b', 'Silver': '#94a3b8', 'Crude Oil': '#78716c', 'Natural Gas': '#3b82f6', 'Copper': '#f97316', 'Other': '#8b5cf6' };
    const map = new Map<string, number>();
    this.commFilteredEntries.forEach(e => { const c = e.commodity || 'Other'; map.set(c, (map.get(c) || 0) + this.commEntryValue(e)); });
    const absTotal = [...map.values()].reduce((s, v) => s + Math.abs(v), 0);
    return [...map.entries()].filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([commodity, val], i) => ({ commodity, value: Math.round(val * 100) / 100, pct: absTotal > 0 ? Math.round((Math.abs(val) / absTotal) * 100) : 0, color: colors[commodity] || PIE_COLORS[i % PIE_COLORS.length] }));
  }

  get commYearlyBreakdown(): { year: string; total: number; barPct: number; segments: { commodity: string; pct: number; color: string }[] }[] {
    const colors: Record<string, string> = { 'Gold': '#f59e0b', 'Silver': '#94a3b8', 'Crude Oil': '#78716c', 'Natural Gas': '#3b82f6', 'Copper': '#f97316', 'Other': '#8b5cf6' };
    const entries = this.commFilteredEntries;
    const years = [...new Set(entries.map(e => e.year).filter(Boolean))].sort();
    const rows = years.map(year => {
      const ye = entries.filter(e => e.year === year);
      const cMap = new Map<string, number>();
      ye.forEach(e => { const c = e.commodity || 'Other'; cMap.set(c, (cMap.get(c) || 0) + this.commEntryValue(e)); });
      const total = [...cMap.values()].reduce((s, v) => s + Math.abs(v), 0);
      const segments = [...cMap.entries()].filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([commodity, val]) => ({ commodity, pct: total > 0 ? Math.round((Math.abs(val) / total) * 100) : 0, color: colors[commodity] || '#94a3b8' }));
      return { year, total: Math.round(total * 100) / 100, barPct: 0, segments };
    }).filter(r => r.total !== 0);
    const maxTotal = Math.max(...rows.map(r => r.total), 1);
    return rows.map(r => ({ ...r, barPct: Math.round((r.total / maxTotal) * 100) }));
  }

  get commTopInstruments(): { name: string; commodity: string; value: number; pct: number; color: string }[] {
    const colors: Record<string, string> = { 'Gold': '#f59e0b', 'Silver': '#94a3b8', 'Crude Oil': '#78716c', 'Natural Gas': '#3b82f6', 'Copper': '#f97316', 'Other': '#8b5cf6' };
    const map = new Map<string, { val: number; commodity: string }>();
    this.commFilteredEntries.forEach(e => {
      const name = e.name || 'Unknown';
      const existing = map.get(name) || { val: 0, commodity: e.commodity || 'Other' };
      map.set(name, { val: existing.val + this.commEntryValue(e), commodity: existing.commodity });
    });
    const absTotal = [...map.values()].reduce((s, v) => s + Math.abs(v.val), 0);
    return [...map.entries()].filter(([, v]) => v.val !== 0).sort((a, b) => Math.abs(b[1].val) - Math.abs(a[1].val)).map(([name, v]) => ({ name, commodity: v.commodity, value: Math.round(v.val * 100) / 100, pct: absTotal > 0 ? Math.round((Math.abs(v.val) / absTotal) * 100) : 0, color: colors[v.commodity] || '#94a3b8' }));
  }

  // ── P2P Analysis ──

  private dateToFY(dateStr: string): string {
    if (!dateStr) return 'Unknown';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return 'Unknown';
      const m = d.getMonth() + 1;
      const fyYear = m >= 4 ? d.getFullYear() + 1 : d.getFullYear();
      return 'FY' + String(fyYear).slice(-2);
    } catch { return 'Unknown'; }
  }

  private get p2pRepaidMap(): Map<string, number> {
    const map = new Map<string, number>();
    this.p2pRepayments.forEach(r => { map.set(r.lending_id, (map.get(r.lending_id) || 0) + (r.amount || 0)); });
    return map;
  }

  private p2pEntryValue(e: P2PEntry): number {
    const repaid = this.p2pRepaidMap.get(e.lending_id) || 0;
    switch (this.selectedMetric) {
      case 'Current Holdings': return Math.max(0, (e.amount || 0) - repaid);
      case 'Total Investments': return e.amount || 0;
      // Active loans have unknown final outcome — only show realized P&L for completed/defaulted
      case 'Net P&L': return e.status !== 'Active' ? repaid - (e.amount || 0) : 0;
      default: return 0;
    }
  }

  get p2pFilteredEntries(): P2PEntry[] {
    if (this.selectedYear === 'All') return this.p2pData;
    return this.p2pData.filter(e => this.dateToFY(e.date) === this.selectedYear);
  }

  get p2pPlatformSplit(): { platform: string; value: number; pct: number; color: string }[] {
    const map = new Map<string, number>();
    this.p2pFilteredEntries.forEach(e => { const p = e.platform || 'Other'; map.set(p, (map.get(p) || 0) + this.p2pEntryValue(e)); });
    const absTotal = [...map.values()].reduce((s, v) => s + Math.abs(v), 0);
    return [...map.entries()].filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([platform, val], i) => ({ platform, value: Math.round(val * 100) / 100, pct: absTotal > 0 ? Math.round((Math.abs(val) / absTotal) * 100) : 0, color: PIE_COLORS[i % PIE_COLORS.length] }));
  }

  get p2pStatusSplit(): { status: string; value: number; pct: number; color: string }[] {
    const colors: Record<string, string> = { 'Active': '#10b981', 'Completed': '#6366f1', 'Defaulted': '#ef4444', 'Delayed': '#f59e0b' };
    const map = new Map<string, number>();
    this.p2pFilteredEntries.forEach(e => { const s = e.status || 'Other'; map.set(s, (map.get(s) || 0) + (e.amount || 0)); });
    const absTotal = [...map.values()].reduce((s, v) => s + Math.abs(v), 0);
    return [...map.entries()].filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([status, val]) => ({ status, value: Math.round(val * 100) / 100, pct: absTotal > 0 ? Math.round((Math.abs(val) / absTotal) * 100) : 0, color: colors[status] || '#94a3b8' }));
  }

  get p2pYearlyBreakdown(): { year: string; total: number; barPct: number }[] {
    const map = new Map<string, number>();
    this.p2pFilteredEntries.forEach(e => { const fy = this.dateToFY(e.date); map.set(fy, (map.get(fy) || 0) + this.p2pEntryValue(e)); });
    const rows = [...map.entries()].filter(([, v]) => v !== 0).sort((a, b) => a[0].localeCompare(b[0])).map(([year, val]) => ({ year, total: Math.round(val * 100) / 100, barPct: 0 }));
    const maxTotal = Math.max(...rows.map(r => Math.abs(r.total)), 1);
    return rows.map(r => ({ ...r, barPct: Math.round((Math.abs(r.total) / maxTotal) * 100) }));
  }

  get p2pRepaidVsOutstanding(): { repaid: number; outstanding: number; total: number; repaidPct: number; outstandingPct: number } {
    let lent = 0; let repaid = 0;
    this.p2pFilteredEntries.forEach(e => { lent += e.amount || 0; repaid += this.p2pRepaidMap.get(e.lending_id) || 0; });
    const outstanding = Math.max(0, lent - repaid);
    const repaidPct = lent > 0 ? Math.round((Math.min(repaid, lent) / lent) * 100) : 0;
    return { repaid: Math.round(repaid * 100) / 100, outstanding: Math.round(outstanding * 100) / 100, total: Math.round(lent * 100) / 100, repaidPct, outstandingPct: 100 - repaidPct };
  }

  get hasCustomAnalysis(): boolean {
    return ['Equity', 'Mutual Funds', 'Commodity', 'P2P'].includes(this.selectedCategory);
  }

  // ── Category Selection ──

  getTargetAllocation(label: string): number | null {
    return this.targetAllocation[label] ?? null;
  }

  getAllocationFlag(slice: PieSlice): string {
    const target = this.targetAllocation[slice.label];
    if (target == null) return '';
    const variance = Math.abs(slice.pct - target) / target * 100;
    if (variance < 10) return '✔';
    const diff = slice.pct - target;
    return diff > 0 ? '▲' : '▼';
  }

  getAllocationFlagColor(slice: PieSlice): string {
    const target = this.targetAllocation[slice.label];
    if (target == null) return 'inherit';
    const variance = Math.abs(slice.pct - target) / target * 100;
    if (variance < 10) return '#4caf50';
    if (variance < 25) return '#f59e0b';
    return '#ef4444';
  }

  selectCategory(key: string): void {
    this.selectedCategory = key;
  }

  selectMetric(metric: string): void {
    this.selectedMetric = metric;
  }

  // ── Category-Level Summary ──

  get catCurrentInvestment(): number {
    if (this.selectedCategory === 'P2P') {
      return (this.summary['P2P'] as any)?.current_invested || 0;
    }
    if (this.selectedCategory === 'Equity') {
      return Math.round(this.equityFifoHoldings.reduce((s, h) => s + h.value, 0) * 100) / 100;
    }
    // MF and Commodity: aggregate per instrument name to correctly apply calcInvestment
    if (this.selectedCategory === 'Mutual Funds' || this.selectedCategory === 'Commodity') {
      const yearFilter = (e: any) => this.selectedYear === 'All' || e.year === this.selectedYear;
      const data = this.selectedCategory === 'Mutual Funds'
        ? this.mfData.filter(yearFilter)
        : this.commodityData.filter(yearFilter);
      const byName = new Map<string, { buyQty: number; buyVal: number; sellQty: number }>();
      data.forEach((e: any) => {
        const d = byName.get(e.name) || { buyQty: 0, buyVal: 0, sellQty: 0 };
        if (e.buy_sell === 'Buy') { d.buyQty += e.buy_quantity || 0; d.buyVal += e.buy_value || 0; }
        else { d.sellQty += e.sell_quantity || 0; }
        byName.set(e.name, d);
      });
      let total = 0;
      byName.forEach(d => { total += this.calcInvestment(d.buyQty, d.sellQty, d.buyVal); });
      return Math.round(total * 100) / 100;
    }
    return this.catEntries.reduce((sum, e) => sum + this.calcInvestment(e.buyQty, e.sellQty, e.buyVal), 0);
  }

  get catTotalInvested(): number {
    return this.catEntries.reduce((sum, e) => sum + (e.buyVal || 0), 0);
  }

  get catTotalSales(): number {
    if (this.selectedCategory === 'P2P') {
      return this.p2pRepayments.reduce((sum, r) => sum + (r.amount || 0), 0);
    }
    return this.catEntries.reduce((sum, e) => sum + (e.sellVal || 0), 0);
  }

  get catNetPnL(): number {
    return this.catTotalSales - (this.catTotalInvested - this.catCurrentInvestment);
  }

  get catCostOfSold(): number {
    return Math.round((this.catTotalInvested - this.catCurrentInvestment) * 100) / 100;
  }

  get catNetPnLPct(): number {
    const exitedValue = this.catTotalInvested - this.catCurrentInvestment;
    return exitedValue > 0 ? Math.round((this.catNetPnL / exitedValue) * 10000) / 100 : 0;
  }

  // Normalize all category entries to a common shape for calculations
  private get catEntries(): { group: Record<string, string>; buyQty: number | null; sellQty: number | null; buyVal: number | null; sellVal: number | null }[] {
    const yearFilter = (e: any) => this.selectedYear === 'All' || e.year === this.selectedYear;
    switch (this.selectedCategory) {
      case 'Equity':
        return this.equityData.filter(e => this.dateToFY(e.date) === this.selectedYear || this.selectedYear === 'All').map(e => ({
          group: { FY: this.dateToFY(e.date) || 'N/A', Market: e.market, 'Market Cap': e.market_cap, Sector: e.sector },
          buyQty: e.buy_sell === 'Buy' ? (e.quantity || 0) : null,
          sellQty: e.buy_sell === 'Sell' ? (e.quantity || 0) : null,
          buyVal: e.buy_sell === 'Buy' ? (e.value || 0) : null,
          sellVal: e.buy_sell === 'Sell' ? (e.value || 0) : null
        }));
      case 'Mutual Funds':
        return this.mfData.filter(yearFilter).map(e => ({ group: { Year: e.year || 'N/A', Category: e.category, 'Fund Type': e.fund_type }, buyQty: e.buy_quantity, sellQty: e.sell_quantity, buyVal: e.buy_value, sellVal: e.sell_value }));
      case 'Commodity':
        return this.commodityData.filter(yearFilter).map(e => ({ group: { Year: e.year || 'N/A', Commodity: e.commodity }, buyQty: e.buy_quantity, sellQty: e.sell_quantity, buyVal: e.buy_value, sellVal: e.sell_value }));
      case 'P2P':
        return this.p2pData.map(e => {
          const repaid = this.p2pRepayments.filter(r => r.lending_id === e.lending_id).reduce((s, r) => s + (r.amount || 0), 0);
          const pending = Math.max(0, (e.amount || 0) - repaid);
          // Use pending as "current" via buyQty/sellQty trick: buyVal=amount, calcInvestment returns pending
          const buyQty = e.amount || 0;
          const sellQty = repaid;
          return { group: { Platform: e.platform, Status: e.status }, buyQty, sellQty, buyVal: e.amount, sellVal: repaid };
        });
      case 'Fixed Deposits':
        // sellQty = buyQty when matured so calcInvestment returns 0 for matured FDs
        return this.fdData.filter(yearFilter).map(e => ({ group: { Year: e.year || 'N/A', Platform: e.platform, Bank: e.bank_name }, buyQty: e.fd_value, sellQty: (e.return_value && e.return_value > 0 ? e.fd_value : 0) as any, buyVal: e.fd_value, sellVal: e.return_value }));
      default:
        return [];
    }
  }

  get groupDimensions(): string[] {
    const entries = this.catEntries;
    if (entries.length === 0) return [];
    return Object.keys(entries[0].group);
  }

  // ── Pie Charts ──

  get pieCharts(): PieChart[] {
    return this.groupDimensions.map(dim => this.buildPieChart(dim));
  }

  private buildPieChart(dimension: string): PieChart {
    const entries = this.catEntries;
    const map = new Map<string, number>();

    entries.forEach(e => {
      const key = e.group[dimension] || 'Unknown';
      const existing = map.get(key) || 0;
      let val = 0;
      switch (this.selectedMetric) {
        case 'Current Holdings':
          val = this.calcInvestment(e.buyQty, e.sellQty, e.buyVal);
          break;
        case 'Total Investments':
          val = e.buyVal || 0;
          break;
        case 'Net P&L': {
          const ci = this.calcInvestment(e.buyQty, e.sellQty, e.buyVal);
          const ti = e.buyVal || 0;
          const ts = e.sellVal || 0;
          val = ts - (ti - ci);
          break;
        }
      }
      map.set(key, existing + val);
    });

    const sorted = Array.from(map.entries())
      .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    const total = sorted.reduce((s, item) => s + Math.abs(item.value), 0);

    const slices: PieSlice[] = sorted.map((item, i) => ({
      label: item.label,
      value: item.value,
      pct: total > 0 ? Math.round((Math.abs(item.value) / total) * 1000) / 10 : 0,
      color: PIE_COLORS[i % PIE_COLORS.length]
    }));

    // Build conic-gradient
    let gradientParts: string[] = [];
    let cumPct = 0;
    slices.forEach(slice => {
      const start = cumPct;
      cumPct += slice.pct;
      gradientParts.push(`${slice.color} ${start}% ${cumPct}%`);
    });
    const gradient = slices.length > 0 ? `conic-gradient(${gradientParts.join(', ')})` : 'conic-gradient(#e2e8f0 0% 100%)';

    return { title: dimension, total, slices, gradient };
  }

  // ── Bar Charts (for Net P&L) ──

  get barCharts(): BarChart[] {
    return this.groupDimensions.map(dim => this.buildBarChart(dim));
  }

  private buildBarChart(dimension: string): BarChart {
    const entries = this.catEntries;
    const pnlMap = new Map<string, number>();
    const exitedMap = new Map<string, number>();

    entries.forEach(e => {
      const key = e.group[dimension] || 'Unknown';
      const ci = this.calcInvestment(e.buyQty, e.sellQty, e.buyVal);
      const ti = e.buyVal || 0;
      const ts = e.sellVal || 0;
      pnlMap.set(key, (pnlMap.get(key) || 0) + (ts - (ti - ci)));
      exitedMap.set(key, (exitedMap.get(key) || 0) + (ti - ci));
    });

    const sorted = Array.from(pnlMap.entries())
      .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100, exited: exitedMap.get(label) || 0 }))
      .sort((a, b) => b.value - a.value);

    const maxAbs = Math.max(...sorted.map(s => Math.abs(s.value)), 1);
    const totalProfit = sorted.filter(s => s.value > 0).reduce((sum, s) => sum + s.value, 0);
    const totalLoss = sorted.filter(s => s.value < 0).reduce((sum, s) => sum + s.value, 0);
    const totalExited = sorted.reduce((sum, s) => sum + s.exited, 0);
    const netTotal = Math.round((totalProfit + totalLoss) * 100) / 100;

    const items: BarItem[] = sorted.map(s => ({
      label: s.label,
      value: s.value,
      pct: Math.round((Math.abs(s.value) / maxAbs) * 100),
      pnlPct: s.exited > 0 ? Math.round((s.value / s.exited) * 10000) / 100 : 0,
      isPositive: s.value >= 0
    }));

    const netPnLPct = totalExited > 0 ? Math.round((netTotal / totalExited) * 10000) / 100 : 0;

    return { title: dimension, items, maxAbs, totalProfit: Math.round(totalProfit * 100) / 100, totalLoss: Math.round(totalLoss * 100) / 100, netTotal, netPnLPct };
  }

  // ── Forex Analysis ──

  toggleForexPopup(): void {
    this.showForexPopup = !this.showForexPopup;
  }

  private getAvgDepositRate(tradeDate: string): number | null {
    const deposits = this.forexData
      .filter(e => e.type === 'Deposit' && (e.rate || 0) > 0 && e.date <= tradeDate)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3);
    if (deposits.length === 0) return null;
    return deposits.reduce((s, e) => s + (e.rate || 0), 0) / deposits.length;
  }

  get forexWeightedAvgDepositRate(): number | null {
    // Weighted average rate across ALL deposits, weighted by USD amount deposited
    const deposits = this.forexData.filter(e => e.type === 'Deposit' && (e.rate || 0) > 0 && (e.usd_amount || 0) > 0);
    if (deposits.length === 0) return null;
    const totalUSD = deposits.reduce((s, e) => s + (e.usd_amount || 0), 0);
    const weightedSum = deposits.reduce((s, e) => s + (e.usd_amount || 0) * (e.rate || 0), 0);
    return weightedSum / totalUSD;
  }

  get forexWalletBalanceUSD(): number {
    const depositsUSD = this.forexData.filter(e => e.type === 'Deposit').reduce((s, e) => s + (e.usd_amount || 0), 0);
    const withdrawalsUSD = this.forexData.filter(e => e.type === 'Withdrawal').reduce((s, e) => s + (e.usd_amount || 0), 0);
    return depositsUSD - this.forexTotalInvestedUSD - withdrawalsUSD;
  }

  get forexTotalInvestedUSD(): number {
    const usaEquity = this.equityData.filter(e => e.market === 'USA');
    const totalBuyINR = usaEquity.filter(e => e.buy_sell === 'Buy').reduce((s, e) => s + (e.value || 0), 0);
    const totalSellINR = usaEquity.filter(e => e.buy_sell === 'Sell').reduce((s, e) => s + (e.value || 0), 0);
    const avgRate = this.forexWeightedAvgDepositRate || this.forexAvgDepositRate;
    if (!avgRate || avgRate <= 0) return 0;
    return Math.round(((totalBuyINR - totalSellINR) / avgRate) * 100) / 100;
  }

  private get forexAvgDepositRate(): number {
    const deposits = this.forexData.filter(e => e.type === 'Deposit' && (e.rate || 0) > 0);
    if (deposits.length === 0) return 0;
    return deposits.reduce((s, e) => s + (e.rate || 0), 0) / deposits.length;
  }

  get forexLatestRate(): number {
    const entries = this.forexData.filter(e => (e.rate || 0) > 0);
    if (entries.length === 0) return 0;
    return entries.reduce((a, b) => (a.date >= b.date ? a : b)).rate || 0;
  }

  get forexWalletBalanceINR(): number {
    const rate = this.forexLatestRate;
    if (!rate) return 0;
    return Math.round(this.forexWalletBalanceUSD * rate * 100) / 100;
  }

  // P&L before forex: pure stock performance converted at uniform avg deposit rate
  get forexPnLBeforeForex(): number {
    const usaEquity = this.equityData.filter(e => e.market === 'USA');
    const totalBuy = usaEquity.filter(e => e.buy_sell === 'Buy').reduce((s, e) => s + (e.value || 0), 0);
    const totalSell = usaEquity.filter(e => e.buy_sell === 'Sell').reduce((s, e) => s + (e.value || 0), 0);
    const currentInv = totalBuy - totalSell;
    return Math.round((totalSell - (totalBuy - currentInv)) * 100) / 100;
  }

  // Forex impact: gain/loss due to rate difference on withdrawals
  // (Actual INR received from withdrawals) - (withdrawals in USD * avg deposit rate)
  get forexImpact(): number {
    const totalWithdrawalINR = this.forexData.filter(e => e.type === 'Withdrawal').reduce((s, e) => s + (e.inr_amount || 0), 0);
    const totalWithdrawalUSD = this.forexData.filter(e => e.type === 'Withdrawal').reduce((s, e) => s + (e.usd_amount || 0), 0);
    const avgDepRate = this.forexAvgDepositRate;
    if (avgDepRate <= 0) return 0;
    return Math.round((totalWithdrawalINR - (totalWithdrawalUSD * avgDepRate)) * 100) / 100;
  }

  // P&L after forex: stock P&L + forex impact on withdrawals
  get forexPnLAfterForex(): number {
    return Math.round((this.forexPnLBeforeForex + this.forexImpact) * 100) / 100;
  }

  abs(n: number): number { return Math.abs(n); }

  get forexCurrentHoldingsUSD(): number {
    return this.forexTotalInvestedUSD;
  }

  get forexCurrentHoldingsINR(): number {
    const rate = this.forexWeightedAvgDepositRate;
    if (!rate) return 0;
    return Math.round(this.forexCurrentHoldingsUSD * rate * 100) / 100;
  }

  get forexTotalBuyUSD(): number {
    const usaEquity = this.equityData.filter(e => e.market === 'USA' && e.buy_sell === 'Buy');
    const totalBuyUSD = usaEquity.reduce((s, e) => s + (e.value_usd || 0), 0);
    if (totalBuyUSD > 0) return Math.round(totalBuyUSD * 100) / 100;
    // Fallback: convert INR using avg deposit rate
    const totalBuyINR = usaEquity.reduce((s, e) => s + (e.value || 0), 0);
    const avgRate = this.forexAvgDepositRate;
    if (avgRate <= 0) return 0;
    return Math.round((totalBuyINR / avgRate) * 100) / 100;
  }

  get forexTotalSalesUSD(): number {
    const usaEquity = this.equityData.filter(e => e.market === 'USA' && e.buy_sell === 'Sell');
    const totalSellUSD = usaEquity.reduce((s, e) => s + (e.value_usd || 0), 0);
    if (totalSellUSD > 0) return Math.round(totalSellUSD * 100) / 100;
    const totalSellINR = usaEquity.reduce((s, e) => s + (e.value || 0), 0);
    const avgRate = this.forexAvgDepositRate;
    if (avgRate <= 0) return 0;
    return Math.round((totalSellINR / avgRate) * 100) / 100;
  }

  // ── AI Chat ──
  chatMessages: { role: 'user' | 'assistant'; content: string; html: string; time: Date }[] = [];
  chatInput = '';
  chatLoading = false;
  chatError = '';

  readonly QUICK_PROMPTS = [
    'Analyze my full portfolio',
    'Where am I overexposed?',
    'What should I rebalance?',
    'How diversified am I?',
    'What are my biggest risks?',
  ];

  private restoreAICache(): void {
    const h = this.investmentService.chatHistory;
    if (h.length) {
      this.chatMessages = h.map(m => ({ ...m, html: m.html || this.markdownToHtml(m.content) }));
    }
  }

  sendQuickPrompt(prompt: string): void {
    this.chatInput = prompt;
    this.sendMessage();
  }

  sendMessage(): void {
    const text = this.chatInput.trim();
    if (!text || this.chatLoading) return;
    this.chatInput = '';
    this.chatError = '';

    const userMsg = { role: 'user' as const, content: text, html: this.escapeHtml(text), time: new Date() };
    this.chatMessages.push(userMsg);
    this.chatLoading = true;
    this.scrollChat();

    const history = this.chatMessages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    this.investmentService.sendChatMessage(text, history).subscribe({
      next: (res) => {
        const assistantMsg = { role: 'assistant' as const, content: res.reply, html: this.markdownToHtml(res.reply), time: new Date() };
        this.chatMessages.push(assistantMsg);
        this.investmentService.chatHistory = [...this.chatMessages];
        this.chatLoading = false;
        this.scrollChat();
      },
      error: (err) => {
        this.chatError = err.error?.error || 'Failed to get response. Please try again.';
        this.chatMessages.pop(); // remove the user message on error
        this.chatLoading = false;
      }
    });
  }

  clearChat(): void {
    this.chatMessages = [];
    this.investmentService.chatHistory = [];
    this.chatError = '';
  }

  private scrollChat(): void {
    setTimeout(() => {
      const el = document.querySelector('.chat-messages');
      if (el) el.scrollTop = el.scrollHeight;
    }, 50);
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private markdownToHtml(md: string): string {
    return md
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
  }
}

