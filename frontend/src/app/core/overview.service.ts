import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { Overview } from './models';
import { readSnapshot, snapshotKey, writeSnapshot } from './snapshot';
import { StoreService } from './store.service';

/** The group overview (GET /overview) shared by Home, Portfolio and Analysis: drawn from this device's last copy at
 *  once, refreshed after every write, price refresh or family switch. */
@Injectable({ providedIn: 'root' })
export class OverviewService {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private store = inject(StoreService);

  readonly data = signal<Overview | null>(null);
  readonly loading = signal(false);
  private scope = '';
  private seq = 0;

  constructor() {
    effect(() => {
      this.store.version();
      const scope = this.store.scopeKey();
      if (!this.auth.token()) return;
      untracked(() => {
        if (scope !== this.scope) {
          this.scope = scope;
          this.data.set(readSnapshot<Overview>(snapshotKey('overview', scope)));
        }
        void this.load(scope);
      });
    });
  }

  private async load(scope: string) {
    const n = ++this.seq;
    this.loading.set(true);
    try {
      const o = await firstValueFrom(this.api.overview());
      if (n !== this.seq) return;
      this.data.set(o);
      writeSnapshot(snapshotKey('overview', scope), o);
    } catch { /* keep what is on screen */ } finally {
      if (n === this.seq) this.loading.set(false);
    }
  }
}
