import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UiActionService {
  private addEntry$ = new Subject<string>();
  addEntry = this.addEntry$.asObservable();

  private refresh$ = new Subject<void>();
  refresh = this.refresh$.asObservable();

  private refreshDone$ = new Subject<void>();
  refreshDone = this.refreshDone$.asObservable();
  private pendingRefresh = 0;

  triggerAddEntry(page: string) {
    this.addEntry$.next(page);
  }

  triggerRefresh() {
    this.refresh$.next();
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
