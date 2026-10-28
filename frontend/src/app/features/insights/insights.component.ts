import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FORMAT_PIPES } from '../../core/format';
import { errorMessage } from '../../core/http';
import { Insight, RebalancePlan, SEGMENT_COLOR } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { MarkdownPipe } from '../../shared/markdown.pipe';
import { InsightCardComponent } from './insight-card.component';

@Component({
  selector: 'app-insights',
  standalone: true,
  imports: [FormsModule, TitleCasePipe, RouterLink, IconComponent, InsightCardComponent, MarkdownPipe, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './insights.component.html',
  styles: [`
    .md :is(h4) { margin: 14px 0 6px; font-size: 14px; }
    .md :is(p, li) { margin: 4px 0; line-height: 1.55; }
    .md :is(ul, ol) { padding-left: 20px; margin: 4px 0; }
    .chat { display: flex; flex-direction: column; gap: 10px; max-height: 420px; overflow-y: auto; padding: 4px 2px; }
    .msg { padding: 10px 12px; border-radius: 10px; max-width: 88%; font-size: 13.5px; }
    .msg.user { align-self: flex-end; background: var(--accent-soft); }
    .msg.assistant { align-self: flex-start; background: var(--surface-2); }
    .after { display: inline-block; height: 6px; border-radius: 3px; background: var(--s1); vertical-align: middle; }
  `],
})
export class InsightsComponent {
  store = inject(StoreService);
  auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);

  items = signal<Insight[]>([]);
  loading = signal(true);
  category = signal('');
  categories = computed(() => [...new Set(this.items().map(i => i.category))]);
  shown = computed(() => this.items().filter(i => !this.category() || i.category === this.category()));
  counts = computed(() => ({
    warning: this.items().filter(i => i.severity === 'warning' || i.severity === 'critical').length,
    info: this.items().filter(i => i.severity === 'info').length,
    positive: this.items().filter(i => i.severity === 'positive').length,
  }));

  // rebalance
  newMoney = signal(0);
  allowSell = signal(false);
  plan = signal<RebalancePlan | null>(null);
  colorOf = (s: string) => SEGMENT_COLOR[s] ?? 'var(--s7)';

  // AI
  ai = signal<{ enabled: boolean; disclaimer: string } | null>(null);
  analysis = signal<string | null>(null);
  analyzing = signal(false);
  chat = signal<{ role: 'user' | 'assistant'; content: string }[]>([]);
  draft = '';
  sending = signal(false);
  suggestions = ['Where am I most concentrated?', 'How much should I invest where next month?', 'Which holdings should I review and why?', 'Am I on track for my goals?'];

  constructor() {
    effect(() => { this.store.version(); queueMicrotask(() => { this.load(); this.loadPlan(); }); });
    firstValueFrom(this.api.aiStatus()).then(s => this.ai.set(s)).catch(() => this.ai.set({ enabled: false, disclaimer: '' }));
  }

  async load() {
    try { this.items.set((await firstValueFrom(this.api.insights(true))).insights); }
    catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.loading.set(false); }
  }

  async dismiss(id: string) {
    try {
      await firstValueFrom(this.api.dismissInsight(id, 30));
      this.items.update(l => l.filter(i => i.id !== id));
      this.toast.ok('Hidden for 30 days');
    } catch (e) { this.toast.error(errorMessage(e)); }
  }

  async loadPlan() {
    try { this.plan.set(await firstValueFrom(this.api.rebalance(+this.newMoney() || 0, this.allowSell()))); }
    catch (e) { this.toast.error(errorMessage(e)); }
  }

  async markReviewed() {
    try {
      await firstValueFrom(this.api.completeReview());
      this.toast.ok('Review recorded — next reminder in 90 days');
      await this.store.changed();
    } catch (e) { this.toast.error(errorMessage(e)); }
  }

  async analyze() {
    this.analyzing.set(true);
    try { this.analysis.set((await firstValueFrom(this.api.aiAnalyze())).analysis); }
    catch (e) { this.toast.error(errorMessage(e)); }
    finally { this.analyzing.set(false); }
  }

  async send(text?: string) {
    const msg = (text ?? this.draft).trim();
    if (!msg || this.sending()) return;
    const history = this.chat();
    this.chat.set([...history, { role: 'user', content: msg }]);
    this.draft = '';
    this.sending.set(true);
    try {
      const r = await firstValueFrom(this.api.aiChat(msg, history));
      this.chat.update(c => [...c, { role: 'assistant', content: r.reply }]);
    } catch (e) {
      this.chat.update(c => [...c, { role: 'assistant', content: `⚠ ${errorMessage(e)}` }]);
    } finally {
      this.sending.set(false);
    }
  }
}
