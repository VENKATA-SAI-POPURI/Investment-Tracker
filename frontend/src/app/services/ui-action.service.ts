import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UiActionService {
  private addEntry$ = new Subject<void>();
  addEntry = this.addEntry$.asObservable();

  triggerAddEntry() {
    this.addEntry$.next();
  }
}
