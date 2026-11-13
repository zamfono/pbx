import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mediaUsageBytes } from '@zamfono/shared';

import { MEDIA_USAGE_CACHE_MS, mediaLimit } from './mediaLimit.js';
import { noopLogger } from './testing/pipelineDeps.js';

describe('mediaLimit (§11.6)', () => {
  let dir: string;
  // What the one file takes on disk, a block or more, whatever its 100 bytes.
  let used: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'zamfono-core-media-'));
    await writeFile(path.join(dir, 'a.wav'), Buffer.alloc(100));
    used = await mediaUsageBytes(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is full at or over the limit, not below it, and never without one', async () => {
    expect(await mediaLimit(dir, used - 1, noopLogger).full()).toBe(true);
    expect(await mediaLimit(dir, used, noopLogger).full()).toBe(true);
    expect(await mediaLimit(dir, used + 1, noopLogger).full()).toBe(false);
    expect(await mediaLimit(dir, null, noopLogger).full()).toBe(false);
  });

  it('walks the volume again only once its last measurement is MEDIA_USAGE_CACHE_MS old', async () => {
    let clock = 0;
    const limit = mediaLimit(dir, used + 1, noopLogger, () => clock);
    expect(await limit.full()).toBe(false);
    await writeFile(path.join(dir, 'b.wav'), Buffer.alloc(100));
    clock = MEDIA_USAGE_CACHE_MS - 1;
    expect(await limit.full()).toBe(false);
    clock = MEDIA_USAGE_CACHE_MS;
    expect(await limit.full()).toBe(true);
  });

  it('admits a recording below the limit and refuses one at it, logging and counting the refusal', async () => {
    const warnings: unknown[][] = [];
    const log = {
      ...noopLogger,
      warn: (...args: unknown[]) => {
        warnings.push(args);
      }
    };
    expect(await mediaLimit(dir, used + 1, log).admitsRecording({})).toBe(true);
    const atLimit = mediaLimit(dir, used, log);
    expect(await atLimit.admitsRecording({ callId: 'c1' })).toBe(false);
    expect(atLimit.refusedRecordings).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toEqual({ callId: 'c1' });
  });
});
