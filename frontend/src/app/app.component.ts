import { Component, OnInit, OnDestroy } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet></router-outlet>`,
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit, OnDestroy {
  private static readonly TAB_KEY = 'investment-app-tabs';

  ngOnInit(): void {
    const count = parseInt(localStorage.getItem(AppComponent.TAB_KEY) || '0', 10);
    localStorage.setItem(AppComponent.TAB_KEY, String(count + 1));
    window.addEventListener('beforeunload', this.onBeforeUnload);
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
