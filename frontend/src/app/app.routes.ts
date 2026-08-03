import { Routes } from '@angular/router';
import { MainLayoutComponent } from './layouts/main-layout/main-layout.component';
import { LoginComponent } from './components/login/login.component';
import { authGuardFn } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: '', component: MainLayoutComponent, canActivate: [authGuardFn] },
  { path: '**', redirectTo: '' }
];
