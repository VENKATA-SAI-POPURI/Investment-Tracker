import { Pipe, PipeTransform } from '@angular/core';

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function inline(s: string) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>').replace(/`(.+?)`/g, '<code>$1</code>');
}

/** Tiny, escape-first markdown renderer for AI replies (headings, lists, bold, paragraphs). */
@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  transform(md: string | null | undefined): string {
    if (!md) return '';
    const out: string[] = [];
    let list: 'ul' | 'ol' | null = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of md.split(/\r?\n/)) {
      const line = raw.trimEnd();
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); out.push(`<h4>${inline(m[2])}</h4>`); }
      else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if (!line.trim()) { close(); }
      else { close(); out.push(`<p>${inline(line)}</p>`); }
    }
    close();
    return out.join('');
  }
}
