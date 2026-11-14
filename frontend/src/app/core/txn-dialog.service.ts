import { Injectable, signal } from '@angular/core';
import { AssetClass, Transaction } from './models';

export type AddKind = 'equity' | 'mutual_fund' | 'commodity' | 'p2p_loan' | 'p2p_repayment' | 'fixed_deposit' | 'forex' | 'dividend'
  | 'epf' | 'nps' | 'corporate_action';

export interface TxnDialogState {
  mode: 'add' | 'edit';
  kind?: AddKind;
  instrumentId?: number;
  assetClass?: AssetClass;
  txn?: Transaction;
  type?: string;
  /** Prefills for an add (e.g. a SIP instalment from an action); the user still confirms them. */
  amount?: number | null;
  quantity?: number | null;
  date?: string | null;
  notes?: string | null;
  /** The action this save fulfils: after a save the shell marks it done with the new transaction ids. */
  actionId?: string;
}

/** The global "Mark matured" dialog for a fixed deposit (A19). */
export interface FdMatureState { instrumentId: number; actionId?: string; }

/**
 * The global what-if sale modal (H17). Unset fields take the D16 defaults: the held quantity, the holding's
 * price and today. `actionId` is passed on to "Record this sale", so that save marks the action done.
 */
export interface WhatIfState { instrumentId: number; qty?: number | null; price?: number | null; date?: string | null; actionId?: string; }

/** Opens the global add/edit transaction dialog, the FD-matured dialog and the what-if sale modal from anywhere. */
@Injectable({ providedIn: 'root' })
export class TxnDialogService {
  readonly state = signal<TxnDialogState | null>(null);
  readonly fdMature = signal<FdMatureState | null>(null);
  readonly whatIf = signal<WhatIfState | null>(null);
  add(kind?: AddKind, extra: Partial<TxnDialogState> = {}) { this.state.set({ mode: 'add', kind, ...extra }); }
  edit(txn: Transaction) { this.state.set({ mode: 'edit', txn }); }
  close() { this.state.set(null); }
  openFdMature(instrumentId: number, actionId?: string) { this.fdMature.set({ instrumentId, actionId }); }
  closeFdMature() { this.fdMature.set(null); }
  openWhatIf(s: WhatIfState) { this.whatIf.set({ ...s }); }
  closeWhatIf() { this.whatIf.set(null); }
}
