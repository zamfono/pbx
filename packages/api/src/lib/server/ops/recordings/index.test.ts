import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import type { BinaryResult } from '#lib/server/binaryResult.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

const user: Actor = { id: 'u1', name: 'Anna', role: 'user' };

async function seedCall(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('calls')
    .values({
      id,
      direction: 'inbound',
      fromUri: '+491234',
      toUri: '101',
      status: 'answered',
      startedAt: nowIso()
    })
    .execute();
  return id;
}

async function seedRecording(
  db: Db,
  fields: { id?: string; filename?: string }
): Promise<{ id: string; callId: string }> {
  const callId = await seedCall(db);
  const id = fields.id ?? newId();
  await db
    .insertInto('recordings')
    .values({
      id,
      callId,
      userId: null,
      filename: fields.filename ?? `${id}.wav`,
      durationS: 30,
      createdAt: nowIso()
    })
    .execute();
  return { id, callId };
}

describe('recordings', () => {
  it('lists recordings for an admin and refuses a user role', async () => {
    const db = await makeTestDb();
    const { id } = await seedRecording(db, {});
    const listed = (await runOperation(db, 'recordings.list', {}, asRun())) as {
      items: { id: string }[];
    };
    expect(listed.items.map(item => item.id)).toContain(id);
    await expect(
      runOperation(db, 'recordings.list', {}, asRun({ actor: user }))
    ).rejects.toMatchObject({ status: 403 });
  });

  it('recordings.audio answers the stored WAV', async () => {
    const db = await makeTestDb();
    const { id } = await seedRecording(db, { id: 'rec-2' });
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'zamfono-rec-'));
    onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
    await mkdir(path.join(mediaDir, 'recordings'), { recursive: true });
    await writeFile(path.join(mediaDir, 'recordings', 'rec-2.wav'), 'wav');
    const previousMediaDir = process.env.MEDIA_DIR;
    process.env.MEDIA_DIR = mediaDir;
    try {
      const file = (await runOperation(
        db,
        'recordings.audio',
        { id },
        asRun()
      )) as BinaryResult;
      expect(file.contentType).toBe('audio/wav');
      expect((await file.read()).toString()).toBe('wav');
    } finally {
      if (previousMediaDir === undefined) {
        delete process.env.MEDIA_DIR;
      } else {
        process.env.MEDIA_DIR = previousMediaDir;
      }
    }
  });

  it('recordings.delete removes file, raw pair and row with undoable 0', async () => {
    const db = await makeTestDb();
    const filename = 'rec-1.wav';
    const { id } = await seedRecording(db, { id: 'rec-1', filename });
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'zamfono-rec-'));
    onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
    await mkdir(path.join(mediaDir, 'recordings'), { recursive: true });
    const filePath = path.join(mediaDir, 'recordings', filename);
    await writeFile(filePath, 'audio-bytes');
    // The raw per-leg pair it was mixed from, had it been left behind (§11.6), at 8 or 16 kHz.
    const rawPaths = ['rec-1-l.wav', 'rec-1-r.wav16'].map(name =>
      path.join(mediaDir, 'recordings', name)
    );
    await Promise.all(rawPaths.map(rawPath => writeFile(rawPath, 'raw')));
    const previousMediaDir = process.env.MEDIA_DIR;
    process.env.MEDIA_DIR = mediaDir;
    try {
      await runOperation(
        db,
        'recordings.delete',
        { id },
        asRun({ confirm: true })
      );
    } finally {
      if (previousMediaDir === undefined) {
        delete process.env.MEDIA_DIR;
      } else {
        process.env.MEDIA_DIR = previousMediaDir;
      }
    }

    await expect(access(filePath)).rejects.toThrow();
    for (const rawPath of rawPaths) {
      // eslint-disable-next-line no-await-in-loop -- two files, checked one at a time
      await expect(access(rawPath)).rejects.toThrow();
    }
    const row = await db
      .selectFrom('recordings')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    expect(row).toBeUndefined();
    const auditRow = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('operation', '=', 'recordings.delete')
      .executeTakeFirstOrThrow();
    expect(auditRow.undoable).toBe(0);
  });
});
