import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { AuthService } from './services/auth.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet></router-outlet>`,
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit, OnDestroy {
  private static readonly TAB_KEY = 'investment-app-tabs';

  constructor(private authService: AuthService, private router: Router) {}

  ngOnInit(): void {
    const count = parseInt(localStorage.getItem(AppComponent.TAB_KEY) || '0', 10);
    localStorage.setItem(AppComponent.TAB_KEY, String(count + 1));
    window.addEventListener('beforeunload', this.onBeforeUnload);

    // If a token is stored, verify it is still accepted by the backend.
    // A silent 401 (e.g. JWT_SECRET rotated on Render) would otherwise let the
    // user reach the dashboard, immediately get logged out by the interceptor,
    // and then appear to be stuck on the login screen after re-authenticating.
    if (this.authService.getToken()) {
      this.authService.verifyToken().subscribe({
        error: () => {
          // Token rejected — clear it so the login screen starts clean
          this.authService.logout();
          this.router.navigate(['/login']);
        }
      });
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeunload', this.onBeforeUnload);
  }

  private onBeforeUnload = (): void => {
    const count = parseInt(localStorage.getItem(AppComponent.TAB_KEY) || '1', 10);
    const remaining = count - 1;
    localStorage.setItem(AppComponent.TAB_KEY, String(remaining));

    // Only shut down servers when the last tab is closed
    if (remaining <= 0) {
      localStorage.removeItem(AppComponent.TAB_KEY);
      // Disabled during development - use stop.vbs to stop servers
      // navigator.sendBeacon('http://localhost:5001/api/shutdown');
    }
  };
}
