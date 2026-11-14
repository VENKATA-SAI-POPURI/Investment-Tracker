import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ActionService } from './action.service';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { errorMessage } from './http';
import { Action, ActionCta, AssetClass } from './models';
import { StoreService } from './store.service';
import { ToastService } from './toast.service';
import { AddKind, TxnDialogService } from './txn-dialog.service';

const ADD_KINDS: AddKind[] = ['equity', 'mutual_fund', 'commodity', 'p2p_loan', 'p2p_repayment', 'fixed_deposit', 'forex', 'dividend',
  'epf', 'nps', 'corporate_action'];

/** The add-dialog kind for a holding's asset class. */
export function kindFor(ac: AssetClass | undefined, type: string | null | undefined): AddKind | undefined {
  switch (ac) {
    case 'equity': case 'mutual_fund': case 'commodity': case 'epf': case 'nps': return ac;
    case 'p2p': return type === 'REPAYMENT' ? 'p2p_repayment' : 'p2p_loan';
    case 'fixed_deposit': return 'fixed_deposit';
    case 'cash': return 'forex';
    default: return undefined;
  }
}

/** Actions whose advice is to hold (tax:wait-lt): recording a sale from their what-if must not mark them done. */
export function holdAdvice(id: string): boolean { return id.startsWith('tax:wait-lt:'); }

/**
 * Turns an action's CTA into the thing it promises (Part 2 §9.3):
 * a prefilled transaction dialog, a route, an API call, the what-if modal (P1) or the FD-matured dialog.
 * Saves made through a dialog that carries `actionId` come back through `dialogSaved` and mark the action done.
 */
@Injectable({ providedIn: 'root' })
export class ActionRunnerService {
  private router = inject(Router);
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private store = inject(StoreService);
  private toast = inject(ToastService);
  private dialog = inject(TxnDialogService);
  private actions = inject(ActionService);

  /** Runs the action's CTA. Guests are sent to the evidence page instead of anything that writes. */
  async run(action: Action, cta: ActionCta | null = action.cta): Promise<void> {
    if (!cta) { this.open(action.link); return; }
    const writes = cta.type === 'dialog' || cta.type === 'fd_mature' || cta.api === 'review_complete';
    if (writes && !this.auth.canWrite()) { this.open(action.link); return; }

    switch (cta.type) {
      case 'route':
        if (cta.route) this.navigate(cta);
        else this.open(action.link);
        return;
      case 'dialog': {
        const d = cta.dialog ?? {};
        const instrumentId = d.instrumentId ?? action.instrument_id ?? undefined;
        const pos = instrumentId ? this.store.positions().find(p => p.id === instrumentId) : undefined;
        const kind = (d.kind && (ADD_KINDS as string[]).includes(d.kind) ? d.kind as AddKind : undefined) ?? kindFor(pos?.asset_class, d.type);
        this.dialog.add(kind, {
          instrumentId, type: d.type ?? undefined, amount: d.amount ?? null, quantity: d.quantity ?? null,
          date: d.date ?? null, notes: d.notes ?? null, actionId: action.id,
        });
        return;
      }
      case 'api':
        if (cta.api === 'prices_refresh') {
          await this.store.refreshPrices(true);
          void this.actions.reload();
        } else if (cta.api === 'review_complete') {
          try {
            await firstValueFrom(this.api.completeReview());
            this.toast.ok('Review marked done');
            await this.store.changed();
          } catch (e) { this.toast.error(errorMessage(e)); }
        }
        return;
      case 'whatif': {
        // a read, so guests may open it too; "Record this sale" inside is for writers only (H17)
        const instrumentId = cta.whatif?.instrument_id ?? action.instrument_id;
        if (!instrumentId) { this.open(action.link); return; }
        // only a ranked action can be marked done: page-made placeholders (Actions' tax cards) carry no id onward.
        // Nor can advice to hold: a sale recorded from "Hold N more days" is the opposite of it (W4 review).
        const actionId = this.actions.find(action.id) && !holdAdvice(action.id) ? action.id : undefined;
        this.dialog.openWhatIf({ instrumentId, qty: cta.whatif?.qty ?? null, actionId });
        return;
      }
      case 'fd_mature': {
        const id = cta.instrument_id ?? cta.dialog?.instrumentId ?? action.instrument_id;
        if (id) this.dialog.openFdMature(id, action.id);
        else this.open(action.link);
        return;
      }
    }
  }

  /** `route` CTA: query and fragment travel separately, so `/actions?new_money=X#deploy` is built correctly (A13). */
  navigate(cta: Pick<ActionCta, 'route' | 'query' | 'fragment'>): void {
    if (!cta.route) return;
    void this.router.navigate([cta.route], { queryParams: cta.query ?? undefined, fragment: cta.fragment ?? undefined });
  }

  /** A raw link string ("/actions?new_money=5000#deploy"): navigateByUrl parses `?` before `#` (A13). */
  open(link: string | null | undefined): void {
    if (link) void this.router.navigateByUrl(link);
  }

  /** The dialog saved for `actionId`: mark it done with the new transaction ids as evidence (§8.4). */
  dialogSaved(actionId: string, txnIds: number[]): Promise<boolean> {
    return this.actions.setStatus(actionId, txnIds.length
      ? { status: 'done', txn_ids: txnIds, evidence: { txn_ids: txnIds } }
      : { status: 'done' });
  }
}
