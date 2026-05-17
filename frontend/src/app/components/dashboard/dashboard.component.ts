import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
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

const TARGET_ALLOCATION: Record<string, number> = {
  'Equity (India)': 35,
  'Equity (USA)': 30,
  'Mutual Funds': 20,
  'Commodity': 10,
  'P2P': 5
};

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss'
})
export class DashboardComponent implements OnInit {
  summary: Summary = {};
  loading = true;
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
  selectedMetric = 'Current Investment';
  selectedYear = 'All';

  metrics = ['Current Investment', 'Total Invested', 'Total Sales', 'Net P&L'];

  categories: CategoryDef[] = [
    { key: 'Equity', route: '/equity', icon: '📈' },
    { key: 'Mutual Funds', route: '/mutual-funds', icon: '📊' },
    { key: 'Commodity', route: '/commodity', icon: '🥇' },
    { key: 'P2P', route: '/p2p', icon: '🤝' },
    { key: 'Fixed Deposits', route: '/fixed-deposits', icon: '🏦' },
    { key: 'Forex', route: '/forex', icon: '💱' },
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
    [...this.equityData, ...this.commodityData, ...this.mfData, ...this.fdData]
      .forEach((e: any) => { if (e.year) years.add(e.year); });
    return ['All', ...Array.from(years).sort()];
  }

  selectYear(year: string): void {
    this.selectedYear = year;
  }

  // ── Global KPIs ──

  private calcInvestment(buyQty: number | null, sellQty: number | null, buyValue: number | null): number {
    const bq = buyQty || 0;
    const sq = sellQty || 0;
    if (bq <= sq) return 0;
    const pricePerUnit = bq > 0 ? (buyValue || 0) / bq : 0;
    return pricePerUnit * (bq - sq);
  }

  get currentInvestment(): number {
    let total = 0;
    total += this.equityData.reduce((sum, e) => sum + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
    total += this.mfData.reduce((sum, e) => sum + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
    total += this.commodityData.reduce((sum, e) => sum + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
    // P2P: use backend-computed pending (amount - repaid)
    const p2pSummary = this.summary['P2P'];
    if (p2pSummary) {
      total += (p2pSummary as any).current_invested || 0;
    }
    total += this.fdData.reduce((sum, e) => sum + (e.fd_value || 0), 0);
    return Math.round(total * 100) / 100;
  }

  get totalInvestment(): number {
    return Object.values(this.summary).reduce((sum, s) => sum + s.total_buy, 0);
  }

  get totalSaleValue(): number {
    return Object.values(this.summary).reduce((sum, s) => sum + s.total_sell, 0);
  }

  get netPnL(): number {
    return this.totalSaleValue - (this.totalInvestment - this.currentInvestment);
  }

  get netPnLPct(): number {
    const exitedValue = this.totalInvestment - this.currentInvestment;
    return exitedValue > 0 ? Math.round((this.netPnL / exitedValue) * 10000) / 100 : 0;
  }

  // ── Category Allocation Pie ──

  get categoryAllocationPie(): PieChart {
    const catData: { label: string; value: number }[] = [];

    // Split Equity by market (India / USA / Other)
    const equityIndia = this.equityData.filter(e => e.market === 'India');
    const equityUSA = this.equityData.filter(e => e.market === 'USA');
    const equityOther = this.equityData.filter(e => e.market !== 'India' && e.market !== 'USA');

    const eqIndiaVal = equityIndia.reduce((sum, e) => sum + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
    const eqUSAVal = equityUSA.reduce((sum, e) => sum + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
    const eqOtherVal = equityOther.reduce((sum, e) => sum + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);

    if (eqIndiaVal > 0) catData.push({ label: 'Equity (India)', value: Math.round(eqIndiaVal * 100) / 100 });
    if (eqUSAVal > 0) catData.push({ label: 'Equity (USA)', value: Math.round(eqUSAVal * 100) / 100 });
    if (eqOtherVal > 0) catData.push({ label: 'Equity (Other)', value: Math.round(eqOtherVal * 100) / 100 });

    const otherCats = [
      { label: 'Mutual Funds', data: this.mfData, fn: (e: MutualFundEntry) => this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value) },
      { label: 'Commodity', data: this.commodityData, fn: (e: CommodityEntry) => this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value) },
      { label: 'Fixed Deposits', data: this.fdData, fn: (e: FixedDepositEntry) => (e.fd_value || 0) },
    ];
    otherCats.forEach(c => {
      const val = (c.data as any[]).reduce((sum, e) => sum + c.fn(e), 0);
      if (val > 0) catData.push({ label: c.label, value: Math.round(val * 100) / 100 });
    });

    // P2P: use backend-computed pending
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

  // ── Category Selection ──

  getTargetAllocation(label: string): number | null {
    return TARGET_ALLOCATION[label] ?? null;
  }

  getAllocationFlag(slice: PieSlice): string {
    const target = TARGET_ALLOCATION[slice.label];
    if (target == null) return '';
    const variance = Math.abs(slice.pct - target) / target * 100;
    if (variance < 10) return '✔';
    const diff = slice.pct - target;
    return diff > 0 ? '▲' : '▼';
  }

  getAllocationFlagColor(slice: PieSlice): string {
    const target = TARGET_ALLOCATION[slice.label];
    if (target == null) return 'inherit';
    const variance = Math.abs(slice.pct - target) / target * 100;
    if (variance < 10) return '#4caf50';   // green
    if (variance < 25) return '#f59e0b';   // orange
    return '#ef4444';                       // red
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

  get catNetPnLPct(): number {
    const exitedValue = this.catTotalInvested - this.catCurrentInvestment;
    return exitedValue > 0 ? Math.round((this.catNetPnL / exitedValue) * 10000) / 100 : 0;
  }

  // Normalize all category entries to a common shape for calculations
  private get catEntries(): { group: Record<string, string>; buyQty: number | null; sellQty: number | null; buyVal: number | null; sellVal: number | null }[] {
    const yearFilter = (e: any) => this.selectedYear === 'All' || e.year === this.selectedYear;
    switch (this.selectedCategory) {
      case 'Equity':
        return this.equityData.filter(yearFilter).map(e => ({ group: { Year: e.year || 'N/A', Market: e.market, 'Market Cap': e.market_cap, Sector: e.sector }, buyQty: e.buy_quantity, sellQty: e.sell_quantity, buyVal: e.buy_value, sellVal: e.sell_value }));
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
        return this.fdData.filter(yearFilter).map(e => ({ group: { Year: e.year || 'N/A', Platform: e.platform, Bank: e.bank_name }, buyQty: e.fd_value, sellQty: 0 as any, buyVal: e.fd_value, sellVal: e.return_value }));
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
        case 'Current Investment':
          val = this.calcInvestment(e.buyQty, e.sellQty, e.buyVal);
          break;
        case 'Total Invested':
          val = e.buyVal || 0;
          break;
        case 'Total Sales':
          val = e.sellVal || 0;
          break;
        case 'Net P&L':
          const ci = this.calcInvestment(e.buyQty, e.sellQty, e.buyVal);
          const ti = e.buyVal || 0;
          const ts = e.sellVal || 0;
          val = ts - (ti - ci);
          break;
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

  get forexAvgLast3DepositRate(): number | null {
    const deposits = this.forexData
      .filter(e => e.type === 'Deposit' && (e.rate || 0) > 0)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3);
    if (deposits.length === 0) return null;
    return deposits.reduce((s, e) => s + (e.rate || 0), 0) / deposits.length;
  }

  get forexWalletBalanceUSD(): number {
    const depositsUSD = this.forexData.filter(e => e.type === 'Deposit').reduce((s, e) => s + (e.usd_amount || 0), 0);
    const withdrawalsUSD = this.forexData.filter(e => e.type === 'Withdrawal').reduce((s, e) => s + (e.usd_amount || 0), 0);
    return depositsUSD - this.forexTotalInvestedUSD - withdrawalsUSD;
  }

  get forexTotalInvestedUSD(): number {
    const usaEquity = this.equityData.filter(e => e.market === 'USA');
    const totalBuyINR = usaEquity.reduce((s, e) => s + (e.buy_value || 0), 0);
    const totalSellINR = usaEquity.reduce((s, e) => s + (e.sell_value || 0), 0);
    const avgRate = this.forexAvgLast3DepositRate || this.forexAvgDepositRate;
    if (!avgRate || avgRate <= 0) return 0;
    return Math.round(((totalBuyINR - totalSellINR) / avgRate) * 100) / 100;
  }

  private get forexAvgDepositRate(): number {
    const deposits = this.forexData.filter(e => e.type === 'Deposit' && (e.rate || 0) > 0);
    if (deposits.length === 0) return 0;
    return deposits.reduce((s, e) => s + (e.rate || 0), 0) / deposits.length;
  }

  get forexWalletBalanceINR(): number {
    const rate = this.forexAvgLast3DepositRate;
    if (!rate) return 0;
    return Math.round(this.forexWalletBalanceUSD * rate * 100) / 100;
  }

  // P&L before forex: pure stock performance converted at uniform avg deposit rate
  get forexPnLBeforeForex(): number {
    const usaEquity = this.equityData.filter(e => e.market === 'USA');
    const totalBuy = usaEquity.reduce((s, e) => s + (e.buy_value || 0), 0);
    const totalSell = usaEquity.reduce((s, e) => s + (e.sell_value || 0), 0);
    const currentInv = usaEquity.reduce((s, e) => s + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
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
    const rate = this.forexAvgLast3DepositRate;
    if (!rate) return 0;
    return Math.round(this.forexCurrentHoldingsUSD * rate * 100) / 100;
  }

  get forexTotalBuyUSD(): number {
    const usaEquity = this.equityData.filter(e => e.market === 'USA');
    const totalBuyINR = usaEquity.reduce((s, e) => s + (e.buy_value || 0), 0);
    const avgRate = this.forexAvgDepositRate;
    if (avgRate <= 0) return 0;
    return Math.round((totalBuyINR / avgRate) * 100) / 100;
  }

  get forexTotalSalesUSD(): number {
    const usaEquity = this.equityData.filter(e => e.market === 'USA');
    const totalSellINR = usaEquity.reduce((s, e) => s + (e.sell_value || 0), 0);
    const avgRate = this.forexAvgDepositRate;
    if (avgRate <= 0) return 0;
    return Math.round((totalSellINR / avgRate) * 100) / 100;
  }

  // ── AI Analysis ──
  aiAnalysis = '';
  aiAnalysisHtml = '';
  aiLoading = false;
  aiError = '';

  getAIAnalysis(): void {
    this.aiLoading = true;
    this.aiError = '';
    this.investmentService.getAIAnalysis().subscribe({
      next: (res) => {
        this.aiAnalysis = res.analysis;
        this.aiAnalysisHtml = this.markdownToHtml(res.analysis);
        this.aiLoading = false;
      },
      error: (err) => {
        this.aiError = err.error?.error || 'Failed to get AI analysis. Please try again.';
        this.aiLoading = false;
      }
    });
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
