import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const token = auth.token();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const viewAs = auth.viewAs();
  if (viewAs) headers['X-View-As'] = viewAs.email;
  else if (auth.canSwitch() && auth.portfolio()) headers['X-Portfolio'] = auth.portfolio()!;
  return next(req.clone({ setHeaders: headers })).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401 && token && !req.url.endsWith('/auth/google-login')) {
        auth.logout(err.error?.error || 'Your session has ended');
      }
      return throwError(() => err);
    }),
  );
};

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isAuthenticated() ? true : inject(Router).createUrlTree(['/login']);
};

export const writeGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.canWrite() ? true : inject(Router).createUrlTree(['/']);
};

export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isAdmin() ? true : inject(Router).createUrlTree(['/']);
};

/** Human-readable message from an API error. */
export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Cannot reach the server. Check your connection — it may be waking up, try again in a moment.';
    const msg: string = err.error?.error || err.message;
    // An all-or-nothing import refusal (K5) carries every row's outcome; name the first one to fix (L2)
    const rows: unknown = err.error?.results;
    const first = Array.isArray(rows) ? rows.find((r: { ok?: boolean; error?: string }) => r?.ok === false && r.error) : null;
    return first ? `${msg}. First: ${first.name ?? 'row'}${first.date ? ` (${first.date})` : ''}: ${first.error}` : msg;
  }
  return (err as Error)?.message ?? 'Something went wrong';
}
