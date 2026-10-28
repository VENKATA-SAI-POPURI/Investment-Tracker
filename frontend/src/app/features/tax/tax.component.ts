import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { FORMAT_PIPES, downloadCsv } from '../../core/format';
import { errorMessage } from '../../core/http';
import { TaxReport } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { IconComponent } from '../../shared/icon.component';

const TAX_LABEL: Record<string, string | undefined> = {
  equity: 'Indian equity', foreign_equity: 'Foreign equity', listed_other: 'Gold / other ETF', debt: 'Debt fund', income: 'Income',
};
const INCOME_LABEL: Record<string, string | undefined> = { dividends: 'Dividends', p2p_interest: 'P2P interest', fd_interest: 'FD interest' };

@Component({
  selector: 'app-tax',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tax.component.html',
})
export class TaxComponent {
  store = inject(StoreService);
  private api = inject(ApiService);
  fy = signal<string | undefined>(undefined);
  report = signal<TaxReport | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  termFilter = signal('');
  tab = signal<'save' | 'gains' | 'estimate'>('save');
  taxLabel = TAX_LABEL;
  incomeLabel = INCOME_LABEL;

  r = computed(() => this.report());
  lots = computed(() => (this.r()?.realized ?? []).filter(l => !this.termFilter() || l.term === this.termFilter()));
  incomeRows = computed(() => Object.entries(this.r()?.income ?? {}).filter(([, v]) => v));
  /** Tax lines with a share of the total, largest first. */
  taxLines = computed(() => {
    const r = this.r();
    const term = (g: string) => g === 'LT' ? 'Long-term' : 'Short-term';
    const lines = (r?.tax_lines ?? []).filter(l => l.tax > 0).map(l => ({
      label: `${term(l.group)} ${l.slab ? 'gains, other' : 'equity gains'}`, rate: l.slab ? 'your slab' : `${l.rate}%`, tax: l.tax }));
    if (r?.estimate.income_tax) lines.push({ label: 'Dividends & interest', rate: 'your slab', tax: r.estimate.income_tax });
    const max = Math.max(...lines.map(l => l.tax), 1);
    return lines.map(l => ({ ...l, share: l.tax / max * 100 })).sort((a, b) => b.tax - a.tax);
  });
  gainsByTerm = computed(() => {
    const out = { STCG: 0, LTCG: 0, Intraday: 0 } as Record<string, number>;
    for (const l of this.r()?.realized ?? []) out[l.term] = (out[l.term] ?? 0) + l.gain;
    return out;
  });
  isCurrentFy = computed(() => !!this.r() && this.r()!.years[0] === this.r()!.fy);
  activeTab = computed(() => this.tab() === 'save' && !this.isCurrentFy() ? 'gains' : this.tab());

  constructor() {
    effect(() => {
      const fy = this.fy();
      this.store.version();
      queueMicrotask(() => this.load(fy));
    });
  }

  async load(fy?: string) {
    this.loading.set(true);
    try { this.report.set(await firstValueFrom(this.api.tax(fy))); this.error.set(null); }
    catch (e) { this.error.set(errorMessage(e)); }
    finally { this.loading.set(false); }
  }

  export() {
    const r = this.r()!;
    downloadCsv(`capital-gains-${r.fy}.csv`, [
      ['Name', 'Tax class', 'Bought', 'Sold', 'Days held', 'Units', 'Cost', 'Proceeds', 'Gain', 'Term', 'Rate %'],
      ...r.realized.map(l => [l.name, TAX_LABEL[l.tax_class] ?? l.tax_class, l.buy_date, l.sell_date, l.holding_days, l.qty, l.cost, l.proceeds, l.gain, l.term,
        l.rate === null ? 'slab' : (l.rate * 100).toFixed(1)]),
    ]);
  }
}
