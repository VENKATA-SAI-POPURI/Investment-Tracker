import { Pipe, PipeTransform } from '@angular/core';

/**
 * Compact Indian-Rupee formatter.
 *
 * Usage: {{ value | inr }}          → ₹3.76L  / ₹80.13K / ₹8,500
 *        {{ value | inr:true }}     → +₹3.76L (showSign)
 *
 * Thresholds:
 *   ≥ ₹1 Cr (1e7)  →  ₹X.XXCr
 *   ≥ ₹1 L  (1e5)  →  ₹X.XXL
 *   ≥ ₹10K  (1e4)  →  ₹X.XXK
 *   < ₹10K         →  ₹X,XXX  (absolute en-IN)
 */
@Pipe({ name: 'inr', standalone: true, pure: true })
export class InrPipe implements PipeTransform {
  transform(value: number | null | undefined, showSign = false): string {
    if (value == null || isNaN(value as number)) return '—';
    const n = value as number;
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : showSign ? '+' : '';

    let body: string;
    if (abs >= 1e7)      body = `₹${(abs / 1e7).toFixed(2)}Cr`;
    else if (abs >= 1e5) body = `₹${(abs / 1e5).toFixed(2)}L`;
    else if (abs >= 1e4) body = `₹${(abs / 1e3).toFixed(2)}K`;
    else                 body = `₹${Math.round(abs).toLocaleString('en-IN')}`;

    return sign + body;
  }
}
