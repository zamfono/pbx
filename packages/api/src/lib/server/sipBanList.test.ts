import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import { renderSipBanList, sipBanHelperState } from './sipBanList.js';

const genDir = (): string => process.env.ASTERISK_GEN_DIR ?? '';
const statusFile = (): string => path.join(genDir(), 'sip_ban_helper.status');
// The SHA-256 of the empty list, which a fresh database renders.
const EMPTY_HASH = createHash('sha256').update('').digest('hex');
const NOW = Date.parse('2026-10-05T12:00:00Z');

async function writeStatus(text: string): Promise<void> {
  await mkdir(genDir(), { recursive: true });
  await writeFile(statusFile(), text);
}

beforeEach(async () => {
  const db = await makeTestDb();
  await seedSettings(db);
  await renderSipBanList(db);
  await rm(statusFile(), { force: true });
});

describe('sipBanHelperState (§9.1, §10.3)', () => {
  it('runs with a fresh heartbeat naming the list api last rendered, with the drop counts', async () => {
    await writeStatus(`2026-10-05T11:59:01Z ${EMPTY_HASH} 12 3456\n`);
    expect(await sipBanHelperState(NOW)).toEqual({
      running: true,
      heartbeat: '2026-10-05T11:59:01Z',
      dropped: { packets: 12, bytes: 3456 }
    });
  });

  it.each([
    [
      'a heartbeat older than 60 seconds',
      `2026-10-05T11:58:59Z ${EMPTY_HASH} 0 0\n`,
      '2026-10-05T11:58:59Z',
      { packets: 0, bytes: 0 }
    ],
    [
      'another list',
      `2026-10-05T11:59:30Z ${'0'.repeat(64)} 1 60\n`,
      '2026-10-05T11:59:30Z',
      { packets: 1, bytes: 60 }
    ],
    ['an unreadable line', 'garbage\n', null, null],
    [
      'a line without the drop counts',
      `2026-10-05T11:59:01Z ${EMPTY_HASH}\n`,
      null,
      null
    ],
    ['an unparsable time', `yesterday ${EMPTY_HASH} 0 0\n`, null, null]
  ])('does not run for %s', async (_case, text, heartbeat, dropped) => {
    await writeStatus(text);
    expect(await sipBanHelperState(NOW)).toEqual({
      running: false,
      heartbeat,
      dropped
    });
  });

  it('does not run, with no heartbeat, while the file is missing', async () => {
    expect(await sipBanHelperState(NOW)).toEqual({
      running: false,
      heartbeat: null,
      dropped: null
    });
  });
});
