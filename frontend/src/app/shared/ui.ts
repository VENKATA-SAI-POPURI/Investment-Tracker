import { ChangeDetectionStrategy, Component, ElementRef, HostListener, Injectable, OnDestroy, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { IconComponent } from './icon.component';
import { ToastService } from '../core/toast.service';

/** What Tab can land on inside a dialog. Hidden and disabled controls are filtered out at run time. */
const FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), '
  + 'textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** The open modals, oldest first: only the top one answers Esc and Tab, and the body unlocks when the last closes. */
const OPEN_MODALS: ModalComponent[] = [];

/** The tabbable elements inside `root`, in DOM order (visible ones only). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter(el => el.tabIndex >= 0 && !el.hasAttribute('inert') && !el.closest('[inert]') && el.getClientRects().length > 0);
}

/**
 * Accessible dialog (P2.9): focus moves in on open (the first field, else the dialog), Tab and Shift+Tab wrap
 * inside it, Esc closes it, the body does not scroll behind it, and focus goes back to the element that was
 * focused before it opened. Stacked dialogs (a confirm over a form) answer keys top-down.
 */
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
export class ModalComponent implements OnDestroy {
  title = input('');
  width = input(560);
  close = output<void>();
  private dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  /** The element focused before this dialog opened; focus returns there on close. */
  private readonly opener: HTMLElement | null =
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : null;

  constructor() {
    OPEN_MODALS.push(this);
    document.body.style.overflow = 'hidden';
    effect(() => {
      const el = this.dialog()?.nativeElement;
      if (el) setTimeout(() => { if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>('input,select,textarea') ?? el).focus(); });
    });
  }

  private get isTop(): boolean { return OPEN_MODALS[OPEN_MODALS.length - 1] === this; }

  @HostListener('document:keydown.escape')
  onEsc() {
    if (this.isTop) this.close.emit();
  }

  /** The focus trap: Tab from the last control goes to the first, Shift+Tab from the first to the last. */
  @HostListener('document:keydown', ['$event'])
  onTab(e: KeyboardEvent) {
    if (e.key !== 'Tab' || e.defaultPrevented) return;
    const root = this.dialog()?.nativeElement;
    if (!root || !this.isTop) return;
    const items = focusableIn(root);
    const active = document.activeElement as HTMLElement | null;
    if (!items.length) { e.preventDefault(); root.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    const inside = !!active && root.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first || active === root) { e.preventDefault(); last.focus(); }
    } else if (!inside || active === last) {
      e.preventDefault(); first.focus();
    }
  }

  ngOnDestroy() {
    const i = OPEN_MODALS.indexOf(this);
    if (i >= 0) OPEN_MODALS.splice(i, 1);
    if (!OPEN_MODALS.length) document.body.style.overflow = '';
    const back = this.opener;
    // after the view is gone (a dialog that opened another dialog gets focus back once it is the top again)
    if (back) setTimeout(() => { if (back.isConnected && !this.trapsElsewhere(back)) back.focus({ preventScroll: true }); });
  }

  /** Focus never returns to an element that sits outside a dialog still open above the page. */
  private trapsElsewhere(el: HTMLElement): boolean {
    const top = OPEN_MODALS[OPEN_MODALS.length - 1];
    const root = top?.dialog()?.nativeElement;
    return !!root && !root.contains(el);
  }
}

@Component({
  selector: 'app-toasts',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-stack" aria-live="polite">
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
    /* not ".stack": the global .stack meter (12 px, overflow hidden) would clip the toasts (R13) */
    .toast-stack { position: fixed; right: 16px; bottom: 16px; z-index: 1100; display: flex; flex-direction: column; gap: 8px; max-width: min(420px, calc(100vw - 32px)); }
    .toast { display: flex; align-items: center; gap: 10px; background: var(--surface); border: 1px solid var(--border-strong); border-left: 4px solid var(--accent); border-radius: 10px; box-shadow: var(--shadow-pop); padding: 10px 8px 10px 12px; font-size: 13.5px; }
    .toast.ok { border-left-color: var(--status-good); }
    .toast.error { border-left-color: var(--status-critical); }
    .text { flex: 1; }
    @media (max-width: 760px) { .toast-stack { bottom: 80px; left: 16px; right: 16px; } }
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
  /** The header's `aria-sort` (P2.9): bind `[attr.aria-sort]="sort.ariaSort('name')"` on the sortable `th`. */
  ariaSort(key: string): 'ascending' | 'descending' | 'none' {
    return this.key() === key ? (this.dir() === 1 ? 'ascending' : 'descending') : 'none';
  }
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
