import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';

import type { Logger } from '../ari/types.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { storeParticipation } from './recordingStore.js';

// Only the `recordings` insert is reached; its content is covered by `recording.test.ts`.
const fakeDb = {
  insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) })
} as unknown as Db;

describe('storeParticipation', () => {
  it('names the call on the line for a raw file it could not remove (§7 "Logs")', async () => {
    // `rm` without `recursive` refuses a directory, which stands in for a raw file it cannot remove.
    const undeletable = await mkdtemp(path.join(tmpdir(), 'recording-store-'));
    const warnings: unknown[][] = [];
    const log: Logger = {
      ...noopLogger,
      warn: (...args) => {
        warnings.push(args);
      },
      error: () => undefined
    };

    const stored = await storeParticipation(
      { db: fakeDb, mix: () => Promise.resolve(0), log, now: () => 'now' },
      {
        id: 'recording-1',
        callId: 'call-1',
        userId: null,
        leftPath: undeletable,
        rightPath: path.join(undeletable, 'absent-r.wav'),
        outPath: path.join(undeletable, 'out.wav')
      }
    );

    expect(stored).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toMatchObject({
      callId: 'call-1',
      recordingId: 'recording-1',
      file: undeletable
    });
    await rm(undeletable, { recursive: true, force: true });
  });
});
