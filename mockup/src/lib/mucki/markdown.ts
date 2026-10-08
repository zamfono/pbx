/**
 * The light markdown of Mucki's replies, parsed into blocks a component renders without `{@html}`:
 * paragraphs, bulleted and numbered lists; inline **bold**, `code`, line breaks and links. A link
 * to `#/path` opens that page of the app.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string; app: boolean }
  | { type: 'br' };

export type Block =
  { type: 'p'; inline: Inline[] } | { type: 'ul' | 'ol'; items: Inline[][] };

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/gu;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/u;
const BULLET = /^\s*[-•*]\s+/u;
const NUMBERED = /^\s*\d+[.)]\s+/u;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) {
      out.push({ type: 'br' });
    }
    for (const part of line.split(INLINE)) {
      if (part === '') {
        continue;
      }
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        out.push({ type: 'bold', text: part.slice(2, -2) });
      } else if (
        part.startsWith('`') &&
        part.endsWith('`') &&
        part.length > 2
      ) {
        out.push({ type: 'code', text: part.slice(1, -1) });
      } else {
        const link = LINK.exec(part);
        if (link !== null) {
          const href = link[2] ?? '';
          const app = href.startsWith('#/');
          const safe = app || /^https?:\/\//u.test(href);
          out.push(
            safe
              ? { type: 'link', text: link[1] ?? '', href, app }
              : { type: 'text', text: link[1] ?? '' }
          );
        } else {
          out.push({ type: 'text', text: part });
        }
      }
    }
  });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of source.trim().split(/\n\s*\n/u)) {
    const lines = chunk.split('\n');
    let paragraph: string[] = [];
    let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
    const flushParagraph = (): void => {
      if (paragraph.length > 0) {
        blocks.push({ type: 'p', inline: parseInline(paragraph.join('\n')) });
        paragraph = [];
      }
    };
    const flushList = (): void => {
      if (list !== null) {
        blocks.push({ type: list.type, items: list.items.map(parseInline) });
        list = null;
      }
    };
    for (const line of lines) {
      const kind = BULLET.test(line) ? 'ul' : NUMBERED.test(line) ? 'ol' : null;
      if (kind === null) {
        if (list !== null && /^\s{2,}\S/u.test(line)) {
          // A continuation line of the last list item.
          const items: string[] = (list as { items: string[] }).items;
          items[items.length - 1] += `\n${line.trim()}`;
          continue;
        }
        flushList();
        paragraph.push(line);
        continue;
      }
      flushParagraph();
      if (list === null || (list as { type: string }).type !== kind) {
        flushList();
        list = { type: kind, items: [] };
      }
      (list as { items: string[] }).items.push(
        line.replace(kind === 'ul' ? BULLET : NUMBERED, '')
      );
    }
    flushParagraph();
    flushList();
  }
  return blocks;
}

/** Plain text without markup, for streaming estimates and accessible labels. */
export function plainText(source: string): string {
  return source
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/gu, '$1');
}

/**
 * `source` cut into growing prefixes for the streaming effect: whole words, and markup (bold,
 * code, links) never split, so every prefix renders cleanly.
 */
export function streamChunks(source: string, wordsPerChunk = 3): string[] {
  const atoms: string[] = [];
  for (const part of source.split(INLINE)) {
    if (part === '') {
      continue;
    }
    if (INLINE_ATOM.test(part)) {
      atoms.push(part);
    } else {
      atoms.push(...(part.match(/\s*\S+\s*|\s+/gu) ?? []));
    }
  }
  const prefixes: string[] = [];
  let text = '';
  for (let index = 0; index < atoms.length; index += wordsPerChunk) {
    text += atoms.slice(index, index + wordsPerChunk).join('');
    prefixes.push(text);
  }
  return prefixes;
}

const INLINE_ATOM = /^(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))$/u;
