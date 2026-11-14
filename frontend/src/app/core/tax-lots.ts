/**
 * Pure tax-lot helpers shared by Tax and Actions (W5 review fixes). Both pages prefill the what-if sale, which the
 * backend matches FIFO (`tax.what_if_sale` → `run_fifo`), so the units they send must reach the lots they name.
 * Living here keeps the import graph one-way: Tax imports from Actions, and neither imports the other for these.
 */
import { OpenLotTax } from './models';

/**
 * `actions.HARVEST_FLOOR` (A12): below this much unused long-term exemption, `tax:ltcg-harvest` closes and the
 * pages say the allowance is used up.
 */
export const HARVEST_FLOOR = 2000;

/** Is this year's long-term equity exemption used up, by A12's one floor? */
export function exemptionUsedUp(remaining: number | null | undefined): boolean {
  return (remaining ?? 0) < HARVEST_FLOOR;
}

type LotRef = Pick<OpenLotTax, 'instrument_id' | 'date' | 'qty'>;

/** A holding's open lots in FIFO order: oldest first, ties in listed order (as `open_lot_view` lists them). */
function fifo(instrumentId: number, openLots: readonly OpenLotTax[]): OpenLotTax[] {
  return openLots.map((l, i) => ({ l, i }))
    .filter(x => x.l.instrument_id === instrumentId)
    .sort((a, b) => a.l.date.localeCompare(b.l.date) || a.i - b.i)
    .map(x => x.l);
}

/** Σ qty of `lots[0..k]`, rounded to 6 places like the backend. */
function through(lots: readonly OpenLotTax[], k: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += lots[i].qty;
  return Math.round(sum * 1e6) / 1e6;
}

/**
 * Units to sell so that a FIFO sale reaches `lot`: every older open lot of the holding plus this one. A sale always
 * consumes the oldest lots first, so a lot's own quantity alone would sell other lots (as J14's "Sell up to here").
 * Falls back to the lot's own quantity when the holding's lots are not listed.
 */
export function unitsUpTo(lot: LotRef, openLots: readonly OpenLotTax[]): number {
  const mine = fifo(lot.instrument_id, openLots);
  const k = mine.findIndex(l => l.date === lot.date && Math.abs(l.qty - lot.qty) < 1e-9);
  return k < 0 ? lot.qty : through(mine, k);
}

/**
 * Units to sell so that a FIFO sale books every loss lot of an "Offset gains with losses" row. The row's `qty` sums
 * only the lots below cost (`tax.harvesting`), wherever they sit in FIFO order, so selling just that many would sell
 * the oldest lots, often in gain. This is the cumulative quantity up to and including the newest sellable loss lot
 * (older lots in gain go too). Falls back to the row's `qty` when the holding's lots are not listed.
 */
export function lossSaleQty(row: { instrument_id: number; qty: number }, openLots: readonly OpenLotTax[], todayIso: string): number {
  const mine = fifo(row.instrument_id, openLots);
  let k = -1;
  mine.forEach((l, i) => { if (l.gain < 0 && (!l.locked_until || l.locked_until <= todayIso)) k = i; });
  return k < 0 ? row.qty : through(mine, k);
}
