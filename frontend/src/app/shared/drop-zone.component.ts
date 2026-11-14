import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { ActionService } from '../core/action.service';
import { IconComponent } from './icon.component';

let NEXT_ID = 0;

/** True when `file` matches an `<input accept>` list (".pdf", "text/csv", "image/*"); an empty list takes anything. */
export function matchesAccept(file: { name: string; type: string }, accept: string | null | undefined): boolean {
  const tokens = (accept ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  const name = file.name.toLowerCase(), type = (file.type || '').toLowerCase();
  return tokens.some(t => t.startsWith('.') ? name.endsWith(t)
    : t.endsWith('/*') ? type.startsWith(t.slice(0, -1))
    : type === t);
}

/** The accept list in words for a refusal: ".xlsx,.csv" → "XLSX or CSV"; MIME-only lists fall back to their subtypes. */
export function acceptWords(accept: string | null | undefined): string {
  const tokens = (accept ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const exts = tokens.filter(t => t.startsWith('.')).map(t => t.slice(1).toUpperCase());
  const words = [...new Set(exts.length ? exts : tokens.map(t => (t.split('/')[1] ?? t).replace('*', 'any').toUpperCase()))];
  return words.length <= 1 ? (words[0] ?? 'any') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/** One row of an import commit's `results` (K5): the row or scheme name, its date when it has one, and why it failed. */
export interface ImportRowResult { name?: string; date?: string; ok: boolean; error?: string; [k: string]: unknown; }
/** A refused all-or-nothing import: the server's one-line `error` and the rows that need fixing. */
export interface ImportRefusal { error: string; rows: ImportRowResult[]; }

/**
 * The refused rows of an all-or-nothing import 400 (K5/K6: `{error, results}`), or null when the error is not one.
 * The CSV and CAS commits render these as a table; the L2 one-line `errorMessage` stays the toast.
 */
export function refusedRows(e: unknown): ImportRefusal | null {
  if (!(e instanceof HttpErrorResponse) || e.status !== 400 || !Array.isArray(e.error?.results)) return null;
  const rows = (e.error.results as ImportRowResult[]).filter(r => !!r && r.ok === false);
  return { error: String(e.error?.error ?? 'Nothing was imported'), rows };
}

/** Brings a just-rendered refusal table into view (it renders above a long preview). */
export function showRefusal(id: string): void {
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

/**
 * §5.11: a successful import completes any open or planned `data:import-due:` action. No backend rule raises one
 * yet, so today this is a no-op; it is here so every import flow closes the reminder the same way once one exists.
 */
export function completeImportDue(actions: ActionService): void {
  for (const a of [...actions.actions(), ...actions.planned()]) {
    if (a.id.startsWith('data:import-due:') && (a.status === 'open' || a.status === 'planned')) {
      void actions.setStatus(a.id, { status: 'done', note: 'Imported a statement' });
    }
  }
}

/**
 * The one file picker every import flow uses (P2.11, R21): a focusable zone that takes a click, Enter or Space
 * (it opens the hidden file input) or a drag and drop. Files that don't match `accept` are refused with a message
 * and never emitted; a single-file zone keeps the first file of a multi-file drop. `label` is the zone's text
 * (the parent swaps in the chosen file names or "Reading…"); `hint` is tied to it by `aria-describedby`.
 */
@Component({
  selector: 'app-drop-zone',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dz" role="button" [attr.tabindex]="disabled() ? -1 : 0" [attr.aria-disabled]="disabled() ? 'true' : null"
      [attr.aria-describedby]="describedBy()" [class.over]="over()" [class.off]="disabled()"
      (click)="open()" (keydown)="onKey($event)" (dragenter)="onDrag($event)" (dragover)="onDrag($event)"
      (dragleave)="onLeave($event)" (drop)="onDrop($event)">
      <input #picker type="file" class="dz-input" tabindex="-1" aria-hidden="true" [accept]="accept()" [multiple]="multiple()"
        [disabled]="disabled()" (change)="onPick($event)" (click)="$event.stopPropagation()" />
      <app-icon name="upload" [size]="20" />
      <span class="dz-text">
        <span class="dz-label">{{ label() }}</span>
        <span class="dz-how">{{ over() ? 'Drop to add' : 'Drop ' + (multiple() ? 'files' : 'a file') + ' here, or press to choose' }}</span>
      </span>
    </div>
    @if (hint()) { <p class="dz-hint" [id]="hintId">{{ hint() }}</p> }
    @if (refused(); as r) { <p class="dz-err" [id]="errId" role="alert">{{ r }}</p> }
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .dz { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 10px 16px; border-radius: 10px; box-sizing: border-box;
      border: 1.5px dashed var(--border-strong); background: var(--surface-2); color: var(--text-2); cursor: pointer; font-size: 13.5px;
      transition: border-color .12s, background .12s, box-shadow .12s; }
    .dz:hover { border-color: var(--primary); color: var(--text); }
    .dz:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
    .dz.over { border-style: solid; border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
    .dz.off { cursor: default; opacity: .7; }
    .dz.off:hover { border-color: var(--border-strong); color: var(--text-2); }
    .dz app-icon { flex: none; }
    .dz-input { display: none; }
    .dz-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .dz-label { font-weight: 500; overflow-wrap: anywhere; }
    .dz-how { font-size: var(--t-label); color: var(--muted); }
    .dz-hint { margin: 6px 0 0; font-size: var(--t-label); color: var(--muted); }
    .dz-err { margin: 6px 0 0; font-size: var(--t-label); color: var(--neg); font-weight: 500; }
  `],
})
export class DropZoneComponent {
  /** An `<input accept>` list, e.g. "application/pdf,.pdf". */
  accept = input('');
  multiple = input(false);
  disabled = input(false);
  label = input('Choose a file');
  hint = input('');
  /** The accepted files of one pick or drop (never empty). */
  files = output<File[]>();

  private picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');
  private readonly uid = ++NEXT_ID;
  readonly hintId = `dz-hint-${this.uid}`;
  readonly errId = `dz-err-${this.uid}`;
  readonly over = signal(false);
  readonly refused = signal<string | null>(null);
  readonly describedBy = computed(() => [this.hint() ? this.hintId : '', this.refused() ? this.errId : ''].filter(Boolean).join(' ') || null);

  open() {
    if (this.disabled()) return;
    this.picker().nativeElement.click();
  }

  onKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    this.open();
  }

  onDrag(e: DragEvent) {
    e.preventDefault();  // without this the browser opens the dropped file instead
    if (e.dataTransfer) e.dataTransfer.dropEffect = this.disabled() ? 'none' : 'copy';
    if (!this.disabled()) this.over.set(true);
  }

  onLeave(e: DragEvent) {
    const to = e.relatedTarget as Node | null;
    if (to && (e.currentTarget as HTMLElement).contains(to)) return;
    this.over.set(false);
  }

  onDrop(e: DragEvent) {
    e.preventDefault();
    this.over.set(false);
    if (this.disabled()) return;
    this.take([...(e.dataTransfer?.files ?? [])]);
  }

  onPick(e: Event) {
    const el = e.target as HTMLInputElement;
    const picked = [...(el.files ?? [])];
    el.value = '';  // picking the same file again still fires change
    this.take(picked);
  }

  /** Splits a pick or drop into accepted and refused files, says why any were refused, and emits the rest. */
  take(list: File[]) {
    if (!list.length) return;
    const ok = list.filter(f => matchesAccept(f, this.accept()));
    const bad = list.filter(f => !ok.includes(f));
    const notes: string[] = [];
    if (bad.length) {
      const names = bad.slice(0, 3).map(f => f.name).join(', ') + (bad.length > 3 ? ` and ${bad.length - 3} more` : '');
      notes.push(`${names} ${bad.length === 1 ? 'was' : 'were'} not added: only ${acceptWords(this.accept())} files go here.`);
    }
    let take = ok;
    if (!this.multiple() && ok.length > 1) {
      take = ok.slice(0, 1);
      notes.push(`One file at a time: using ${take[0].name}.`);
    }
    this.refused.set(notes.length ? notes.join(' ') : null);
    if (!take.length) return;
    this.files.emit(take);
  }

  /** Clears a refusal message (the parent's Cancel). */
  reset() { this.refused.set(null); this.over.set(false); }
}
