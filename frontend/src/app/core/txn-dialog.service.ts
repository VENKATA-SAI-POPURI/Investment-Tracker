import { Injectable, signal } from '@angular/core';
import { AssetClass, Transaction } from './models';

export type AddKind = 'equity' | 'mutual_fund' | 'commodity' | 'p2p_loan' | 'p2p_repayment' | 'fixed_deposit' | 'forex' | 'dividend';

export interface TxnDialogState {
  mode: 'add' | 'edit';
  kind?: AddKind;
  instrumentId?: number;
  assetClass?: AssetClass;
  txn?: Transaction;
  type?: string;
}

/** Opens the global add/edit transaction dialog from anywhere. */
@Injectable({ providedIn: 'root' })
export class TxnDialogService {
  readonly state = signal<TxnDialogState | null>(null);
  add(kind?: AddKind, extra: Partial<TxnDialogState> = {}) { this.state.set({ mode: 'add', kind, ...extra }); }
  edit(txn: Transaction) { this.state.set({ mode: 'edit', txn }); }
  close() { this.state.set(null); }
}
