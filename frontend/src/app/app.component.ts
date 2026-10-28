import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConfirmHostComponent, ToastsComponent } from './shared/ui';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastsComponent, ConfirmHostComponent],
  template: `<router-outlet /><app-toasts /><app-confirm-host />`,
})
export class AppComponent {}
