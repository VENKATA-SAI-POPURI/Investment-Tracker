import { Component, OnInit, OnDestroy, ChangeDetectorRef, ViewEncapsulation, Input, HostListener, HostBinding } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink, Router } from '@angular/router';
import { forkJoin, Observable, Subscription } from 'rxjs';
import { InvestmentService } from '../../services/investment.service';
import { AuthService, AuthUser } from '../../services/auth.service';
import { UiActionService } from '../../services/ui-action.service';
import { Summary, EquityEntry, CommodityEntry, MutualFundEntry, P2PEntry, P2PRepayment, FixedDepositEntry, ForexEntry } from '../../models/investment.model';
import { CountUpDirective } from '../../directives/count-up.directive';

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
  imports: [CommonModule, RouterLink, FormsModule, CountUpDirective],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  encapsulation: ViewEncapsulation.None
})
export class DashboardComponent implements OnInit, OnDestroy {
  @Input() view: 'home' | 'analysis' | 'chatbot' = 'home';
  @HostBinding('class.animations-done') hasAnimated = false;

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
  capitalFlowsSummary: { total_deposits: number; total_withdrawals: number; actual_investment: number } | null = null;
  unrealizedPnLData: { unrealized: number; unrealized_pct: number; total_cost: number; has_prices: boolean; by_category: Record<string, { unrealized: number; unrealized_pct: number; total_cost: number; has_prices: boolean }> } | null = null;
  capitalFlows: any[] = [];
  equityTickerMap: Record<string, { ticker: string; price: number | null }> = {};
  mfTickerMap: Record<string, { ticker: string; price: number | null }> = {};
  commodityTickerMap: Record<string, { ticker: string; price: number | null }> = {};
  livePricesEquity: Record<string, number | null> = {};
  livePricesMF: Record<string, number | null> = {};
  livePricesCommodity: Record<string, number | null> = {};
  showForexPopup = false;
  showCapitalFlowsForm = false;
  submittingCapitalFlow = false;
  
  // Capital Flows form state
  capitalFlowForm = {
    date: new Date().toISOString().split('T')[0],
    amount: '',
    type: 'Deposit',
    category: 'Equity/Commodity',
    remarks: ''
  };
  
  capitalFlowCategories = ['Equity/Commodity', 'Equity USA', 'Mutual Funds', 'P2P', 'Fixed Deposit', 'Others'];
  capitalFlowTypes = ['Deposit', 'Withdrawal', 'Profit Withdrawal'];

  selectedCategory = 'Equity';
  selectedMetric = 'Current Holdings';
  selectedYears: string[] = [];
  yearDropdownOpen = false;
  metricDropdownOpen = false;
  selectedSector: string | null = null;
  selectedMarket: string | null = null;
  selectedCapCategory: string | null = null;
  
  // Mutual Funds filters
  selectedMFCategory: string | null = null;
  selectedMFType: string | null = null;
  
  // Commodity filters
  selectedCommodity: string | null = null;
  
  // P2P filters
  selectedPlatform: string | null = null;
  selectedP2PStatus: string | null = null;
  
  // FD filters
  selectedBank: string | null = null;
  
  tooltip: { visible: boolean; text: string; x: number; y: number } = { visible: false, text: '', x: 0, y: 0 };

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
  currentUser$: Observable<AuthUser | null>;
  private refreshSub?: Subscription;

  constructor(
    private investmentService: InvestmentService,
    private authService: AuthService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private uiActionService: UiActionService
  ) {
    this.currentUser$ = this.authService.getUser$();
  }

  ngOnInit(): void {
    // Check localStorage first, then fall back to system preference
    const saved = localStorage.getItem('darkMode');
    if (saved !== null) {
      this.darkMode = saved === 'true';
    } else {
      this.darkMode = this.systemDarkQuery.matches;
    }
    this.applyDarkMode();

    // Listen for system preference changes only if no manual override
    this.systemDarkQuery.addEventListener('change', (e) => {
      if (localStorage.getItem('darkMode') === null) {
        this.darkMode = e.matches;
        this.applyDarkMode();
      }
    });

    this.loadAll();
    setTimeout(() => { this.hasAnimated = true; }, 1500);
    this.refreshSub = this.uiActionService.refresh.subscribe(() => { this.uiActionService.beginRefresh(); this.loadAll(() => this.uiActionService.endRefresh()); });
    this.refreshSub.add(this.uiActionService.silentRefresh.subscribe(() => this.loadAll()));
    this.refreshSub.add(this.uiActionService.equityPrices$.subscribe(p => { this.livePricesEquity = p; this.cdr.markForCheck(); }));
    this.refreshSub.add(this.uiActionService.mfPrices$.subscribe(p => { this.livePricesMF = p; this.cdr.markForCheck(); }));
    this.refreshSub.add(this.uiActionService.commodityPrices$.subscribe(p => { this.livePricesCommodity = p; this.cdr.markForCheck(); }));
    this.restoreAICache();
    this.investmentService.getSetting('targetAllocation').subscribe(res => {
      if (res.value) {
        try {
          this.targetAllocation = { ...DEFAULT_TARGET_ALLOCATION, ...JSON.parse(res.value) };
        } catch {}
      }
    });
  }

  ngOnDestroy(): void { this.refreshSub?.unsubscribe(); }

  toggleDarkMode(): void {
    this.darkMode = !this.darkMode;
    localStorage.setItem('darkMode', String(this.darkMode));
    this.applyDarkMode();
  }

  private applyDarkMode(): void {
    document.body.classList.toggle('dark', this.darkMode);
    document.body.classList.toggle('light', !this.darkMode);
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
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
      forex: this.investmentService.getForex(),
      capitalFlows: this.investmentService.getCapitalFlowsSummary(),
      capitalFlowsList: this.investmentService.getCapitalFlows(),
      unrealizedPnL: this.investmentService.getUnrealizedPnL(),
      equityTickers: this.investmentService.getEquityTickers(),
      mfTickers: this.investmentService.getMFTickers(),
      commodityTickers: this.investmentService.getCommodityTickers()
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
        this.capitalFlowsSummary = data.capitalFlows;
        this.capitalFlows = (data.capitalFlowsList || []).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        this.unrealizedPnLData = data.unrealizedPnL;
        this.equityTickerMap = data.equityTickers;
        this.mfTickerMap = data.mfTickers;
        this.commodityTickerMap = data.commodityTickers;
        this.refreshing = false;
      },
      error: () => this.refreshing = false
    });
  }

  loadAll(onComplete?: () => void): void {
    if (this.equityData.length === 0) this.loading = true;
    forkJoin({
      summary: this.investmentService.getSummary(),
      equity: this.investmentService.getEquity(),
      commodity: this.investmentService.getCommodity(),
      mf: this.investmentService.getMutualFunds(),
      p2p: this.investmentService.getP2P(),
      p2pRep: this.investmentService.getP2PRepayments(),
      fd: this.investmentService.getFixedDeposits(),
      forex: this.investmentService.getForex(),
      capitalFlows: this.investmentService.getCapitalFlowsSummary(),
      capitalFlowsList: this.investmentService.getCapitalFlows(),
      unrealizedPnL: this.investmentService.getUnrealizedPnL(),
      equityTickers: this.investmentService.getEquityTickers(),
      mfTickers: this.investmentService.getMFTickers(),
      commodityTickers: this.investmentService.getCommodityTickers()
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
        this.capitalFlowsSummary = data.capitalFlows;
        this.capitalFlows = (data.capitalFlowsList || []).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        this.unrealizedPnLData = data.unrealizedPnL;
        this.equityTickerMap = data.equityTickers;
        this.mfTickerMap = data.mfTickers;
        this.commodityTickerMap = data.commodityTickers;
        this.loading = false;
        onComplete?.();
      },
      error: () => { this.loading = false; onComplete?.(); }
    });
  }

  // ── Available Years ──

  get availableYears(): string[] {
    const years = new Set<string>();
    this.equityData.forEach(e => { const fy = this.dateToFY(e.date); if (fy) years.add(fy); });
    [...this.commodityData, ...this.mfData, ...this.fdData]
      .forEach((e: any) => { if (e.year) years.add(e.year); });
    return Array.from(years).sort();
  }

  get yearDropdownLabel(): string {
    if (this.selectedYears.length === 0) return 'All Years';
    return this.selectedYears.join(', ');
  }

  isYearSelected(yr: string): boolean {
    return this.selectedYears.includes(yr);
  }

  toggleYear(year: string): void {
    const idx = this.selectedYears.indexOf(year);
    if (idx > -1) {
      this.selectedYears = this.selectedYears.filter(y => y !== year);
    } else {
      this.selectedYears = [...this.selectedYears, year].sort();
    }
  }

  clearYears(): void {
    this.selectedYears = [];
  }

  toggleYearDropdown(event: MouseEvent): void {
    event.stopPropagation();
    this.yearDropdownOpen = !this.yearDropdownOpen;
    this.metricDropdownOpen = false;
  }

  toggleMetricDropdown(event: MouseEvent): void {
    event.stopPropagation();
    this.metricDropdownOpen = !this.metricDropdownOpen;
    this.yearDropdownOpen = false;
  }

  stopProp(event: MouseEvent): void {
    event.stopPropagation();
  }

  // kept for any remaining template refs
  selectYear(year: string): void { this.toggleYear(year); }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest('.filter-dropdown')) {
      this.yearDropdownOpen = false;
      this.metricDropdownOpen = false;
    }
  }

  showTooltip(event: MouseEvent, text: string): void {
    this.tooltip = { visible: true, text, x: event.clientX + 14, y: event.clientY - 40 };
  }

  moveTooltip(event: MouseEvent): void {
    this.tooltip.x = event.clientX + 14;
    this.tooltip.y = event.clientY - 40;
  }

  hideTooltip(): void {
    this.tooltip.visible = false;
  }

  toggleSectorFilter(sector: string): void {
    this.selectedSector = this.selectedSector === sector ? null : sector;
    console.log('toggleSectorFilter called with:', sector, 'now selectedSector is:', this.selectedSector);
  }

  selectMarket(market: string): void {
    this.selectedMarket = this.selectedMarket === market ? null : market;
  }

  selectCapCategory(cap: string): void {
    this.selectedCapCategory = this.selectedCapCategory === cap ? null : cap;
  }

  clearFilters(): void {
    this.selectedYears = [];
    this.selectedSector = null;
    this.selectedMarket = null;
    this.selectedCapCategory = null;
    this.selectedMFCategory = null;
    this.selectedMFType = null;
    this.selectedCommodity = null;
    this.selectedPlatform = null;
    this.selectedP2PStatus = null;
    this.selectedBank = null;
  }

  fmtINR(val: number): string {
    return '\u20B9' + Math.abs(Math.round(val)).toLocaleString('en-IN');
  }

  selectMFCategory(cat: string): void {
    this.selectedMFCategory = this.selectedMFCategory === cat ? null : cat;
  }

  selectMFType(type: string): void {
    this.selectedMFType = this.selectedMFType === type ? null : type;
  }

  selectCommodity(commodity: string): void {
    this.selectedCommodity = this.selectedCommodity === commodity ? null : commodity;
  }

  selectPlatform(platform: string): void {
    this.selectedPlatform = this.selectedPlatform === platform ? null : platform;
  }

  selectP2PStatus(status: string): void {
    this.selectedP2PStatus = this.selectedP2PStatus === status ? null : status;
  }

  selectBank(bank: string): void {
    this.selectedBank = this.selectedBank === bank ? null : bank;
  }

  trackByYear(index: number, item: any): string {
    return item.year || index.toString();
  }

  trackBySector(index: number, item: any): string {
    return item.sector || index.toString();
  }

  trackByMarketCap(index: number, item: any): string {
    return item.cap || index.toString();
  }

  trackByMFCategory(index: number, item: any): string {
    return item.cat || index.toString();
  }

  trackByMFType(index: number, item: any): string {
    return item.type || index.toString();
  }

  trackByCommodity(index: number, item: any): string {
    return item.commodity || index.toString();
  }

  trackByPlatform(index: number, item: any): string {
    return item.platform || index.toString();
  }

  trackByP2PStatus(index: number, item: any): string {
    return item.status || index.toString();
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
    // P2P: outstanding principal (interest does not reduce the invested amount)
    total += this.p2pOutstandingPrincipal;
    // FD: only active (not yet matured) deposits
    total += this.fdData.filter(e => !e.return_value || e.return_value === 0).reduce((sum, e) => sum + (e.fd_value || 0), 0);
    // USD broker wallet: uninvested cash, funded from bank deposits (part of total portfolio value)
    total += this.forexWalletBalanceINR;
    return Math.round(total * 100) / 100;
  }

  get totalInvestment(): number {
    return Object.entries(this.summary)
      .filter(([key]) => key !== 'Forex')
      .reduce((sum, [, s]) => sum + s.total_buy, 0);
  }

  get totalSaleValue(): number {
    // Exclude P2P from backend summary (its total_sell is gross; we substitute net credited)
    const nonP2PTotal = Object.entries(this.summary)
      .filter(([key]) => key !== 'Forex' && key !== 'P2P')
      .reduce((sum, [, s]) => sum + s.total_sell, 0);
    const p2pNetSales = this.p2pRepayments.reduce((s, rep) => s + this.p2pRepNetCredited(rep), 0);
    return nonP2PTotal + p2pNetSales;
  }

  get netPnL(): number {
    return this.totalSaleValue - (this.totalInvestment - this.currentInvestment) + this.forexImpact;
  }

  get costOfSold(): number {
    return Math.round((this.totalInvestment - this.currentInvestment) * 100) / 100;
  }

  get netPnLPct(): number {
    const exitedValue = this.totalInvestment - this.currentInvestment;
    return exitedValue > 0 ? Math.round((this.netPnL / exitedValue) * 10000) / 100 : 0;
  }

  get netPnLVsActualPct(): number {
    return this.actualInvestment > 0 ? Math.round((this.netPnL / this.actualInvestment) * 10000) / 100 : 0;
  }

  get totalUnrealizedPnL(): number {
    return this.unrealizedPnLData?.unrealized ?? 0;
  }

  get totalUnrealizedPnLPct(): number {
    return this.unrealizedPnLData?.unrealized_pct ?? 0;
  }

  get hasUnrealizedPrices(): boolean {
    return this.unrealizedPnLData?.has_prices ?? false;
  }

  get actualInvestment(): number {
    return this.capitalFlowsSummary?.actual_investment || 0;
  }

  get totalProfitWithdrawals(): number {
    return (this.capitalFlows || [])
      .filter(cf => cf.type === 'Profit Withdrawal')
      .reduce((s, cf) => s + (parseFloat(cf.amount) || 0), 0);
  }

  get reinvestedProfit(): number {
    return this.currentInvestment - this.actualInvestment - this.totalProfitWithdrawals;
  }

  // ── Category P&L Summary ──

  get categorySummaryRows(): { category: string; icon: string; totalInvested: number; currentHoldings: number; totalSales: number; netPnL: number; returnPct: number; xirr: number | null; unrealizedPnL: number; unrealizedPct: number; hasUnrealizedPrice: boolean }[] {
    const r = <T>(v: T) => Math.round((v as any) * 100) / 100;
    const pct = (pnl: number, cost: number) => cost > 0 ? Math.round((pnl / cost) * 10000) / 100 : 0;
    const today = new Date();

    // Equity India
    const eqIndFifo  = this.equityFifoHoldings.filter(h => h.market !== 'USA').reduce((s, h) => s + h.value, 0);
    const eqIndInv   = this.equityData.filter(e => e.market !== 'USA' && e.buy_sell === 'Buy').reduce((s, e) => s + (e.value || 0), 0);
    const eqIndSales = this.equityData.filter(e => e.market !== 'USA' && e.buy_sell === 'Sell').reduce((s, e) => s + (e.value || 0), 0);
    const eqIndCost  = eqIndInv - eqIndFifo;
    const eqIndFlows = [
      ...this.equityData.filter(e => e.market !== 'USA').map(e => ({ date: new Date(e.date), amount: e.buy_sell === 'Buy' ? -(e.value || 0) : +(e.value || 0) })),
      { date: today, amount: eqIndFifo }   // terminal = remaining cost basis only (sells already in flows)
    ];

    // Equity USA
    const eqUsaFifo  = this.equityFifoHoldings.filter(h => h.market === 'USA').reduce((s, h) => s + h.value, 0);
    const eqUsaInv   = this.equityData.filter(e => e.market === 'USA' && e.buy_sell === 'Buy').reduce((s, e) => s + (e.value || 0), 0);
    const eqUsaSales = this.equityData.filter(e => e.market === 'USA' && e.buy_sell === 'Sell').reduce((s, e) => s + (e.value || 0), 0);
    const eqUsaCost  = eqUsaInv - eqUsaFifo;
    const eqUsaFlows = [
      ...this.equityData.filter(e => e.market === 'USA').map(e => ({ date: new Date(e.date), amount: e.buy_sell === 'Buy' ? -(e.value || 0) : +(e.value || 0) })),
      { date: today, amount: eqUsaFifo }   // terminal = remaining cost basis only
    ];

    // Mutual Funds
    const mfInv   = this.mfData.reduce((s, e) => s + (e.buy_value || 0), 0);
    const mfCurr  = this.mfData.reduce((s, e) => s + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
    const mfSales = this.mfData.reduce((s, e) => s + (e.sell_value || 0), 0);
    const mfCost  = mfInv - mfCurr;
    const mfFlows = [
      ...this.mfData.map(e => ({ date: new Date(e.date), amount: e.buy_sell === 'Buy' ? -(e.buy_value || 0) : +(e.sell_value || 0) })),
      { date: today, amount: mfCurr }   // terminal = remaining cost basis only
    ];

    // Commodity
    const cmdInv   = this.commodityData.reduce((s, e) => s + (e.buy_value || 0), 0);
    const cmdCurr  = this.commodityData.reduce((s, e) => s + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
    const cmdSales = this.commodityData.reduce((s, e) => s + (e.sell_value || 0), 0);
    const cmdCost  = cmdInv - cmdCurr;
    const cmdFlows = [
      ...this.commodityData.map(e => ({ date: new Date(e.date), amount: e.buy_sell === 'Buy' ? -(e.buy_value || 0) : +(e.sell_value || 0) })),
      { date: today, amount: cmdCurr }   // terminal = remaining cost basis only
    ];

    // P2P — compute principal repaid correctly (same FIFO logic as P2P module)
    const p2pInv   = this.p2pData.reduce((s, e) => s + (e.amount || 0), 0);
    const p2pSales = this.p2pRepayments.reduce((s, rep) => s + this.p2pRepNetCredited(rep), 0);
    const p2pCurr  = this.p2pOutstandingPrincipal;
    const p2pCost  = p2pInv - p2pCurr;
    const p2pFlows = [
      ...this.p2pData.map(e => ({ date: new Date(e.date), amount: -(e.amount || 0) })),
      ...this.p2pRepayments.map(rp => ({ date: new Date(rp.date), amount: +this.p2pRepNetCredited(rp) })),
      { date: today, amount: p2pCurr }
    ];

    // Fixed Deposits
    const fdInv   = this.fdData.reduce((s, e) => s + (e.fd_value || 0), 0);
    const fdCurr  = this.fdData.filter(e => !e.return_value || e.return_value === 0).reduce((s, e) => s + (e.fd_value || 0), 0);
    const fdSales = this.fdData.filter(e => (e.return_value || 0) > 0).reduce((s, e) => s + (e.return_value || 0), 0);
    const fdCost  = fdInv - fdCurr;
    const fdFlows = [
      ...this.fdData.map(e => ({ date: new Date(e.date), amount: -(e.fd_value || 0) })),
      ...this.fdData.filter(e => (e.return_value || 0) > 0).map(e => ({ date: new Date(e.maturity_date || e.date), amount: +(e.return_value || 0) })),
      { date: today, amount: fdCurr }
    ];

    // Forex
    const fxDepINR  = this.forexData.filter(e => e.type === 'Deposit').reduce((s, e) => s + (e.inr_amount || 0), 0);
    const fxDepUSD  = this.forexData.filter(e => e.type === 'Deposit').reduce((s, e) => s + (e.usd_amount || 0), 0);
    const fxWdlINR  = this.forexData.filter(e => e.type === 'Withdrawal').reduce((s, e) => s + (e.inr_amount || 0), 0);
    const fxWdlUSD  = this.forexData.filter(e => e.type === 'Withdrawal').reduce((s, e) => s + (e.usd_amount || 0), 0);
    const fxAvgRate = fxDepUSD > 0 ? fxDepINR / fxDepUSD : 0;
    const fxCostOfWdl = fxWdlUSD * fxAvgRate;
    const fxNetPnL  = fxAvgRate > 0 ? r(fxWdlINR - fxCostOfWdl) : 0;

    const bycat = this.unrealizedPnLData?.by_category ?? {};
    const ucat = (key: string) => bycat[key] ?? { unrealized: 0, unrealized_pct: 0, has_prices: false };
    return [
      { category: 'Equity India',   icon: '📈', totalInvested: r(eqIndInv), currentHoldings: r(eqIndFifo), totalSales: r(eqIndSales), netPnL: r(eqIndSales - eqIndCost), returnPct: pct(eqIndSales - eqIndCost, eqIndCost), xirr: this.xirrSafe(eqIndFlows), unrealizedPnL: ucat('equity_india').unrealized, unrealizedPct: ucat('equity_india').unrealized_pct, hasUnrealizedPrice: ucat('equity_india').has_prices },
      { category: 'Equity USA',     icon: '🌐', totalInvested: r(eqUsaInv), currentHoldings: r(eqUsaFifo), totalSales: r(eqUsaSales), netPnL: r(eqUsaSales - eqUsaCost + fxNetPnL), returnPct: pct(eqUsaSales - eqUsaCost + fxNetPnL, eqUsaCost), xirr: this.xirrSafe(eqUsaFlows), unrealizedPnL: ucat('equity_usa').unrealized, unrealizedPct: ucat('equity_usa').unrealized_pct, hasUnrealizedPrice: ucat('equity_usa').has_prices },
      { category: 'Mutual Funds',   icon: '📊', totalInvested: r(mfInv),  currentHoldings: r(mfCurr),  totalSales: r(mfSales),  netPnL: r(mfSales  - mfCost),  returnPct: pct(mfSales  - mfCost,  mfCost),  xirr: this.xirrSafe(mfFlows),  unrealizedPnL: ucat('mutual_funds').unrealized, unrealizedPct: ucat('mutual_funds').unrealized_pct, hasUnrealizedPrice: ucat('mutual_funds').has_prices },
      { category: 'Commodity',      icon: '🥇', totalInvested: r(cmdInv), currentHoldings: r(cmdCurr), totalSales: r(cmdSales), netPnL: r(cmdSales - cmdCost), returnPct: pct(cmdSales - cmdCost, cmdCost), xirr: this.xirrSafe(cmdFlows), unrealizedPnL: ucat('commodity').unrealized, unrealizedPct: ucat('commodity').unrealized_pct, hasUnrealizedPrice: ucat('commodity').has_prices },
      { category: 'P2P',            icon: '🤝', totalInvested: r(p2pInv), currentHoldings: r(p2pCurr), totalSales: r(p2pSales), netPnL: r(p2pSales - p2pCost), returnPct: pct(p2pSales - p2pCost, p2pCost), xirr: this.xirrSafe(p2pFlows), unrealizedPnL: 0, unrealizedPct: 0, hasUnrealizedPrice: false },
      { category: 'Fixed Deposits', icon: '🏦', totalInvested: r(fdInv),  currentHoldings: r(fdCurr),  totalSales: r(fdSales),  netPnL: r(fdSales  - fdCost),  returnPct: pct(fdSales  - fdCost,  fdCost),  xirr: this.xirrSafe(fdFlows),  unrealizedPnL: 0, unrealizedPct: 0, hasUnrealizedPrice: false },
    ].filter(row => row.currentHoldings > 0);
  }

  // ── XIRR ──

  private xirrSafe(flows: { date: Date; amount: number }[]): number | null {
    flows.sort((a, b) => a.date.getTime() - b.date.getTime());
    if (!flows.some(f => f.amount < 0) || !flows.some(f => f.amount > 0)) return null;
    return this.xirr(flows);
  }

  private xirr(flows: { date: Date; amount: number }[]): number | null {
    const d0 = flows[0].date.getTime();
    const years = flows.map(f => (f.date.getTime() - d0) / (365.25 * 86400000));
    const npv  = (r: number) => flows.reduce((s, f, i) => s + f.amount / Math.pow(1 + r, years[i]), 0);
    const dnpv = (r: number) => flows.reduce((s, f, i) => s - f.amount * years[i] / Math.pow(1 + r, years[i] + 1), 0);
    let r = 0.1;
    for (let i = 0; i < 200; i++) {
      const dr = dnpv(r);
      if (Math.abs(dr) < 1e-14) break;
      const r1 = r - npv(r) / dr;
      if (!isFinite(r1) || r1 < -0.9999) break;
      if (Math.abs(r1 - r) < 1e-9) { r = r1; break; }
      r = r1;
    }
    return Math.abs(npv(r)) < 10 ? Math.round(r * 10000) / 100 : null;
  }

  get portfolioXIRR(): number | null {
    if (!this.capitalFlows?.length) return null;
    const flows: { date: Date; amount: number }[] = this.capitalFlows
      .filter(cf => cf.type !== 'Profit Withdrawal')
      .map(cf => ({
        date: new Date(cf.date),
        amount: cf.type === 'Deposit' ? -(parseFloat(cf.amount) || 0) : (parseFloat(cf.amount) || 0)
      }));
    // Terminal = remaining cost basis + all realized sale proceeds still inside the portfolio
    const terminal = this.currentInvestment + this.totalSaleValue;
    if (terminal <= 0) return null;
    flows.push({ date: new Date(), amount: terminal });
    flows.sort((a, b) => a.date.getTime() - b.date.getTime());
    if (!flows.some(f => f.amount < 0) || !flows.some(f => f.amount > 0)) return null;
    return this.xirr(flows);
  }

  // ── Monthly Deployment Chart ──

  get monthlyDeploymentBars(): { month: string; deposits: number; withdrawals: number; net: number; depositPct: number; withdrawalPct: number }[] {
    if (!this.capitalFlows?.length) return [];
    const monthMap = new Map<string, { deposits: number; withdrawals: number }>();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    this.capitalFlows.forEach(cf => {
      const d = new Date(cf.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const prev = monthMap.get(key) || { deposits: 0, withdrawals: 0 };
      const amt = parseFloat(cf.amount) || 0;
      if (cf.type === 'Deposit') prev.deposits += amt; else prev.withdrawals += amt;
      monthMap.set(key, prev);
    });
    const maxDep = Math.max(...[...monthMap.values()].map(v => v.deposits), 1);
    return [...monthMap.keys()].sort().map(key => {
      const v = monthMap.get(key)!;
      const [yr, mo] = key.split('-');
      return {
        month: `${monthNames[+mo - 1]} '${yr.slice(2)}`,
        deposits: Math.round(v.deposits * 100) / 100,
        withdrawals: Math.round(v.withdrawals * 100) / 100,
        net: Math.round((v.deposits - v.withdrawals) * 100) / 100,
        depositPct: Math.round((v.deposits / maxDep) * 100),
        withdrawalPct: Math.round((v.withdrawals / maxDep) * 100),
      };
    });
  }

  // ── Cumulative Deployment Chart ──

  get cumulativeDeploymentData(): { value: number; pct: number }[] {
    const bars = this.monthlyDeploymentBars;
    if (!bars.length) return [];
    let running = 0;
    const vals = bars.map(b => { running += b.net; return Math.max(0, running); });
    const maxVal = Math.max(...vals, 1);
    return vals.map(v => ({ value: Math.round(v), pct: Math.round(v / maxVal * 100) }));
  }

  get cumulativeLinePoints(): string {
    const data = this.cumulativeDeploymentData;
    if (!data.length) return '';
    const n = data.length;
    return data.map((d, i) => `${((2 * i + 1) / (2 * n)) * 100},${28 - d.pct * 0.26}`).join(' ');
  }

  get cumulativeAreaPoints(): string {
    const data = this.cumulativeDeploymentData;
    if (!data.length) return '';
    const n = data.length;
    const firstX = (1 / (2 * n)) * 100;
    const lastX = ((2 * (n - 1) + 1) / (2 * n)) * 100;
    return `${firstX},28 ${this.cumulativeLinePoints} ${lastX},28`;
  }

  // ── Best & Worst Performer (live prices required) ──

  private get allHoldingPerformers(): { name: string; category: string; pct: number; pnl: number }[] {
    const results: { name: string; category: string; pct: number; pnl: number }[] = [];

    // Equity — net qty per stock
    const usdInrRate = this.forexLatestRate;
    const eqNetQty = new Map<string, number>();
    for (const e of this.equityData) {
      const sign = e.buy_sell === 'Buy' ? 1 : -1;
      eqNetQty.set(e.name, (eqNetQty.get(e.name) || 0) + sign * (e.quantity || 0));
    }
    for (const h of this.equityFifoHoldings) {
      if (h.value <= 0) continue;
      const t = this.equityTickerMap[h.name];
      if (!t?.ticker) continue;
      const priceRaw = this.livePricesEquity[t.ticker] ?? null;
      if (priceRaw == null) continue;
      const netQty = eqNetQty.get(h.name) || 0;
      if (netQty <= 0) continue;
      // US stocks: price is in USD — convert to INR for a fair comparison with INR cost basis
      const priceInr = h.market === 'USA' ? priceRaw * (usdInrRate || 0) : priceRaw;
      if (h.market === 'USA' && usdInrRate <= 0) continue;
      const mv = priceInr * netQty;
      const pnl = mv - h.value;
      const pct = Math.round(pnl / h.value * 10000) / 100;
      results.push({ name: h.name, category: h.market === 'USA' ? 'Equity USA' : 'Equity India', pct, pnl: Math.round(pnl) });
    }

    // Mutual Funds
    const mfHoldings = new Map<string, { buyQty: number; buyVal: number; sellQty: number }>();
    for (const e of this.mfData) {
      const h = mfHoldings.get(e.name) || { buyQty: 0, buyVal: 0, sellQty: 0 };
      h.buyQty += e.buy_quantity || 0;
      h.buyVal += e.buy_value || 0;
      h.sellQty += e.sell_quantity || 0;
      mfHoldings.set(e.name, h);
    }
    for (const [name, h] of mfHoldings) {
      const netQty = h.buyQty - h.sellQty;
      if (netQty <= 0) continue;
      const t = this.mfTickerMap[name];
      if (!t?.ticker) continue;
      const price = this.livePricesMF[t.ticker] ?? null;
      if (price == null) continue;
      const cost = h.buyQty > 0 ? (h.buyVal / h.buyQty) * netQty : 0;
      if (cost <= 0) continue;
      const pnl = price * netQty - cost;
      const pct = Math.round(pnl / cost * 10000) / 100;
      results.push({ name, category: 'Mutual Funds', pct, pnl: Math.round(pnl) });
    }

    // Commodity
    const cmdHoldings = new Map<string, { buyQty: number; buyVal: number; sellQty: number }>();
    for (const e of this.commodityData) {
      const h = cmdHoldings.get(e.name) || { buyQty: 0, buyVal: 0, sellQty: 0 };
      h.buyQty += e.buy_quantity || 0;
      h.buyVal += e.buy_value || 0;
      h.sellQty += e.sell_quantity || 0;
      cmdHoldings.set(e.name, h);
    }
    for (const [name, h] of cmdHoldings) {
      const netQty = h.buyQty - h.sellQty;
      if (netQty <= 0) continue;
      const t = this.commodityTickerMap[name];
      if (!t?.ticker) continue;
      const price = this.livePricesCommodity[t.ticker] ?? null;
      if (price == null) continue;
      const cost = h.buyQty > 0 ? (h.buyVal / h.buyQty) * netQty : 0;
      if (cost <= 0) continue;
      const pnl = price * netQty - cost;
      const pct = Math.round(pnl / cost * 10000) / 100;
      results.push({ name, category: 'Commodity', pct, pnl: Math.round(pnl) });
    }

    return results;
  }

  get bestPerformer(): { name: string; category: string; pct: number; pnl: number } | null {
    const p = this.allHoldingPerformers;
    if (!p.length) return null;
    return p.reduce((best, cur) => cur.pct > best.pct ? cur : best);
  }

  get worstPerformer(): { name: string; category: string; pct: number; pnl: number } | null {
    const p = this.allHoldingPerformers;
    if (!p.length) return null;
    return p.reduce((worst, cur) => cur.pct < worst.pct ? cur : worst);
  }

  // ── Equity FIFO holdings (per-stock cost of remaining lots, always from all data) ──

  private get equityFifoHoldings(): { name: string; value: number; market: string; market_cap: string; sector: string }[] {
    // Group buys and sells by (name, date) for same-day netting
    const buysByNameDate = new Map<string, Map<string, { qty: number; value: number }>>();
    const sellsByNameDate = new Map<string, Map<string, number>>();
    const metaByName = new Map<string, { market: string; market_cap: string; sector: string }>();

    for (const e of this.equityData) {
      if (e.buy_sell === 'Buy') {
        metaByName.set(e.name, { market: e.market, market_cap: e.market_cap, sector: e.sector });
        if (!buysByNameDate.has(e.name)) buysByNameDate.set(e.name, new Map());
        const dm = buysByNameDate.get(e.name)!;
        const prev = dm.get(e.date) || { qty: 0, value: 0 };
        dm.set(e.date, { qty: prev.qty + (e.quantity || 0), value: prev.value + (e.value || 0) });
      } else {
        if (!sellsByNameDate.has(e.name)) sellsByNameDate.set(e.name, new Map());
        const dm = sellsByNameDate.get(e.name)!;
        dm.set(e.date, (dm.get(e.date) || 0) + (e.quantity || 0));
      }
    }

    const result: { name: string; value: number; market: string; market_cap: string; sector: string }[] = [];

    for (const [name, buyDateMap] of buysByNameDate) {
      // Mutable copies for same-day netting
      const buyMap = new Map<string, { qty: number; value: number }>();
      for (const [d, v] of buyDateMap) buyMap.set(d, { ...v });
      const sellMap = new Map<string, number>();
      for (const [d, q] of (sellsByNameDate.get(name) || new Map())) sellMap.set(d, q);

      // Priority: net off sells against same-day buys first
      for (const [date, sellQty] of sellMap) {
        const bd = buyMap.get(date);
        if (bd && bd.qty > 0 && sellQty > 0) {
          const netted = Math.min(bd.qty, sellQty);
          const ratio = (bd.qty - netted) / bd.qty;
          buyMap.set(date, { qty: bd.qty - netted, value: bd.value * ratio });
          sellMap.set(date, sellQty - netted);
        }
      }

      // Effective buy lots remaining after same-day netting, sorted oldest-first
      const effectiveLots = [...buyMap.entries()]
        .filter(([, bd]) => bd.qty > 0)
        .map(([date, bd]) => ({ date, qty: bd.qty, value: bd.value }))
        .sort((a, b) => a.date.localeCompare(b.date));

      let remSells = 0;
      for (const q of sellMap.values()) remSells += q;

      let fifoValue = 0;
      for (const lot of effectiveLots) {
        let rem = lot.qty;
        if (remSells >= rem) { remSells -= rem; continue; }
        rem -= remSells; remSells = 0;
        fifoValue += rem * (lot.qty > 0 ? lot.value / lot.qty : 0);
      }

      if (fifoValue > 0) {
        const meta = metaByName.get(name) || { market: '', market_cap: '', sector: '' };
        result.push({ name, value: Math.round(fifoValue * 100) / 100, ...meta });
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
    // Include USD broker wallet cash in Equity (USA) since it's uninvested USD in the same broker account
    if (eqUSAVal > 0 || this.forexWalletBalanceINR > 0) catData.push({ label: 'Equity (USA)', value: Math.round((eqUSAVal + this.forexWalletBalanceINR) * 100) / 100 });
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

  // ── Actual Investment Allocation by Category ──

  get actualInvestmentAllocationPie(): PieChart {
    const catData: { label: string; value: number }[] = [];

    // Group capital flows by category and calculate net investment per category
    const capitalFlowsByCategory: { [key: string]: { deposits: number; withdrawals: number } } = {};

    const categoryMapping: { [key: string]: string } = {
      'Equity/Commodity': 'Equity/Commodity',
      'Equity USA': 'Equity USA',
      'Mutual Funds': 'Mutual Funds',
      'P2P': 'P2P',
      'Fixed Deposit': 'Fixed Deposits',
      'Others': 'Others'
    };

    // Initialize categories
    Object.values(categoryMapping).forEach(cat => {
      capitalFlowsByCategory[cat] = { deposits: 0, withdrawals: 0 };
    });

    // Sum deposits and withdrawals per category
    (this.capitalFlows || []).forEach(flow => {
      const category = categoryMapping[flow.category] || flow.category;
      if (!capitalFlowsByCategory[category]) {
        capitalFlowsByCategory[category] = { deposits: 0, withdrawals: 0 };
      }
      const amount = parseFloat(flow.amount) || 0;
      if (flow.type === 'Deposit') {
        capitalFlowsByCategory[category].deposits += amount;
      } else if (flow.type === 'Withdrawal') {
        capitalFlowsByCategory[category].withdrawals += amount;
      }
    });

    // Calculate net investment per category
    Object.entries(capitalFlowsByCategory).forEach(([category, data]) => {
      const netInvestment = data.deposits - data.withdrawals;
      if (netInvestment > 0) {
        catData.push({ label: category, value: Math.round(netInvestment * 100) / 100 });
      }
    });

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

    return { title: 'Actual Investment Allocation', total, slices, gradient };
  }

  // ── Actual Investment Allocation - Horizontal Bar Chart ──

  get actualInvestmentBars(): { label: string; value: number; pct: number; color: string }[] {
    const catData: { label: string; value: number }[] = [];

    // Group capital flows by category and calculate net investment per category
    const categoryMapping: { [key: string]: string } = {
      'Equity/Commodity': 'Equity/Commodity',
      'Equity USA': 'Equity USA',
      'Mutual Funds': 'Mutual Funds',
      'P2P': 'P2P',
      'Fixed Deposit': 'Fixed Deposits',
      'Others': 'Others'
    };

    const capitalFlowsByCategory: { [key: string]: { deposits: number; withdrawals: number } } = {};
    Object.values(categoryMapping).forEach(cat => {
      capitalFlowsByCategory[cat] = { deposits: 0, withdrawals: 0 };
    });

    // Sum deposits and withdrawals per category
    (this.capitalFlows || []).forEach(flow => {
      const category = categoryMapping[flow.category] || flow.category;
      if (!capitalFlowsByCategory[category]) {
        capitalFlowsByCategory[category] = { deposits: 0, withdrawals: 0 };
      }
      const amount = parseFloat(flow.amount) || 0;
      if (flow.type === 'Deposit') {
        capitalFlowsByCategory[category].deposits += amount;
      } else if (flow.type === 'Withdrawal') {
        capitalFlowsByCategory[category].withdrawals += amount;
      }
    });

    // Calculate net investment per category
    Object.entries(capitalFlowsByCategory).forEach(([category, data]) => {
      const netInvestment = data.deposits - data.withdrawals;
      if (netInvestment > 0) {
        catData.push({ label: category, value: Math.round(netInvestment * 100) / 100 });
      }
    });

    const total = catData.reduce((s, d) => s + d.value, 0);
    const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981'];

    const sorted = catData
      .map((d, i) => ({
        label: d.label,
        value: d.value,
        pct: total > 0 ? Math.round((d.value / total) * 1000) / 10 : 0,
        color: colors[i % colors.length]
      }))
      .sort((a, b) => b.value - a.value);

    return sorted;
  }

  get maxActualPct(): number {
    const bars = this.actualInvestmentBars;
    return bars.length > 0 ? bars[0].pct : 100;
  }

  // ── Equity Analysis ──

  // Per-stock realized P&L helper: sell value − proportional buy cost.
  // Stocks with no sells contribute 0 (unrealized P&L is unknown without live prices).
  private equityPnL(entries: EquityEntry[]): { name: string; pnl: number; market: string; market_cap: string; sector: string }[] {
    const metaByName = new Map<string, { market: string; market_cap: string; sector: string }>();
    const sellsByNameDate = new Map<string, Map<string, { qty: number; value: number; market: string; market_cap: string; sector: string }>>();

    for (const e of entries) {
      metaByName.set(e.name, { market: e.market, market_cap: e.market_cap, sector: e.sector });
      if (e.buy_sell === 'Sell') {
        if (!sellsByNameDate.has(e.name)) sellsByNameDate.set(e.name, new Map());
        const dm = sellsByNameDate.get(e.name)!;
        const prev = dm.get(e.date) || { qty: 0, value: 0, market: e.market, market_cap: e.market_cap, sector: e.sector };
        dm.set(e.date, { qty: prev.qty + (e.quantity || 0), value: prev.value + (e.value || 0), market: e.market, market_cap: e.market_cap, sector: e.sector });
      }
    }

    // Build buy lots per (name, date) from ALL equity data
    const buysByNameDate = new Map<string, Map<string, { qty: number; value: number }>>();
    for (const e of this.equityData) {
      if (e.buy_sell === 'Buy') {
        if (!buysByNameDate.has(e.name)) buysByNameDate.set(e.name, new Map());
        const dm = buysByNameDate.get(e.name)!;
        const prev = dm.get(e.date) || { qty: 0, value: 0 };
        dm.set(e.date, { qty: prev.qty + (e.quantity || 0), value: prev.value + (e.value || 0) });
      }
    }

    const result: { name: string; pnl: number; market: string; market_cap: string; sector: string }[] = [];

    // Stocks with no sells → pnl 0
    for (const [name, meta] of metaByName) {
      if (!sellsByNameDate.has(name)) result.push({ name, pnl: 0, ...meta });
    }

    // Stocks with sells → same-day netting first, then FIFO for remainder
    for (const [name, sellDateMap] of sellsByNameDate) {
      const meta = metaByName.get(name) || { market: '', market_cap: '', sector: '' };

      const buyMap = new Map<string, { qty: number; value: number }>();
      for (const [d, v] of (buysByNameDate.get(name) || new Map())) buyMap.set(d, { ...v });

      let intradayPnL = 0;
      let remSellQty = 0;
      let remSellValue = 0;

      for (const [date, sd] of sellDateMap) {
        const bd = buyMap.get(date);
        if (bd && bd.qty > 0 && sd.qty > 0) {
          const netted = Math.min(bd.qty, sd.qty);
          const intradaySellVal = sd.qty > 0 ? sd.value * (netted / sd.qty) : 0;
          const intradayBuyCost = bd.qty > 0 ? bd.value * (netted / bd.qty) : 0;
          intradayPnL += intradaySellVal - intradayBuyCost;
          buyMap.set(date, { qty: bd.qty - netted, value: bd.value - intradayBuyCost });
          remSellQty += sd.qty - netted;
          remSellValue += sd.value - intradaySellVal;
        } else {
          remSellQty += sd.qty;
          remSellValue += sd.value;
        }
      }

      // FIFO on remaining (non-intraday) sells
      const remainingLots = [...buyMap.entries()]
        .filter(([, bd]) => bd.qty > 0)
        .map(([date, bd]) => ({ date, qty: bd.qty, value: bd.value }))
        .sort((a, b) => a.date.localeCompare(b.date));

      let remaining = remSellQty;
      let fifoCost = 0;
      for (const lot of remainingLots) {
        if (remaining <= 0) break;
        const used = Math.min(lot.qty, remaining);
        fifoCost += used * (lot.qty > 0 ? lot.value / lot.qty : 0);
        remaining -= used;
      }

      result.push({ name, pnl: Math.round((intradayPnL + remSellValue - fifoCost) * 100) / 100, ...meta });
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
    let filtered = this.equityData;
    if (this.selectedYears.length > 0) {
      filtered = filtered.filter(e => this.selectedYears.includes(this.dateToFY(e.date)));
    }
    if (this.selectedMarket !== null) {
      filtered = filtered.filter(e => e.market === this.selectedMarket);
    }
    if (this.selectedCapCategory !== null) {
      filtered = filtered.filter(e => e.market_cap === this.selectedCapCategory);
    }
    if (this.selectedSector !== null) {
      filtered = filtered.filter(e => e.sector === this.selectedSector);
    }
    return filtered;
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
    let filtered = this.mfData;
    if (this.selectedYears.length > 0) {
      filtered = filtered.filter(e => this.selectedYears.includes(e.year));
    }
    if (this.selectedMFCategory !== null) {
      filtered = filtered.filter(e => e.category === this.selectedMFCategory);
    }
    if (this.selectedMFType !== null) {
      filtered = filtered.filter(e => e.fund_type === this.selectedMFType);
    }
    return filtered;
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
    let filtered = this.commodityData;
    if (this.selectedYears.length > 0) {
      filtered = filtered.filter(e => this.selectedYears.includes(e.year));
    }
    if (this.selectedCommodity !== null) {
      filtered = filtered.filter(e => e.commodity === this.selectedCommodity);
    }
    return filtered;
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

  /** Amount received per repayment (platform fee is informational only, does not reduce received amount) */
  private p2pRepNetCredited(rep: P2PRepayment): number {
    return rep.principal != null
      ? (rep.principal || 0) + (rep.interest || 0)
      : (rep.amount || 0);
  }

  /** Outstanding principal = total lent minus principal already repaid (same FIFO logic as P2P module) */
  private get p2pOutstandingPrincipal(): number {
    let principalRepaid = 0;
    for (const e of this.p2pData) {
      const reps = this.p2pRepayments.filter(r => r.lending_id === e.lending_id);
      const pp = (e.amount && e.tenure) ? e.amount / e.tenure : 0;
      let cum = 0;
      for (const rep of reps) {
        if (rep.principal != null) {
          cum += rep.principal;
        } else {
          const repAmount = rep.amount || 0;
          const remaining = (e.amount || 0) - cum;
          cum += repAmount >= remaining ? remaining : Math.min(repAmount, pp);
        }
      }
      principalRepaid += Math.min(cum, e.amount || 0);
    }
    return this.p2pData.reduce((s, e) => s + (e.amount || 0), 0) - principalRepaid;
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
    let filtered = this.p2pData;
    if (this.selectedYears.length > 0) {
      filtered = filtered.filter(e => this.selectedYears.includes(this.dateToFY(e.date)));
    }
    if (this.selectedPlatform !== null) {
      filtered = filtered.filter(e => e.platform === this.selectedPlatform);
    }
    if (this.selectedP2PStatus !== null) {
      filtered = filtered.filter(e => e.status === this.selectedP2PStatus);
    }
    return filtered;
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
    if (target == null || target === 0) return '';
    const threshold = target * 0.1;
    if (slice.pct > target + threshold) return '▲';
    if (slice.pct < target - threshold) return '▼';
    return '✔';
  }

  getAllocationFlagColor(slice: PieSlice): string {
    const target = this.targetAllocation[slice.label];
    if (target == null || target === 0) return 'inherit';
    const threshold = target * 0.1;
    if (slice.pct > target + threshold) return '#ef4444';
    if (slice.pct < target - threshold) return '#f59e0b';
    return '#4caf50';
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
      const yearFilter = (e: any) => this.selectedYears.length === 0 || this.selectedYears.includes(e.year);
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
      return this.p2pRepayments.reduce((sum, r) => sum + this.p2pRepNetCredited(r), 0);
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

  get catNetDeployed(): number {
    return Math.round((this.catTotalInvested - this.catTotalSales) * 100) / 100;
  }

  get catXIRR(): number | null {
    const today = new Date();
    if (this.selectedCategory === 'Equity') {
      const eqCurr = this.equityFifoHoldings.reduce((s, h) => s + h.value, 0);
      const flows = [
        ...this.equityData.map(e => ({ date: new Date(e.date), amount: e.buy_sell === 'Buy' ? -(e.value || 0) : +(e.value || 0) })),
        { date: today, amount: eqCurr }
      ];
      return this.xirrSafe(flows);
    }
    if (this.selectedCategory === 'Mutual Funds') {
      const mfCurr = this.mfData.reduce((s, e) => s + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
      const flows = [
        ...this.mfData.map(e => ({ date: new Date(e.date), amount: e.buy_sell === 'Buy' ? -(e.buy_value || 0) : +(e.sell_value || 0) })),
        { date: today, amount: mfCurr }
      ];
      return this.xirrSafe(flows);
    }
    if (this.selectedCategory === 'Commodity') {
      const cmdCurr = this.commodityData.reduce((s, e) => s + this.calcInvestment(e.buy_quantity, e.sell_quantity, e.buy_value), 0);
      const flows = [
        ...this.commodityData.map(e => ({ date: new Date(e.date), amount: e.buy_sell === 'Buy' ? -(e.buy_value || 0) : +(e.sell_value || 0) })),
        { date: today, amount: cmdCurr }
      ];
      return this.xirrSafe(flows);
    }
    if (this.selectedCategory === 'P2P') {
      const p2pCurr = this.p2pOutstandingPrincipal;
      const flows = [
        ...this.p2pData.map(e => ({ date: new Date(e.date), amount: -(e.amount || 0) })),
        ...this.p2pRepayments.map(r => ({ date: new Date(r.date), amount: +this.p2pRepNetCredited(r) })),
        { date: today, amount: p2pCurr }
      ];
      return this.xirrSafe(flows);
    }
    if (this.selectedCategory === 'Fixed Deposits') {
      const fdCurr = this.fdData.filter(e => !e.return_value || e.return_value === 0).reduce((s, e) => s + (e.fd_value || 0), 0);
      const flows = [
        ...this.fdData.map(e => ({ date: new Date(e.date), amount: -(e.fd_value || 0) })),
        ...this.fdData.filter(e => (e.return_value || 0) > 0).map(e => ({ date: new Date(e.maturity_date || e.date), amount: +(e.return_value || 0) })),
        { date: today, amount: fdCurr }
      ];
      return this.xirrSafe(flows);
    }
    return null;
  }

  // Normalize all category entries to a common shape for calculations
  private get catEntries(): { group: Record<string, string>; buyQty: number | null; sellQty: number | null; buyVal: number | null; sellVal: number | null }[] {
    const yearFilter = (e: any) => this.selectedYears.length === 0 || this.selectedYears.includes(e.year);
    switch (this.selectedCategory) {
      case 'Equity':
        return this.equityData.filter(e => this.selectedYears.length === 0 || this.selectedYears.includes(this.dateToFY(e.date))).map(e => ({
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
          const repaid = this.p2pRepayments.filter(r => r.lending_id === e.lending_id).reduce((s, r) => s + this.p2pRepNetCredited(r), 0);
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

  toggleCapitalFlowsForm(): void {
    this.showCapitalFlowsForm = !this.showCapitalFlowsForm;
    if (!this.showCapitalFlowsForm) {
      this.resetCapitalFlowForm();
    }
  }

  resetCapitalFlowForm(): void {
    this.capitalFlowForm = {
      date: new Date().toISOString().split('T')[0],
      amount: '',
      type: 'Deposit',
      category: 'Equity/Commodity',
      remarks: ''
    };
  }

  submitCapitalFlow(): void {
    if (!this.capitalFlowForm.date || !this.capitalFlowForm.amount) {
      alert('Please fill in Date and Amount');
      return;
    }

    const amount = parseFloat(this.capitalFlowForm.amount);
    if (isNaN(amount) || amount <= 0) {
      alert('Please enter a valid amount');
      return;
    }

    const entry = {
      date: this.capitalFlowForm.date,
      amount: amount,
      type: this.capitalFlowForm.type,
      category: this.capitalFlowForm.category,
      remarks: this.capitalFlowForm.remarks || ''
    };

    this.submittingCapitalFlow = true;
    this.investmentService.addCapitalFlow(entry).subscribe({
      next: (response: any) => {
        // Add new entry to local data instead of full refresh
        const newEntry = { ...entry, id: response.id };
        this.capitalFlows = [newEntry, ...this.capitalFlows].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        
        // Recalculate summary locally
        const deposits = this.capitalFlows.filter(cf => cf.type === 'Deposit').reduce((sum, cf) => sum + cf.amount, 0);
        const withdrawals = this.capitalFlows.filter(cf => cf.type === 'Withdrawal').reduce((sum, cf) => sum + cf.amount, 0);
        this.capitalFlowsSummary = {
          total_deposits: deposits,
          total_withdrawals: withdrawals,
          actual_investment: deposits - withdrawals
        };
        
        this.submittingCapitalFlow = false;
        this.toggleCapitalFlowsForm();
      },
      error: (e) => { this.submittingCapitalFlow = false; alert('Error adding capital flow: ' + e.message); }
    });
  }

  deleteCapitalFlow(id: number): void {
    if (confirm('Are you sure you want to delete this entry?')) {
      this.investmentService.deleteCapitalFlow(id).subscribe({
        next: () => {
          // Remove entry from local data instead of full refresh
          const deletedEntry = this.capitalFlows.find(cf => cf.id === id);
          this.capitalFlows = this.capitalFlows.filter(cf => cf.id !== id);
          
          // Recalculate summary locally
          const deposits = this.capitalFlows.filter(cf => cf.type === 'Deposit').reduce((sum, cf) => sum + cf.amount, 0);
          const withdrawals = this.capitalFlows.filter(cf => cf.type === 'Withdrawal').reduce((sum, cf) => sum + cf.amount, 0);
          this.capitalFlowsSummary = {
            total_deposits: deposits,
            total_withdrawals: withdrawals,
            actual_investment: deposits - withdrawals
          };
        },
        error: (e) => alert('Error deleting entry: ' + e.message)
      });
    }
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
    const totalBuyUSD  = usaEquity.filter(e => e.buy_sell === 'Buy').reduce((s, e) => s + (e.value_usd || 0), 0);
    const totalSellUSD = usaEquity.filter(e => e.buy_sell === 'Sell').reduce((s, e) => s + (e.value_usd || 0), 0);
    return Math.round((totalBuyUSD - totalSellUSD) * 100) / 100;
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

