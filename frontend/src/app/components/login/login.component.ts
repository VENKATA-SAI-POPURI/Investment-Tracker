import { Component, NgZone, OnInit, ViewEncapsulation } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';

declare global {
  interface Window {
    google: any;
  }
}

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
  encapsulation: ViewEncapsulation.None
})
export class LoginComponent implements OnInit {
  loading = false;
  error = '';
  isPwaStandalone = false;
  isIosPwa = false;

  private readonly CLIENT_ID = '264259769121-grmgud6svdqkbi2o58rsoqmjg6f04cka.apps.googleusercontent.com';

  constructor(
    private authService: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    private ngZone: NgZone
  ) {}

  ngOnInit(): void {
    // Detect PWA standalone mode
    this.isPwaStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    this.isIosPwa =
      (window.navigator as any).standalone === true &&
      /iphone|ipad|ipod/i.test(window.navigator.userAgent);

    // Handle token passed back from redirect-based OAuth flow
    this.route.queryParams.subscribe(params => {
      if (params['token']) {
        this.loading = true;
        try {
          const user = params['user'] ? JSON.parse(decodeURIComponent(params['user'])) : null;
          this.authService.restoreSession(params['token'], user);
          // Clean URL then navigate
          window.history.replaceState({}, '', window.location.pathname);
          this.router.navigate(['/']);
        } catch {
          this.loading = false;
          this.error = 'Session restore failed. Please try again.';
        }
        return;
      }
      if (params['error']) {
        const msgs: Record<string, string> = {
          access_denied: 'Your email is not authorised to access this app.',
          invalid_token: 'Google sign-in token was invalid. Please try again.',
          no_credential: 'No credential received from Google.',
          session_failed: 'Could not create a session. Please try again.',
        };
        this.error = msgs[params['error']] || 'Login failed. Please try again.';
      }
    });

    // If already authenticated, redirect to dashboard
    if (this.authService.isAuthenticated()) {
      this.router.navigate(['/']);
      return;
    }

    // Load Google Sign-In script
    this.loadGoogleSignIn();
  }

  private loadGoogleSignIn(): void {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;

    script.onload = () => {
      if (!window.google) {
        this.ngZone.run(() => { this.error = 'Could not load Google Sign-In. Check your connection.'; });
        return;
      }

      window.google.accounts.id.initialize({
        client_id: this.CLIENT_ID,
        callback: (response: any) => {
          this.ngZone.run(() => this.handleCredentialResponse(response));
        },
        auto_select: false,
        cancel_on_tap_outside: true,
      });

      const buttonContainer = document.getElementById('google-signin-button');
      if (buttonContainer) {
        window.google.accounts.id.renderButton(buttonContainer, {
          theme: 'outline',
          size: 'large',
          width: '300',
          locale: 'en_US',
          text: 'signin',
        });
      }
    };

    script.onerror = () => {
      this.ngZone.run(() => { this.error = 'Failed to load Google Sign-In script. Check your connection.'; });
    };

    document.head.appendChild(script);
  }

  /** Opens the app URL in the system browser so Google Sign-In works on iOS PWA */
  openInBrowser(): void {
    window.open(window.location.href, '_blank');
  }

  private handleCredentialResponse(response: any): void {
    if (!response.credential) {
      this.error = 'No credential received from Google. Please try again.';
      return;
    }

    this.loading = true;
    this.error = '';

    this.authService.loginWithGoogle(response.credential).subscribe({
      next: () => {
        this.loading = false;
        this.router.navigate(['/']);
      },
      error: (err: any) => {
        this.loading = false;
        this.error = err.error?.error || err.message || 'Login failed. Please try again.';
      }
    });
  }
}
