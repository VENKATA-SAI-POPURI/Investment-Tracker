import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UiActionService {
  private addEntry$ = new Subject<string>();
  addEntry = this.addEntry$.asObservable();

  private refresh$ = new Subject<void>();
  refresh = this.refresh$.asObservable();

  private refreshDone$ = new Subject<void>();
  refreshDone = this.refreshDone$.asObservable();
  private pendingRefresh = 0;

  // Shared live price stores — components subscribe to these so prices
  // are available even if the component hasn't been visited yet.
  equityPrices$ = new BehaviorSubject<Record<string, number | null>>({});
  mfPrices$ = new BehaviorSubject<Record<string, number | null>>({});
  commodityPrices$ = new BehaviorSubject<Record<string, number | null>>({});

  private silentRefresh$ = new Subject<void>();
  /** Emitted after any data mutation so the dashboard can quietly re-fetch totals. */
  silentRefresh = this.silentRefresh$.asObservable();

  triggerAddEntry(page: string) {
    this.addEntry$.next(page);
  }

  triggerRefresh() {
    this.refresh$.next();
  }

  triggerSilentRefresh() {
    this.silentRefresh$.next();
  }

  beginRefresh(): void {
    this.pendingRefresh++;
  }

  endRefresh(): void {
    if (--this.pendingRefresh <= 0) {
      this.pendingRefresh = 0;
      this.refreshDone$.next();
    }
  }
}
