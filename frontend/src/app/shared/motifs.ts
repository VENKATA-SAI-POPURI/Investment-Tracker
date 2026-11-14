import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Rangoli / mandala motif, drawn procedurally (decorative only). Colour comes from `currentColor`. */
@Component({
  selector: 'app-mandala',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="-100 -100 200 200" fill="none" stroke="currentColor" aria-hidden="true">
      <circle r="9" stroke-width="1.4" />
      <circle r="3" fill="currentColor" stroke="none" />
      @for (a of ring8(); track a) { <ellipse cx="0" cy="-24" rx="7" ry="14" [attr.transform]="'rotate(' + a + ')'" stroke-width="1.4" /> }
      <circle r="42" stroke-width="1" stroke-dasharray="2 4" />
      @for (a of ring16(); track a) { <path d="M0,-46 C8,-56 8,-66 0,-74 C-8,-66 -8,-56 0,-46Z" [attr.transform]="'rotate(' + a + ')'" stroke-width="1.2" /> }
      @for (a of ring16(); track a) { <circle cx="0" cy="-82" r="2.6" [attr.transform]="'rotate(' + (a + 11.25) + ')'" fill="currentColor" stroke="none" /> }
      <circle r="90" stroke-width="1" />
      @for (a of ring32(); track a) { <path d="M-5,-90 Q0,-99 5,-90" [attr.transform]="'rotate(' + a + ')'" stroke-width="1" /> }
    </svg>`,
  styles: [':host{display:inline-block;line-height:0;pointer-events:none}'],
})
export class MandalaComponent {
  size = input(200);
  ring8 = computed(() => Array.from({ length: 8 }, (_, i) => i * 45));
  ring16 = computed(() => Array.from({ length: 16 }, (_, i) => i * 22.5));
  ring32 = computed(() => Array.from({ length: 32 }, (_, i) => i * 11.25));
}

