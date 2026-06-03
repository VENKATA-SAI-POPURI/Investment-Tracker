import { Directive, Input, OnChanges, SimpleChanges, ElementRef } from '@angular/core';

@Directive({
  selector: '[countUp]',
  standalone: true
})
export class CountUpDirective implements OnChanges {
  /** The numeric target value to count up to. */
  @Input({ required: true }) countUp!: number;
  /** Number of decimal places. Default 2. */
  @Input() countUpDecimals = 2;
  /** String prepended to the formatted number (e.g. '₹'). */
  @Input() countUpPrefix = '';
  /** Animation duration in milliseconds. Default 1000. */
  @Input() countUpDuration = 1000;

  private animId?: number;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngOnChanges(changes: SimpleChanges): void {
    if ('countUp' in changes) {
      this.animate(this.countUp);
    }
  }

  private animate(target: number): void {
    if (this.animId) cancelAnimationFrame(this.animId);
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min((now - start) / this.countUpDuration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const current = target * eased;
      this.el.nativeElement.textContent =
        this.countUpPrefix +
        current.toLocaleString('en-US', {
          minimumFractionDigits: this.countUpDecimals,
          maximumFractionDigits: this.countUpDecimals,
        });
      if (t < 1) {
        this.animId = requestAnimationFrame(step);
      }
    };
    this.animId = requestAnimationFrame(step);
  }
}
