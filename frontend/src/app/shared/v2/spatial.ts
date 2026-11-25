import { DestroyRef, Directive, ElementRef, NgZone, afterNextRender, inject, input } from '@angular/core';

const FINE = typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;
const CALM = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Spatial tilt: the element turns a few degrees toward the pointer and lifts, like a pane floating in space.
 * Sets --rx / --ry (degrees) and --mx / --my (pointer position, %) for the CSS in styles.scss (`[vTilt]`).
 * Pointer devices only, and off with reduced motion. Runs outside Angular, so it never triggers change detection.
 */
@Directive({ selector: '[vTilt]', standalone: true, host: { '[attr.data-tilt]': '""' } })
export class TiltDirective {
  /** Largest turn in degrees. */
  vTilt = input<number | ''>(6);
  private el = inject(ElementRef<HTMLElement>);
  private zone = inject(NgZone);

  constructor() {
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      if (!FINE || CALM) return;
      const el = this.el.nativeElement as HTMLElement;
      let raf = 0;
      const max = () => +(this.vTilt() || 6);
      const move = (e: PointerEvent) => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
          el.style.setProperty('--ry', ((x - .5) * 2 * max()).toFixed(2) + 'deg');
          el.style.setProperty('--rx', ((.5 - y) * 2 * max()).toFixed(2) + 'deg');
          el.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
          el.style.setProperty('--my', (y * 100).toFixed(1) + '%');
          el.classList.add('tilting');
        });
      };
      const leave = () => {
        cancelAnimationFrame(raf);
        el.classList.remove('tilting');
        el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg');
      };
      this.zone.runOutsideAngular(() => {
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerleave', leave);
      });
      destroy.onDestroy(() => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerleave', leave); });
    });
  }
}

/** Scroll depth for the backdrop: --sy (px scrolled) on <html>, read by the parallax orbs in styles.scss. */
export function startScrollDepth(zone: NgZone): () => void {
  if (typeof window === 'undefined' || CALM) return () => {};
  let raf = 0;
  const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => document.documentElement.style.setProperty('--sy', String(window.scrollY))); };
  zone.runOutsideAngular(() => window.addEventListener('scroll', on, { passive: true }));
  return () => window.removeEventListener('scroll', on);
}
