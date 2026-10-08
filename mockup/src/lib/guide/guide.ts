/**
 * The demo operators' guide, DEMO-GUIDE.md, rendered once into HTML with its numbered sections. A
 * code span holding an app path (`/history?as=jonas`) becomes a link into the mockup; headings
 * carry ids for the guide's own contents.
 */
import { Marked, Renderer } from 'marked';

import source from '../../../DEMO-GUIDE.md?raw';

export type GuideSection = { id: string; title: string };

const escape = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const slug = (text: string): string =>
  `guide-${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/gu, '')}`;

const sections: GuideSection[] = [];
const base = new Renderer();
const marked = new Marked({
  renderer: {
    heading({ tokens, depth, text }) {
      const id = slug(text);
      if (depth === 2) {
        sections.push({ id, title: text.replace(/^\d+\.\s*/u, '') });
      }
      return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    codespan({ text }) {
      return text.startsWith('/')
        ? `<a class="route" href="${escape(text)}"><code>${escape(text)}</code></a>`
        : false;
    },
    link({ href, tokens }) {
      return `<a href="${escape(href)}" target="_blank" rel="noopener">${this.parser.parseInline(tokens)}</a>`;
    },
    table(token) {
      return `<div class="table">${base.table.call(this, token)}</div>\n`;
    }
  }
});

/** The guide's title: its first heading. */
export const guideTitle = /^# (.*)$/mu.exec(source)?.[1] ?? '';

/** The guide below its title, as HTML. */
export const guideHtml = marked.parse(source.replace(/^# .*\n/u, ''), {
  async: false
});

/** The guide's numbered sections, in order. */
export const guideSections: readonly GuideSection[] = sections;
