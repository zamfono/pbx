import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { isDbOpen, openDb } from './db.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zamfono-open-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The first bytes of an SQLite file: its header, which every read of a page checks. */
const HEADER_BYTES = 100;

test('isDbOpen fails once the file under an open handle no longer reads', async () => {
  const file = path.join(dir, 'zamfono.db');
  const held = openDb(file);
  const writer = openDb(file);
  await sql`create table t (x)`.execute(writer);
  await sql`pragma wal_checkpoint(truncate)`.execute(writer);
  expect(await isDbOpen(held)).toBe(true);

  const fd = openSync(file, 'r+');
  writeSync(fd, Buffer.alloc(HEADER_BYTES, 'x'), 0, HEADER_BYTES, 0);
  closeSync(fd);
  // Another process's write, as `core` writes all the time, makes the held handle read again.
  await sql`insert into t values (1)`.execute(writer);

  expect(await isDbOpen(held)).toBe(false);
  await held.destroy();
  await writer.destroy();
});
