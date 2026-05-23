import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface AuthUser {
  email: string;
  name?: string;
  picture?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private token$ = new BehaviorSubject<string | null>(this.getStoredToken());
  private user$ = new BehaviorSubject<AuthUser | null>(this.getStoredUser());
  private _isAuthenticated$ = new BehaviorSubject<boolean>(!!this.getStoredToken());

  constructor(private http: HttpClient) {}

  private getStoredToken(): string | null {
    return localStorage.getItem('auth_token');
  }

  private getStoredUser(): AuthUser | null {
    const user = localStorage.getItem('auth_user');
    return user ? JSON.parse(user) : null;
  }

  /**
   * Login with Google token
   */
  loginWithGoogle(googleToken: string): Observable<any> {
    return this.http.post(`${environment.apiUrl}/auth/google-login`, { token: googleToken })
      .pipe(
        tap((response: any) => {
          const token = response.token;
          const user = response.user;

          // Store token and user
          localStorage.setItem('auth_token', token);
          localStorage.setItem('auth_user', JSON.stringify(user));

          // Update subjects
          this.token$.next(token);
          this.user$.next(user);
          this._isAuthenticated$.next(true);
        })
      );
  }

  /**
   * Logout
   */
  logout(): void {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    
    this.token$.next(null);
    this.user$.next(null);
    this._isAuthenticated$.next(false);
  }

  /**
   * Get current token
   */
  getToken(): string | null {
    return this.token$.value;
  }

  /**
   * Get current user
   */
  getUser(): AuthUser | null {
    return this.user$.value;
  }

  /**
   * Check if authenticated
   */
  isAuthenticated(): boolean {
    return this._isAuthenticated$.value;
  }

  /**
   * Get token as observable
   */
  getToken$(): Observable<string | null> {
    return this.token$.asObservable();
  }

  /**
   * Get user as observable
   */
  getUser$(): Observable<AuthUser | null> {
    return this.user$.asObservable();
  }

  /**
   * Get authentication state as observable
   */
  isAuthenticated$(): Observable<boolean> {
    return this._isAuthenticated$.asObservable();
  }

  /**
   * Verify token with backend
   */
  verifyToken(): Observable<any> {
    return this.http.get(`${environment.apiUrl}/auth/verify`);
  }
}
