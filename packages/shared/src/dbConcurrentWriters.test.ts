import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { openDb } from './db.js';

// The other process writing the same file (§3.1 "Write ownership": `core` beside `api`), as a
// thread of its own with its own connection, so its wait on the lock blocks only itself.
const OTHER_WRITER = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
const db = new Database(workerData.file);
db.pragma('busy_timeout = 5000');
parentPort.once('message', () => {
  try {
    db.prepare('update t set x = x + 100').run();
    parentPort.postMessage('ok');
  } catch (error) {
    parentPort.postMessage(error.code);
  }
});
`;

test('a transaction that reads before it writes commits while another connection writes the file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zamfono-writers-'));
  const file = path.join(dir, 'db.sqlite');
  const db = openDb(file);
  await sql`create table t (x integer)`.execute(db);
  await sql`insert into t values (1)`.execute(db);
  const other = new Worker(OTHER_WRITER, {
    eval: true,
    workerData: {
      file,
      driver: createRequire(import.meta.url).resolve('better-sqlite3')
    }
  });
  const otherWrote = new Promise(resolve => {
    other.once('message', resolve);
  });
  try {
    await db.transaction().execute(async trx => {
      await sql`select x from t`.execute(trx);
      other.postMessage('write');
      // What the other process commits while this transaction is open.
      await new Promise(resolve => {
        setTimeout(resolve, 100);
      });
      await sql`update t set x = x + 10`.execute(trx);
    });
    expect(await otherWrote).toBe('ok');
    const row = await sql<{
      x: number;
    }>`select x from t`.execute(db);
    expect(row.rows[0]?.x).toBe(111);
  } finally {
    await other.terminate();
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
