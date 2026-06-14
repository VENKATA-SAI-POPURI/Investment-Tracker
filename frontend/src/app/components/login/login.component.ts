import { Component, NgZone, OnInit, ViewEncapsulation } from '@angular/core';
import { Router } from '@angular/router';
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

  constructor(
    private authService: AuthService,
    private router: Router,
    private ngZone: NgZone
  ) {}

  ngOnInit(): void {
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
      if (window.google) {
        window.google.accounts.id.initialize({
          client_id: '264259769121-grmgud6svdqkbi2o58rsoqmjg6f04cka.apps.googleusercontent.com',
          callback: (response: any) => {
            // Google's GSI callback fires outside Angular's NgZone — wrap it
            // so that change detection runs properly after login.
            this.ngZone.run(() => this.handleCredentialResponse(response));
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        });

        // Render the button
        const buttonContainer = document.getElementById('google-signin-button');
        if (buttonContainer) {
          window.google.accounts.id.renderButton(
            buttonContainer,
            {
              theme: 'outline',
              size: 'large',
              width: '300',
              locale: 'en_US',
              text: 'signin',
            }
          );
        } else {
          console.error('[login] Button container not found!');
        }
      } else {
        console.error('[login] window.google not available');
      }
    };

    script.onerror = () => {
      console.error('[login] Failed to load Google GSI script');
    };

    document.head.appendChild(script);
  }

  private handleCredentialResponse(response: any): void {
    if (response.credential) {
      this.loading = true;
      this.error = '';

      this.authService.loginWithGoogle(response.credential).subscribe({
        next: (res: any) => {
          this.loading = false;
          // Redirect to dashboard
          this.router.navigate(['/']);
        },
        error: (err: any) => {
          this.loading = false;
          this.error = err.error?.error || 'Login failed. Please try again.';
        }
      });
    } else {
      console.error('[login] No credential in response:', response);
      this.error = 'No credential received from Google';
    }
  }
}
