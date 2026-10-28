import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES, downloadCsv } from '../../core/format';
import { AssetClass, CLASS_LABEL, Position } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../../shared/icon.component';
import { SortState } from '../../shared/ui';

interface Group { key: string; value: number; pct: number; count: number; }

@Component({
  selector: 'app-holdings',
  standalone: true,
  imports: [FormsModule, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './holdings.component.html',
  styles: [`
    .bars { display: grid; gap: 10px; }
    .bar-row { display: grid; grid-template-columns: minmax(90px, 160px) 1fr 70px; gap: 10px; align-items: center; font-size: 13px; }
    .track { height: 10px; background: var(--surface-2); border-radius: 0 4px 4px 0; overflow: hidden; }
    .track > span { display: block; height: 100%; background: var(--s1); border-radius: 0 4px 4px 0; }
  `],
})
export class HoldingsComponent {
  assetClass = input.required<AssetClass>();
  store = inject(StoreService);
  auth = inject(AuthService);
  dialog = inject(TxnDialogService);
  private router = inject(Router);

  q = signal('');
  showClosed = signal(false);
  market = signal<'all' | 'India' | 'USA'>('all');
  groupBy = signal<string>('sector');
  sort = new SortState<Position>('value');

  title = computed(() => CLASS_LABEL[this.assetClass()] ?? 'Holdings');
  groupOptions = computed(() => this.assetClass() === 'equity'
    ? [['sector', 'Sector'], ['market_cap', 'Market cap'], ['market', 'Market']]
    : this.assetClass() === 'mutual_fund' ? [['category', 'Category'], ['sub_category', 'SIP / lump sum'], ['tax_class', 'Tax treatment']]
    : [['category', 'Commodity']]);

  all = computed(() => this.store.positions().filter(p => p.asset_class === this.assetClass()));
  rows = computed(() => {
    const q = this.q().trim().toLowerCase();
    const rows = this.all().filter(p =>
      (this.showClosed() || p.is_open) &&
      (this.market() === 'all' || (p.market ?? 'India') === this.market()) &&
      (!q || p.name.toLowerCase().includes(q) || (p.symbol ?? '').toLowerCase().includes(q) || (p.sector ?? '').toLowerCase().includes(q)));
    return this.sort.apply(rows);
  });
  open = computed(() => this.rows().filter(p => p.is_open));
  totals = computed(() => {
    const r = this.open();
    const sum = (k: keyof Position) => r.reduce((a, p) => a + ((p[k] as number) || 0), 0);
    const cost = sum('cost'), unreal = sum('unrealized');
    return { value: sum('value'), cost, unrealized: unreal, unrealizedPct: cost ? (unreal / cost) * 100 : null,
      day: sum('day_change'), realized: this.rows().reduce((a, p) => a + p.realized + p.income, 0), weight: sum('weight') };
  });
  groups = computed<Group[]>(() => {
    const key = this.groupBy() as keyof Position;
    const map = new Map<string, Group>();
    const total = this.totals().value || 1;
    for (const p of this.open()) {
      const k = (p[key] as string) || 'Unclassified';
      const g = map.get(k) ?? { key: k, value: 0, pct: 0, count: 0 };
      g.value += p.value; g.count++;
      map.set(k, g);
    }
    return [...map.values()].map(g => ({ ...g, pct: (g.value / total) * 100 })).sort((a, b) => b.value - a.value);
  });
  maxGroup = computed(() => Math.max(...this.groups().map(g => g.pct), 1));
  hasUsd = computed(() => this.all().some(p => p.market === 'USA'));

  openRow(p: Position) { this.router.navigate(['/holding', p.id]); }
  add() { this.dialog.add(this.assetClass() as any); }

  export() {
    downloadCsv(`${this.assetClass()}-holdings.csv`, [
      ['Name', 'Symbol', 'Market', 'Sector/Category', 'Quantity', 'Avg cost', 'Price', 'Value', 'Cost', 'Unrealized', 'Unrealized %', 'Realized', 'Income', 'XIRR %', 'Weight %'],
      ...this.rows().map(p => [p.name, p.symbol, p.market, p.sector ?? p.category, p.quantity, p.avg_cost, p.price, p.value, p.cost,
        p.unrealized, p.unrealized_pct, p.realized, p.income, p.xirr, p.weight]),
    ]);
  }
}
