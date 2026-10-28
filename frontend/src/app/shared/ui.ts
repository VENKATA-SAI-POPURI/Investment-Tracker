import { ChangeDetectionStrategy, Component, ElementRef, HostListener, Injectable, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { IconComponent } from './icon.component';
import { ToastService } from '../core/toast.service';

/** Accessible dialog: focus trap-lite, Esc to close, scroll locked body. */
@Component({
  selector: 'app-modal',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <div class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="title()" [style.max-width.px]="width()" #dialog tabindex="-1">
      <header>
        <h2>{{ title() }}</h2>
        <button class="btn ghost icon sm" (click)="close.emit()" aria-label="Close"><app-icon name="close" /></button>
      </header>
      <div class="body"><ng-content /></div>
    </div>`,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 900; display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px 16px; overflow-y: auto; }
    .backdrop { position: fixed; inset: 0; background: rgba(10, 10, 10, .45); }
    .dialog { position: relative; width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-pop); outline: none; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); }
    .body { padding: 18px 20px 20px; }
    @media (max-width: 560px) { :host { padding: 0; align-items: flex-end; } .dialog { border-radius: 14px 14px 0 0; max-height: 92vh; overflow-y: auto; } }
  `],
})
export class ModalComponent {
  title = input('');
  width = input(560);
  close = output<void>();
  private dialog = viewChild<ElementRef<HTMLElement>>('dialog');

  constructor() {
    document.body.style.overflow = 'hidden';
    effect(() => {
      const el = this.dialog()?.nativeElement;
      if (el) setTimeout(() => (el.querySelector<HTMLElement>('input,select,textarea') ?? el).focus());
    });
  }
  @HostListener('document:keydown.escape') onEsc() { this.close.emit(); }
  ngOnDestroy() { document.body.style.overflow = ''; }
}

@Component({
  selector: 'app-toasts',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack" aria-live="polite">
      @for (t of toast.toasts(); track t.id) {
        <div class="toast" [class]="t.kind">
          <app-icon [name]="t.kind === 'error' ? 'alert' : t.kind === 'ok' ? 'checkCircle' : 'info'" />
          <span class="text">{{ t.text }}</span>
          @if (t.action) { <button class="btn ghost sm" (click)="t.action.run(); toast.dismiss(t.id)">{{ t.action.label }}</button> }
          <button class="btn ghost icon sm" (click)="toast.dismiss(t.id)" aria-label="Dismiss"><app-icon name="close" [size]="14" /></button>
        </div>
      }
    </div>`,
  styles: [`
    .stack { position: fixed; right: 16px; bottom: 16px; z-index: 1100; display: flex; flex-direction: column; gap: 8px; max-width: min(420px, calc(100vw - 32px)); }
    .toast { display: flex; align-items: center; gap: 10px; background: var(--surface); border: 1px solid var(--border-strong); border-left: 4px solid var(--accent); border-radius: 10px; box-shadow: var(--shadow-pop); padding: 10px 8px 10px 12px; font-size: 13.5px; }
    .toast.ok { border-left-color: var(--status-good); }
    .toast.error { border-left-color: var(--status-critical); }
    .text { flex: 1; }
    @media (max-width: 760px) { .stack { bottom: 80px; left: 16px; right: 16px; } }
  `],
})
export class ToastsComponent {
  toast = inject(ToastService);
}

/** Promise-based confirm dialog rendered by <app-confirm-host>. */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly pending = signal<{ title: string; text: string; confirm: string; danger: boolean; resolve: (v: boolean) => void } | null>(null);
  ask(title: string, text: string, confirm = 'Confirm', danger = true): Promise<boolean> {
    return new Promise(resolve => this.pending.set({ title, text, confirm, danger, resolve }));
  }
  answer(v: boolean) {
    this.pending()?.resolve(v);
    this.pending.set(null);
  }
}

@Component({
  selector: 'app-confirm-host',
  standalone: true,
  imports: [ModalComponent],
  template: `
    @if (c.pending(); as p) {
      <app-modal [title]="p.title" [width]="420" (close)="c.answer(false)">
        <p class="text-2">{{ p.text }}</p>
        <div class="form-actions" style="margin-top:18px">
          <button class="btn" (click)="c.answer(false)">Cancel</button>
          <button class="btn" [class.danger]="p.danger" [class.solid]="p.danger" [class.primary]="!p.danger" (click)="c.answer(true)">{{ p.confirm }}</button>
        </div>
      </app-modal>
    }`,
})
export class ConfirmHostComponent {
  c = inject(ConfirmService);
}

/** Small reusable stat tile: label · value · optional delta. */
@Component({
  selector: 'app-stat',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stat">
      <span class="label">{{ label() }}</span>
      <span class="value" [class]="tone()" [title]="value()">{{ value() }}</span>
      @if (meta()) { <span class="meta" [class]="metaTone()">{{ meta() }}</span> }
    </div>`,
})
export class StatComponent {
  label = input('');
  value = input<string>('—');
  meta = input<string | null>(null);
  tone = input('');
  metaTone = input('');
}

/** Sort helper for tables: click a header to sort, click again to flip. */
export class SortState<T> {
  key = signal<string>('');
  dir = signal<1 | -1>(-1);
  constructor(key: string, dir: 1 | -1 = -1) { this.key.set(key); this.dir.set(dir); }
  toggle(key: string) {
    if (this.key() === key) this.dir.update(d => (d === 1 ? -1 : 1));
    else { this.key.set(key); this.dir.set(-1); }
  }
  arrow(key: string) { return this.key() === key ? (this.dir() === 1 ? ' ↑' : ' ↓') : ''; }
  apply(rows: T[]): T[] {
    const k = this.key(), d = this.dir();
    return [...rows].sort((a: any, b: any) => {
      const x = a[k], y = b[k];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * d;
    });
  }
}

export function sortRows<T>(state: SortState<T>, rows: () => T[]) {
  return computed(() => state.apply(rows()));
}
