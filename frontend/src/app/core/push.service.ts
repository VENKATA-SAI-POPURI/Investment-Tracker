import { Injectable, computed, inject, signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { errorMessage } from './http';

/** Push alerts for big price moves, per device: subscribing needs the app's service worker (production
 *  builds), the browser's permission and VAPID keys on the server. */
@Injectable({ providedIn: 'root' })
export class PushService {
  private api = inject(ApiService);
  private sw = inject(SwPush);

  readonly serverReady = signal<boolean | null>(null);
  readonly devices = signal(0);
  readonly subscribed = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  private publicKey: string | null = null;
  private endpoint: string | null = null;

  /** Service worker running and the browser able to receive push (iPhone: only once added to the Home Screen). */
  readonly deviceSupported = this.sw.isEnabled && typeof window !== 'undefined' && 'PushManager' in window;
  readonly blocked = computed(() => typeof Notification !== 'undefined' && Notification.permission === 'denied');

  constructor() {
    if (this.deviceSupported) {
      this.sw.subscription.subscribe(sub => {
        this.endpoint = sub?.endpoint ?? null;
        this.subscribed.set(!!sub);
      });
    }
  }

  async load() {
    try {
      const c = await firstValueFrom(this.api.pushConfig());
      this.serverReady.set(c.available);
      this.devices.set(c.devices);
      this.publicKey = c.public_key;
    } catch (e) {
      this.serverReady.set(false);
      this.error.set(errorMessage(e));
    }
  }

  async enable(): Promise<boolean> {
    if (!this.deviceSupported || !this.publicKey) return false;
    this.busy.set(true);
    this.error.set(null);
    try {
      const sub = await this.sw.requestSubscription({ serverPublicKey: this.publicKey });
      const r = await firstValueFrom(this.api.pushSubscribe(sub.toJSON()));
      this.devices.set(r.devices);
      return true;
    } catch (e) {
      this.error.set(this.blocked() ? 'Notifications are blocked for this site in the browser settings.' : errorMessage(e));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** This device only, or every device signed in to this account. */
  async disable(everywhere = false) {
    this.busy.set(true);
    this.error.set(null);
    try {
      const endpoint = this.endpoint;
      if (endpoint) await this.sw.unsubscribe().catch(() => undefined);
      const r = await firstValueFrom(this.api.pushUnsubscribe(endpoint, everywhere));
      this.devices.set(r.devices);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async test(): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.pushTest());
      return true;
    } catch (e) {
      this.error.set(errorMessage(e));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
