#!/usr/bin/env node
// Aligns the columns of every GitHub-flavoured Markdown table in the given files, so the tables
// read well in the source view too, and leaves every other byte of the file alone. It exists for
// the Markdown that .prettierignore keeps away from Prettier (the hand-formatted specification):
// Prettier would also rewrite its emphasis, lists and embedded listings.
//
//   node scripts/format-md-tables.mjs [--check] [file ...]
//
// Without files it formats docs/spec.md. With --check it rewrites nothing and
// exits non-zero when a file would change, listing it. A table whose aligned rows would exceed
// MAX_TABLE_WIDTH is left as it is and named on stderr instead: cells that long are paragraphs,
// and the better fix is one paragraph per row, not a wider table.
import console from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** @typedef {'left' | 'right' | 'center'} Alignment */

const CHECK_FLAG = '--check';
const DRIFT_EXIT_CODE = 1;
const DEFAULT_FILES = [path.join('docs', 'spec.md')];
// The delimiter row sits right below the header row.
const DELIMITER_INDEX = 1;
// GitHub renders a delimiter cell only with at least three dashes' worth of width.
const MIN_COLUMN_WIDTH = 3;
const HALF = 2;
const MAX_TABLE_WIDTH = 200;
const FENCE = /^\s*(?:```|~~~)/u;
const DELIMITER_CELL = /^:?-+:?$/u;
const LEADING_PIPE = /^\|/u;
const TRAILING_PIPE = /(?<!\\)\|$/u;
const CELL_SEPARATOR = /(?<!\\)\|/u;
const segmenter = new Intl.Segmenter();

/**
 * Display width of a cell: one per grapheme, which holds for the Latin text and symbols used here.
 * @param {string} text
 * @returns {number}
 */
function width(text) {
  return [...segmenter.segment(text)].length;
}

/**
 * Splits a table row into trimmed cells, honouring `\|` as a literal pipe.
 * @param {string} row
 * @returns {string[]}
 */
function cells(row) {
  const inner = row.trim().replace(LEADING_PIPE, '').replace(TRAILING_PIPE, '');
  return inner.split(CELL_SEPARATOR).map(cell => cell.trim());
}

/**
 * @param {string} row
 * @returns {boolean}
 */
function isDelimiterRow(row) {
  if (!row.trim().startsWith('|')) {
    return false;
  }
  return cells(row).every(cell => DELIMITER_CELL.test(cell));
}

/**
 * @param {string} cell a delimiter cell such as `---`, `:---`, `---:` or `:---:`
 * @returns {Alignment}
 */
function alignmentOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) {
    return 'center';
  }
  return right ? 'right' : 'left';
}

/**
 * @param {string} text
 * @param {number} size
 * @param {Alignment} alignment
 * @returns {string}
 */
function pad(text, size, alignment) {
  const gap = size - width(text);
  if (alignment === 'right') {
    return `${' '.repeat(gap)}${text}`;
  }
  if (alignment === 'center') {
    const before = Math.floor(gap / HALF);
    return `${' '.repeat(before)}${text}${' '.repeat(gap - before)}`;
  }
  return `${text}${' '.repeat(gap)}`;
}

/**
 * @param {number} size
 * @param {Alignment} alignment
 * @returns {string}
 */
function delimiter(size, alignment) {
  if (alignment === 'center') {
    return `:${'-'.repeat(size - HALF)}:`;
  }
  if (alignment === 'right') {
    return `${'-'.repeat(size - 1)}:`;
  }
  return '-'.repeat(size);
}

/**
 * Renders one table (header, delimiter and body rows) with every column padded to its widest cell.
 * @param {string[]} rows
 * @returns {string[]}
 */
function formatTable(rows) {
  const parsed = rows.map(row => cells(row));
  const alignments = (parsed[DELIMITER_INDEX] ?? []).map(cell =>
    alignmentOf(cell)
  );
  const columns = Math.max(...parsed.map(row => row.length));
  const widths = Array.from({ length: columns }, (_unused, column) =>
    Math.max(
      MIN_COLUMN_WIDTH,
      ...parsed.map((row, index) =>
        index === DELIMITER_INDEX ? 0 : width(row[column] ?? '')
      )
    )
  );
  return parsed.map((row, index) => {
    const rendered = widths.map((size, column) => {
      const alignment = alignments[column] ?? 'left';
      return index === DELIMITER_INDEX
        ? delimiter(size, alignment)
        : pad(row[column] ?? '', size, alignment);
    });
    return `| ${rendered.join(' | ')} |`;
  });
}

/**
 * Formats every table outside fenced code blocks that fits MAX_TABLE_WIDTH once aligned; wider
 * tables and everything else are copied through unchanged, and the wide tables' first lines are
 * returned so the caller can name them.
 * @param {string} source
 * @returns {{ text: string, tooWide: number[] }}
 */
export function formatTables(source) {
  const lines = source.split('\n');
  /** @type {string[]} */
  const output = [];
  /** @type {number[]} */
  const tooWide = [];
  let fenced = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (FENCE.test(line)) {
      fenced = !fenced;
    }
    const isTableStart =
      !fenced &&
      line.startsWith('|') &&
      index + 1 < lines.length &&
      isDelimiterRow(lines[index + 1] ?? '');
    if (isTableStart) {
      let end = index + DELIMITER_INDEX + 1;
      while ((lines[end] ?? '').startsWith('|')) {
        end += 1;
      }
      const table = lines.slice(index, end);
      const aligned = formatTable(table);
      if (aligned.some(row => width(row) > MAX_TABLE_WIDTH)) {
        tooWide.push(index + 1);
        output.push(...table);
      } else {
        output.push(...aligned);
      }
      index = end;
    } else {
      output.push(line);
      index += 1;
    }
  }
  return { text: output.join('\n'), tooWide };
}

function main() {
  const args = process.argv.slice(HALF);
  const check = args.includes(CHECK_FLAG);
  const named = args.filter(arg => arg !== CHECK_FLAG);
  const files = named.length > 0 ? named : DEFAULT_FILES;
  const changed = files.filter(file => {
    const source = readFileSync(file, 'utf8');
    const { text: formatted, tooWide } = formatTables(source);
    for (const line of tooWide) {
      console.warn(
        `${file}:${String(line)}: table wider than ${String(MAX_TABLE_WIDTH)} columns once aligned, left as is; consider one paragraph per row`
      );
    }
    if (formatted === source) {
      return false;
    }
    if (!check) {
      writeFileSync(file, formatted);
    }
    return true;
  });
  if (check && changed.length > 0) {
    console.error(
      `tables not aligned (run npm run format):\n  ${changed.join('\n  ')}`
    );
    process.exitCode = DRIFT_EXIT_CODE;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
