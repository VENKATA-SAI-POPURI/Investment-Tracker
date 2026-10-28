import { DestroyRef, ElementRef, inject, signal } from '@angular/core';

/** Clean axis ticks (1/2/5 × 10^n). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!isFinite(min) || !isFinite(max)) return [0];
  if (min === max) { const pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
  const span = max - min;
  const raw = span / Math.max(count - 1, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) ?? 10 * mag;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(+v.toFixed(10));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** Observe host width so SVG charts are crisp at any size. */
export function observeWidth(el: ElementRef<HTMLElement>) {
  const width = signal(600);
  const ro = new ResizeObserver(entries => {
    const w = Math.floor(entries[0].contentRect.width);
    if (w > 0 && w !== width()) width.set(w);
  });
  ro.observe(el.nativeElement);
  inject(DestroyRef).onDestroy(() => ro.disconnect());
  return width;
}

export interface Tip { x: number; y: number; title: string; rows: { label: string; value: string; color?: string; line?: boolean }[]; }

/** Place a fixed tooltip near the pointer, flipping at viewport edges. */
export function tipPosition(ev: MouseEvent | PointerEvent, w = 200, h = 120): { x: number; y: number } {
  const pad = 14;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
  return { x: Math.max(8, x), y: Math.max(8, y) };
}
