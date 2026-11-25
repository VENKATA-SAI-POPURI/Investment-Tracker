import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AddKind, TxnDialogService } from '../../core/txn-dialog.service';
import { IconComponent } from '../icon.component';

interface Tile { label: string; icon: string; color: string; kind: AddKind; market?: string; }

/** "What would you like to add?": pick the kind first, then the familiar form opens on it. */
@Component({
  selector: 'v-add-sheet',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="v-dim" (click)="dialog.closePicker()"></div>
    <section class="v-sheet center" role="dialog" aria-modal="true" aria-labelledby="add-title">
      <div class="grab"></div>
      <button class="close" (click)="dialog.closePicker()" aria-label="Close"><app-icon name="close" [size]="16" /></button>
      <h2 id="add-title">Add an entry</h2>
      <p class="v-mut sub">What would you like to add?</p>
      <div class="tiles">
        @for (t of tiles; track t.label) {
          <button class="tile" [style.--c]="t.color" (click)="pick(t)"><span class="bi"><app-icon [name]="t.icon" [size]="20" [stroke]="2" /></span>{{ t.label }}</button>
        }
      </div>
      <div class="more">
        @for (m of more; track m.label) { <button class="v-btn sm" (click)="dialog.add(m.kind)">{{ m.label }}</button> }
      </div>
      <button class="import" (click)="importIt()">
        <span class="v-tone brand" style="background:#fff"><app-icon name="upload" [size]="19" /></span>
        <span class="grow"><b>Import a statement</b><small>CAS · Kite · EPF passbook · LenDenClub · CSV</small></span>
        <app-icon name="chevronRight" [size]="18" [stroke]="2.4" />
      </button>
    </section>
  `,
  styles: [`
    h2 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -.02em; }
    .sub { font-size: 13.5px; font-weight: 500; margin: 2px 0 16px; }
    .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .tile { border-radius: 18px; padding: 14px 6px 12px; text-align: center; font: inherit; font-size: 12.5px; font-weight: 700; border: 0; cursor: pointer;
      background: color-mix(in srgb, var(--c) 9%, white); color: var(--text); display: flex; flex-direction: column; align-items: center; }
    .bi { width: 42px; height: 42px; border-radius: 14px; margin-bottom: 8px; display: grid; place-items: center; color: #fff; background: var(--c);
      box-shadow: 0 6px 14px color-mix(in srgb, var(--c) 40%, transparent); }
    .more { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .import { display: flex; align-items: center; gap: 12px; width: 100%; background: var(--accent-soft); border-radius: 18px; padding: 13px;
      margin-top: 12px; border: 0; cursor: pointer; font: inherit; text-align: left; color: var(--accent); }
    .import .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; color: var(--text); }
    .import small { color: var(--muted); font-size: 12.5px; font-weight: 500; }
  `],
})
export class AddSheetComponent {
  dialog = inject(TxnDialogService);
  private router = inject(Router);

  tiles: Tile[] = [
    { label: 'India stock', icon: 'trendUp', color: 'var(--g-equity_india)', kind: 'equity', market: 'India' },
    { label: 'Global stock', icon: 'globe', color: 'var(--g-equity_global)', kind: 'equity', market: 'USA' },
    { label: 'Mutual fund', icon: 'pieChart', color: 'var(--g-mutual_funds)', kind: 'mutual_fund' },
    { label: 'P2P loan', icon: 'handshake', color: 'var(--g-p2p)', kind: 'p2p_loan' },
    { label: 'Commodity', icon: 'gem', color: 'var(--g-commodities)', kind: 'commodity' },
    { label: 'EPF', icon: 'piggy', color: 'var(--g-epf)', kind: 'epf' },
    { label: 'Fixed deposit', icon: 'landmark', color: 'var(--g-others)', kind: 'fixed_deposit' },
    { label: 'NPS', icon: 'shieldCheck', color: 'var(--g-others)', kind: 'nps' },
    { label: 'USD transfer', icon: 'arrowLeftRight', color: 'var(--g-others)', kind: 'forex' },
  ];
  more: { label: string; kind: AddKind }[] = [
    { label: 'Dividend', kind: 'dividend' }, { label: 'P2P repayment', kind: 'p2p_repayment' }, { label: 'Bonus / split', kind: 'corporate_action' },
  ];

  pick(t: Tile) { this.dialog.add(t.kind, t.market ? { market: t.market } : {}); }

  importIt() { this.dialog.closePicker(); void this.router.navigateByUrl('/import'); }

  @HostListener('document:keydown.escape') esc() { this.dialog.closePicker(); }
}
