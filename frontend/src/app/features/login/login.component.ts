import { ChangeDetectionStrategy, Component, NgZone, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { errorMessage } from '../../core/http';
import { IconComponent } from '../../shared/icon.component';

declare global { interface Window { google?: any; } }

const CLIENT_ID = '264259769121-grmgud6svdqkbi2o58rsoqmjg6f04cka.apps.googleusercontent.com';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <div class="panel">
        <span class="logo"><app-icon name="trend" [size]="24" /></span>
        <h1>Investment Tracker</h1>
        <p class="text-2">Every holding in one place — returns, tax, goals and what to do next.</p>
        @if (reason()) { <div class="notice warn"><app-icon name="info" [size]="16" /> {{ reason() }}</div> }
        <div id="google-signin-button" class="gbtn"></div>
        @if (loading()) { <p class="muted small">Signing you in…</p> }
        @if (error()) { <div class="notice bad"><app-icon name="alert" [size]="16" /> {{ error() }}</div> }
        @if (standalonePwa) {
          <p class="small muted">Sign-in not appearing? <a href (click)="openInBrowser($event)">Open in your browser</a>.</p>
        }
        <ul class="points">
          <li><app-icon name="pie" [size]="16" /> Allocation vs your targets, with a rebalancing plan</li>
          <li><app-icon name="chart" [size]="16" /> XIRR and benchmark comparison against Nifty and S&amp;P 500</li>
          <li><app-icon name="receipt" [size]="16" /> Capital-gains estimate and tax-harvesting ideas</li>
          <li><app-icon name="target" [size]="16" /> Goals with probability of success</li>
        </ul>
      </div>
    </div>`,
  styles: [`
    .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; background: radial-gradient(1200px 600px at 10% 0%, #6366f1 0%, transparent 60%), radial-gradient(900px 600px at 100% 100%, #7c3aed 0%, transparent 55%), #1e1b4b; }
    .panel { width: 100%; max-width: 420px; background: var(--surface); border-radius: 20px; box-shadow: 0 30px 80px rgba(15, 23, 42, .45); padding: 36px 30px; display: flex; flex-direction: column; gap: 14px; align-items: center; text-align: center; }
    .logo { display: inline-flex; width: 52px; height: 52px; border-radius: 14px; background: var(--hero); box-shadow: 0 10px 24px rgba(79, 70, 229, .35); color: #fff; align-items: center; justify-content: center; }
    .gbtn { min-height: 44px; display: flex; justify-content: center; }
    .notice { text-align: left; width: 100%; }
    .points { list-style: none; padding: 14px 0 0; margin: 0; border-top: 1px solid var(--border); width: 100%; display: grid; gap: 8px; text-align: left; font-size: 13px; color: var(--text-2); }
    .points li { display: flex; gap: 8px; align-items: center; }
    .points app-icon { color: var(--primary); }
  `],
})
export class LoginComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private zone = inject(NgZone);
  reason = signal<string | null>(inject(ActivatedRoute).snapshot.queryParamMap.get('reason'));
  loading = signal(false);
  error = signal<string | null>(null);
  standalonePwa = window.matchMedia?.('(display-mode: standalone)').matches ?? false;

  ngOnInit() {
    if (this.auth.isAuthenticated()) { this.router.navigate(['/']); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      if (!window.google) { this.zone.run(() => this.error.set('Could not load Google Sign-In.')); return; }
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: (r: any) => this.zone.run(() => this.onCredential(r?.credential)),
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      const el = document.getElementById('google-signin-button');
      if (el) window.google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', width: 300, text: 'signin_with' });
    };
    script.onerror = () => this.zone.run(() => this.error.set('Failed to load Google Sign-In. Check your connection.'));
    document.head.appendChild(script);
  }

  private onCredential(credential?: string) {
    if (!credential) { this.error.set('No credential received from Google. Please try again.'); return; }
    this.loading.set(true);
    this.error.set(null);
    this.auth.loginWithGoogle(credential).subscribe({
      next: () => { this.loading.set(false); this.router.navigate(['/']); },
      error: e => { this.loading.set(false); this.error.set(errorMessage(e)); },
    });
  }

  openInBrowser(ev: Event) {
    ev.preventDefault();
    window.open(window.location.href, '_blank');
  }
}
