import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthUser } from './models';

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';
const VIEW_AS_KEY = 'view_as';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (key === TOKEN_KEY ? (raw as T) : JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);

  readonly token = signal<string | null>(read<string>(TOKEN_KEY));
  readonly user = signal<AuthUser | null>(read<AuthUser>(USER_KEY));
  /** Admin "view as": the email whose data is shown; requests carry X-View-As. */
  readonly viewAs = signal<AuthUser | null>(read<AuthUser>(VIEW_AS_KEY));

  readonly isAuthenticated = computed(() => !!this.token());
  readonly realRole = computed(() => this.user()?.role ?? 'guest');
  /** Effective role for the data being viewed. */
  readonly role = computed(() => this.viewAs()?.role ?? this.realRole());
  readonly canWrite = computed(() => this.role() !== 'guest');
  readonly isAdmin = computed(() => this.realRole() === 'admin');

  loginWithGoogle(credential: string) {
    return this.http.post<{ token: string; user: AuthUser }>(`${environment.apiUrl}/auth/google-login`, { token: credential })
      .pipe(tap(res => {
        this.store(TOKEN_KEY, res.token);
        this.store(USER_KEY, res.user);
        this.token.set(res.token);
        this.user.set(res.user);
      }));
  }

  startViewAs(user: AuthUser) {
    this.store(VIEW_AS_KEY, user);
    this.viewAs.set(user);
  }

  stopViewAs() {
    this.store(VIEW_AS_KEY, null);
    this.viewAs.set(null);
  }

  logout(reason?: string) {
    for (const k of [TOKEN_KEY, USER_KEY, VIEW_AS_KEY]) this.store(k, null);
    this.token.set(null);
    this.user.set(null);
    this.viewAs.set(null);
    this.router.navigate(['/login'], reason ? { queryParams: { reason } } : {});
  }

  private store(key: string, value: unknown) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch { /* storage unavailable (private mode) — session stays in memory */ }
  }
}
