import { Injectable, signal } from '@angular/core';

export interface Toast { id: number; kind: 'ok' | 'error' | 'info'; text: string; action?: { label: string; run: () => void }; }

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;

  show(kind: Toast['kind'], text: string, action?: Toast['action'], ms = 4500) {
    const t: Toast = { id: ++this.seq, kind, text, action };
    this.toasts.update(list => [...list, t].slice(-4));
    setTimeout(() => this.dismiss(t.id), kind === 'error' ? ms * 1.6 : ms);
  }
  ok(text: string, action?: Toast['action']) { this.show('ok', text, action); }
  error(text: string) { this.show('error', text); }
  info(text: string) { this.show('info', text); }
  dismiss(id: number) { this.toasts.update(list => list.filter(t => t.id !== id)); }
}
