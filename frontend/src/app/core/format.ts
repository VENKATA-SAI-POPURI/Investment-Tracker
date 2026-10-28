import { Pipe, PipeTransform } from '@angular/core';

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inrFmt2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₹1,23,456 — Indian digit grouping. */
export function inr(v: number | null | undefined, decimals = 0, signed = false): string {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const s = (decimals ? inrFmt2 : inrFmt).format(Math.abs(v));
  const sign = v < 0 ? '-' : signed && v > 0 ? '+' : '';
  return `${sign}₹${s}`;
}

/** ₹12.3L / ₹1.2Cr / ₹45.6K — compact for tiles and axes. */
export function inrCompact(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : signed && v > 0 ? '+' : '';
  let s: string;
  if (a >= 1e7) s = (a / 1e7).toFixed(a >= 1e8 ? 1 : 2) + 'Cr';
  else if (a >= 1e5) s = (a / 1e5).toFixed(a >= 1e6 ? 1 : 2) + 'L';
  else if (a >= 1e3) s = (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  else s = a.toFixed(0);
  return `${sign}₹${s}`;
}

/** ₹3.09 lakh / ₹1.25 crore — the way amounts are said in India. */
export function inrWords(v: number | null | undefined): string {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} crore`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} lakh`;
  if (a >= 1e3) return `${sign}₹${(a / 1e3).toFixed(1)} thousand`;
  return `${sign}₹${a.toFixed(0)}`;
}

export function pct(v: number | null | undefined, decimals = 1, signed = true): string {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const sign = signed && v > 0 ? '+' : '';
  return `${sign}${v.toFixed(decimals)}%`;
}

export function qty(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return Math.abs(v) >= 100 ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 })
    : v.toLocaleString('en-IN', { maximumFractionDigits: 4 });
}

export function usd(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function signClass(v: number | null | undefined): string {
  return !v ? '' : v > 0 ? 'pos' : 'neg';
}

export function fmtDate(d: string | null | undefined, withYear = true): string {
  if (!d) return '—';
  const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-IN', withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function today(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(['﻿' + rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

@Pipe({ name: 'inr', standalone: true })
export class InrPipe implements PipeTransform {
  transform(v: number | null | undefined, decimals = 0, signed = false) { return inr(v, decimals, signed); }
}

@Pipe({ name: 'inrc', standalone: true })
export class InrCompactPipe implements PipeTransform {
  transform(v: number | null | undefined, signed = false) { return inrCompact(v, signed); }
}

@Pipe({ name: 'pct', standalone: true })
export class PctPipe implements PipeTransform {
  transform(v: number | null | undefined, decimals = 1, signed = true) { return pct(v, decimals, signed); }
}

@Pipe({ name: 'qty', standalone: true })
export class QtyPipe implements PipeTransform {
  transform(v: number | null | undefined) { return qty(v); }
}

@Pipe({ name: 'usd', standalone: true })
export class UsdPipe implements PipeTransform {
  transform(v: number | null | undefined, decimals = 2) { return usd(v, decimals); }
}

@Pipe({ name: 'dt', standalone: true })
export class DatePipe implements PipeTransform {
  transform(v: string | null | undefined, withYear = true) { return fmtDate(v, withYear); }
}

@Pipe({ name: 'sign', standalone: true })
export class SignClassPipe implements PipeTransform {
  transform(v: number | null | undefined) { return signClass(v); }
}

export const FORMAT_PIPES = [InrPipe, InrCompactPipe, PctPipe, QtyPipe, UsdPipe, DatePipe, SignClassPipe] as const;
