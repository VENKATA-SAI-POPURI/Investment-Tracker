import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { errorMessage } from './http';
import { Portfolio, Settings } from './models';
import { ToastService } from './toast.service';

/** App-wide data: portfolio snapshot + settings. Pages read signals; writes call `reload()`. */
@Injectable({ providedIn: 'root' })
export class StoreService {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);

  readonly portfolio = signal<Portfolio | null>(null);
  readonly settings = signal<Settings>({ segments: [] });
  readonly loading = signal(false);
  readonly refreshingPrices = signal(false);
  readonly error = signal<string | null>(null);
  /** Bumped after any write so pages holding their own data can refetch. */
  readonly version = signal(0);

  readonly positions = computed(() => this.portfolio()?.positions ?? []);
  readonly openPositions = computed(() => this.positions().filter(p => p.is_open));
  readonly targets = computed(() => this.settings().targetAllocation ?? {});

  constructor() {
    // Reload whenever the signed-in identity or "view as" changes
    effect(() => {
      const key = `${this.auth.token()}|${this.auth.viewAs()?.email ?? ''}`;
      if (this.auth.token()) {
        void key;
        this.portfolio.set(null);
        queueMicrotask(() => this.init());
      }
    });
  }

  async init() {
    await this.reload();
    void this.refreshPrices(false);
  }

  async reload() {
    this.loading.set(true);
    try {
      const [p, s] = await Promise.all([firstValueFrom(this.api.portfolio()), firstValueFrom(this.api.settings())]);
      this.portfolio.set(p);
      this.settings.set(s);
      this.error.set(null);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Called after every successful write. */
  async changed() {
    this.version.update(v => v + 1);
    await this.reload();
  }

  async refreshPrices(force: boolean) {
    if (this.refreshingPrices()) return;
    this.refreshingPrices.set(true);
    try {
      const r = await firstValueFrom(this.api.refreshPrices(force));
      if (r.refreshed) {
        await this.reload();
        this.version.update(v => v + 1);
        if (force) this.toast.ok(`Prices updated${r.failed?.length ? ` · ${r.failed.length} symbol(s) failed` : ''}`);
      } else if (force) {
        this.toast.ok('Prices are already up to date');
      }
    } catch (e) {
      if (force) this.toast.error(errorMessage(e));
    } finally {
      this.refreshingPrices.set(false);
    }
  }

  async saveSetting(key: string, value: unknown) {
    await firstValueFrom(this.api.saveSetting(key, value));
    this.settings.update(s => ({ ...s, [key]: value }));
    await this.changed();
  }
}
