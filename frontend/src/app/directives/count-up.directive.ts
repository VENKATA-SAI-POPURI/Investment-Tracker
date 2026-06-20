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
  /** When true, formats large numbers as Lakh (L) / Crore (Cr) for Indian context. */
  @Input() countUpCompact = true;
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
      this.el.nativeElement.textContent = this.format(current);
      if (t < 1) {
        this.animId = requestAnimationFrame(step);
      }
    };
    this.animId = requestAnimationFrame(step);
  }

  private format(value: number): string {
    if (this.countUpCompact) {
      const abs = Math.abs(value);
      const sign = value < 0 ? '-' : '';
      if (abs >= 1e7) return `${sign}${this.countUpPrefix}${(abs / 1e7).toFixed(2)}Cr`;
      if (abs >= 1e5) return `${sign}${this.countUpPrefix}${(abs / 1e5).toFixed(2)}L`;
      if (abs >= 1e4) return `${sign}${this.countUpPrefix}${(abs / 1e3).toFixed(2)}K`;
      return `${sign}${this.countUpPrefix}${Math.round(abs).toLocaleString('en-IN')}`;
    }
    return (
      this.countUpPrefix +
      value.toLocaleString('en-US', {
        minimumFractionDigits: this.countUpDecimals,
        maximumFractionDigits: this.countUpDecimals,
      })
    );
  }
}
