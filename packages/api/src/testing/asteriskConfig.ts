/**
 * Generated config read back the way Asterisk 22's parser (main/config.c) reads it, so a test
 * sees what Asterisk would load rather than what the renderer wrote.
 */

export type ConfigCategory = { name: string; variables: [string, string][] };

// `ast_strip` trims every character below this code point (space and the control characters).
const FIRST_UNSTRIPPED_CODE_POINT = 0x21;

function strip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) < FIRST_UNSTRIPPED_CODE_POINT) {
    start += 1;
  }
  while (
    end > start &&
    text.charCodeAt(end - 1) < FIRST_UNSTRIPPED_CODE_POINT
  ) {
    end -= 1;
  }
  return text.slice(start, end);
}

/** `line` up to its first `;` not preceded by a backslash; each escaped `\;` loses that one backslash. */
function stripComment(line: string): string {
  let text = line;
  let from = 0;
  for (;;) {
    const index = text.indexOf(';', from);
    if (index === -1) {
      return text;
    }
    if (index <= from || text[index - 1] !== '\\') {
      return text.slice(0, index);
    }
    text = text.slice(0, index - 1) + text.slice(index);
    from = index;
  }
}

/**
 * The categories of `text`: a line starting with `[` opens one, named up to its `]`; any other
 * splits at its first `=` into a stripped name and value, a `>` right after the `=` (`=>`)
 * dropped. A variable outside a category or a line without `=` throws, as Asterisk refuses both.
 */
export function parseAsteriskConfig(text: string): ConfigCategory[] {
  const categories: ConfigCategory[] = [];
  for (const raw of text.split('\n')) {
    const line = strip(stripComment(raw));
    if (line === '') {
      continue;
    }
    if (line.startsWith('[')) {
      categories.push({
        name: line.slice(1, line.indexOf(']')),
        variables: []
      });
      continue;
    }
    const equals = line.indexOf('=');
    const category = categories.at(-1);
    if (equals === -1 || category === undefined) {
      throw new Error(`parseAsteriskConfig: Asterisk refuses the line ${line}`);
    }
    const value = line.slice(equals + 1);
    category.variables.push([
      strip(line.slice(0, equals)),
      strip(value.startsWith('>') ? value.slice(1) : value)
    ]);
  }
  return categories;
}

/** Every value of `key` in `text`, in order, as Asterisk reads it. */
export function configValues(text: string, key: string): string[] {
  return parseAsteriskConfig(text).flatMap(category =>
    category.variables
      .filter(([name]) => name === key)
      .map(([, value]) => value)
  );
}
