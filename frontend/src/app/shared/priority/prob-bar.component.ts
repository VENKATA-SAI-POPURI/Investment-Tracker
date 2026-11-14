import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Status, STATUS_THRESHOLDS, statusFromProbability } from './priority';

/** `.prob-bar`: an 8px track filled in the status colour, ticks at 40 and 75, "72%" and a ▲/▼ delta. */
@Component({
  selector: 'app-prob-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="prob-bar" [attr.data-status]="status()">
      <div class="track" role="meter" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="pct()"
        [attr.aria-label]="label() || 'Chance of success'" [attr.aria-valuetext]="text()">
        <i class="fill" [style.width.%]="pct() ?? 0"></i>
        <i class="tick" [style.left.%]="watchAt"></i><i class="tick" [style.left.%]="goodAt"></i>
      </div>
      <b class="v">{{ pct() === null ? '—' : pct() + '%' }}</b>
      @if (deltaText(); as d) { <span class="d" [class.pos]="delta()! > 0" [class.neg]="delta()! < 0">{{ d }}</span> }
    </div>`,
  styles: [':host{display:block}'],
})
export class ProbBarComponent {
  /** Probability, 0–100, as the engine gives it (null when unknown). Rounded for display only. */
  value = input<number | null>(null);
  /** Change in points since the last snapshot. */
  delta = input<number | null>(null);
  label = input<string | null>(null);
  /** The engine's status when the caller has it; otherwise derived from the unrounded value. */
  statusOverride = input<Status | null>(null, { alias: 'status' });

  readonly watchAt = STATUS_THRESHOLDS.watch;
  readonly goodAt = STATUS_THRESHOLDS.good;
  private raw = computed(() => {
    const v = this.value();
    return v === null || v === undefined || isNaN(v) ? null : Math.max(0, Math.min(100, v));
  });
  pct = computed(() => { const v = this.raw(); return v === null ? null : Math.round(v); });
  // the bands are ≥75 / ≥40 on the unrounded value, as in forecast._status_for: 74.6 is watch though it shows 75%
  status = computed(() => this.statusOverride() ?? statusFromProbability(this.raw()));
  text = computed(() => this.pct() === null ? 'not known' : `${this.pct()} of 100 futures`);
  deltaText = computed(() => {
    const d = this.delta();
    if (d === null || d === undefined || isNaN(d) || Math.round(d) === 0) return '';
    return d > 0 ? `▲${Math.round(d)}` : `▼${Math.round(-d)}`;
  });
}
