import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi
} from 'vitest';

import { newId, nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import type { AriEvent, Logger } from '../ari/types.js';
import { CdrWriter } from '../cdr.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { noopLogger, testPipelineDeps } from '../testing/pipelineDeps.js';
import { callerChannel, newCall, type Call, type Leg } from './call.js';
import { trackLeg } from './legs.js';
import { handleChannelEnded } from './legsEnded.js';
import { Pipeline } from './pipeline.js';
import { Recorder } from './recording.js';

const NOW = '2026-01-01T00:01:00.000Z';
const MEDIA_DIR = '/media/recordings';
const MIX_SAMPLE_RATE_HZ = 8000;

/** A raw per-leg file that captured no audio at all: the ~78-byte header-only wav Asterisk
 * writes when a snoop channel's recording is stopped before it ever received a sample (a muted
 * phone, Opus DTX, or a one-way leg, §10.2 "Best effort"). */
function makeHeaderOnlyWav(filePath: string): void {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    's16le',
    '-ar',
    String(MIX_SAMPLE_RATE_HZ),
    '-ac',
    '1',
    '-i',
    '/dev/null',
    '-c:a',
    'pcm_s16le',
    filePath
  ]);
}

function fakeLogger(): Logger & { errors: unknown[][] } {
  const errors: unknown[][] = [];
  return {
    errors,
    ...noopLogger,
    error: (...args) => {
      errors.push(args);
    }
  };
}

async function seedForwardTargetUser(db: Db, userId: string): Promise<string> {
  const id = newId();
  await db.insertInto('forwardTargets').values({ id, userId }).execute();
  return id;
}

async function seedDid(db: Db, targetId: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('dids')
    .values({ id, number: '+15551000', targetId, createdAt: nowIso() })
    .execute();
  return id;
}

async function seedSettings(db: Db, mainDidId: string): Promise<void> {
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId,
      country: 'DE',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
}

async function seedUser(db: Db, recordCalls: boolean): Promise<string> {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      name: 'Test User',
      email: `${id}@example.com`,
      createdAt: nowIso(),
      recordCalls: recordCalls ? 1 : 0
    })
    .execute();
  return id;
}

async function seedRingGroup(db: Db, recordCalls: boolean): Promise<string> {
  const id = newId();
  await db
    .insertInto('ringGroups')
    .values({
      id,
      name: `Group ${id}`,
      strategy: 'simultaneous',
      recordCalls: recordCalls ? 1 : 0,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

function buildCall(ringGroupId: string | null): Call {
  const call = newCall({
    id: newId(),
    direction: 'inbound',
    callerChannelId: 'caller-channel',
    from: '+15559999',
    to: '+15551000',
    startedAt: '2026-01-01T00:00:00.000Z',
    logLevel: 'events',
    callLogMaxBytes: 1_048_576
  });
  call.ringGroupId = ringGroupId;
  return call;
}

function buildLeg(overrides: Partial<Leg> & { channelId: string }): Leg {
  return {
    kind: 'device',
    userId: null,
    state: 'up',
    endCause: null,
    ...overrides
  };
}

describe('Recorder', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let cache: ConfigCache;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let cdr: CdrWriter;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    cache = new ConfigCache(db);
    // `recordings.call_id` is a hard FK (§11.2): `cdr.open()` is what gives a call's row to
    // reference before the call itself ends, exactly as the pipeline does in production.
    cdr = new CdrWriter({
      log: noopLogger,
      db,
      ari,
      cache,
      bus: new EventBus(),
      state: new StateStore(),
      now: () => NOW
    });
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await db.destroy();
  });

  function snoopCalls(): { spy?: string }[] {
    return fakeAri.calls
      .filter(entry => entry.path.endsWith('/snoop'))
      .map(entry => entry.body as { spy?: string });
  }

  function recordCalls(): { name?: string }[] {
    return fakeAri.calls
      .filter(entry => entry.path.endsWith('/record'))
      .map(entry => entry.body as { name?: string });
  }

  /** Simulates Asterisk's `RecordingFinished` event for the snoop recording `name`, which
   * `Recorder.end()` awaits before mixing (§10.2). */
  function emitRecordingFinished(
    name: string | undefined,
    duration: number
  ): void {
    fakeAri.emit({
      type: 'RecordingFinished',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: { name, duration }
    });
  }

  it('records when the user is off but the routing ring group is on (OR-resolution)', async () => {
    const userId = await seedUser(db, false);
    const groupId = await seedRingGroup(db, true);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: () => Promise.resolve(0),
      log: fakeLogger(),
      now: () => NOW
    });
    const call = buildCall(groupId);
    fakeAri.addChannel({ id: 'leg-channel' });
    const leg = buildLeg({ channelId: 'leg-channel', userId });

    await recorder.onLegUp(call, leg);

    // §10.2 "Channels and stereo mapping": left (`-l`) is the recorded user's own voice — read
    // *from* their channel, ARI's `spy: 'in'` — right (`-r`) is everything they heard, written
    // *to* it, `spy: 'out'`.
    const spies = snoopCalls().map(body => body.spy);
    const names = recordCalls().map(body => body.name);
    expect(spies).toEqual(['in', 'out']);
    expect(names[0]?.endsWith('-l')).toBe(true);
    expect(names[1]?.endsWith('-r')).toBe(true);
    // §11.6: the raw per-leg files live in `media/recordings/`. The name is relative to Asterisk's
    // recording directory, which the image resolves to the shared media volume, so the prefix here
    // is what puts the file where the mixer later reads it.
    expect(names[0]?.startsWith('recordings/')).toBe(true);
    expect(names[1]?.startsWith('recordings/')).toBe(true);
  });

  it("starts no snoop for a trunk leg, no user's participation, even when the routing group records", async () => {
    const userId = await seedUser(db, false);
    const groupId = await seedRingGroup(db, true);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: () => Promise.resolve(0),
      log: fakeLogger(),
      now: () => NOW
    });
    // A group's forward to an external number: the answered leg is the trunk's (§10.1 step 7).
    const call = buildCall(groupId);
    fakeAri.addChannel({ id: 'trunk-channel' });
    const leg = buildLeg({ channelId: 'trunk-channel', kind: 'trunk' });

    await recorder.onLegUp(call, leg);

    expect(snoopCalls()).toHaveLength(0);
  });

  it('starts no snoop for a direct call whose user has recording off', async () => {
    const userId = await seedUser(db, false);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: () => Promise.resolve(0),
      log: fakeLogger(),
      now: () => NOW
    });
    const call = buildCall(null);
    const leg = buildLeg({ channelId: 'leg-channel', userId });

    await recorder.onLegUp(call, leg);

    expect(snoopCalls()).toHaveLength(0);
  });

  it('yields spy in + spy out and, after the leg ends, one recordings row', async () => {
    const userId = await seedUser(db, true);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const mixed: [string, string, string][] = [];
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: (leftPath, rightPath, outPath) => {
        mixed.push([leftPath, rightPath, outPath]);
        return Promise.resolve(7.4);
      },
      log: fakeLogger(),
      now: () => NOW
    });
    const call = buildCall(null);
    await cdr.open(call);
    fakeAri.addChannel({ id: 'leg-channel' });
    const leg = buildLeg({ channelId: 'leg-channel', userId });

    await recorder.onLegUp(call, leg);
    const spies = snoopCalls().map(body => body.spy);
    expect(spies.sort()).toEqual(['in', 'out']);
    const [leftName, rightName] = recordCalls().map(body => body.name);

    const ended = recorder.onLegEnded(call, leg);
    emitRecordingFinished(leftName, 5);
    emitRecordingFinished(rightName, 7);
    await ended;

    expect(mixed).toHaveLength(1);
    // §11.6: the mixer reads and writes inside `media/recordings/`, the same directory Asterisk
    // wrote the raw pair into; a path outside it would name a file that does not exist.
    for (const filePath of mixed[0] ?? []) {
      expect(filePath.startsWith(`${MEDIA_DIR}/recordings/`)).toBe(true);
    }
    const rows = await db
      .selectFrom('recordings')
      .selectAll()
      .where('callId', '=', call.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      callId: call.id,
      userId,
      filename: `${rows[0]?.id}.wav`
    });
    // §11.2: `durationS` is the mixed file's own length, rounded to whole seconds.
    expect(rows[0]?.durationS).toBe(7);
  });

  it('carries a participation over to the call its leg moved to, whose row then names it (§10.2 "Call parking")', async () => {
    const userId = await seedUser(db, true);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: () => Promise.resolve(3),
      log: fakeLogger(),
      now: () => NOW
    });
    const ringback = buildCall(null);
    const parked = buildCall(null);
    await cdr.open(ringback);
    await cdr.open(parked);
    fakeAri.addChannel({ id: 'ringback-leg' });
    const leg = buildLeg({ channelId: 'ringback-leg', userId });
    await recorder.onLegUp(ringback, leg);
    const [leftName, rightName] = recordCalls().map(body => body.name);

    recorder.onLegMoved(ringback, parked, leg);
    // The call it left no longer holds it; the one it moved to ends it.
    await recorder.onLegEnded(ringback, leg);
    expect(recorder.inProgressCount).toBe(1);
    const ended = recorder.onLegEnded(parked, leg);
    emitRecordingFinished(leftName, 3);
    emitRecordingFinished(rightName, 3);
    await ended;

    const rows = await db
      .selectFrom('recordings')
      .select(['callId', 'userId'])
      .execute();
    expect(rows).toEqual([{ callId: parked.id, userId }]);
  });

  it('records a wideband bridge at 16 kHz: both snoops `wav16`, the mix reading `.wav16` (§10.2 "Sample rate")', async () => {
    const userId = await seedUser(db, true);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const mixed: [string, string, string][] = [];
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: (...paths) => {
        mixed.push(paths);
        return Promise.resolve(2);
      },
      log: fakeLogger(),
      now: () => NOW
    });
    const call = buildCall(null);
    await cdr.open(call);
    // An Opus caller answered by a G.711 device: one wideband leg is enough.
    fakeAri.addChannel({ id: 'caller-channel' });
    fakeAri.addChannel({ id: 'leg-channel' });
    fakeAri.channelVariables.set(
      'caller-channel:CHANNEL(audionativeformat)',
      '(opus)'
    );
    fakeAri.channelVariables.set(
      'leg-channel:CHANNEL(audionativeformat)',
      '(alaw)'
    );
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, 'caller-channel');
    await ari.bridges.addChannel(bridge.id, 'leg-channel');
    const leg = buildLeg({ channelId: 'leg-channel', userId });

    await recorder.onLegUp(call, leg);
    const records = fakeAri.calls
      .filter(entry => entry.path.endsWith('/record'))
      .map(entry => entry.body as { name?: string; format?: string });
    expect(records.map(body => body.format)).toEqual(['wav16', 'wav16']);
    const ended = recorder.onLegEnded(call, leg);
    // Asterisk's `RecordingFinished` duration divides the samples by 8000 whatever the format, so
    // a 2 s `wav16` recording reports 4: `durationS` is the mix's own 2 s, not that.
    emitRecordingFinished(records[0]?.name, 4);
    emitRecordingFinished(records[1]?.name, 4);
    await ended;

    const rows = await db
      .selectFrom('recordings')
      .select('durationS')
      .where('callId', '=', call.id)
      .execute();
    expect(rows).toEqual([{ durationS: 2 }]);

    // Asterisk names a `wav16` recording `<name>.wav16`; the mix is still `<id>.wav`.
    const entry = mixed[0];
    if (entry === undefined) {
      throw new Error('recording: no mix call recorded');
    }
    const [leftPath, rightPath, outPath] = entry;
    expect(leftPath.endsWith('-l.wav16')).toBe(true);
    expect(rightPath.endsWith('-r.wav16')).toBe(true);
    expect(outPath.endsWith('.wav')).toBe(true);
  });

  it('removes the raw pair after a successful mix, and keeps it after a failed one (§10.2)', async () => {
    const userId = await seedUser(db, true);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const mediaDir = await mkdtemp(path.join(tmpdir(), 'zamfono-recording-'));
    onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
    await mkdir(path.join(mediaDir, 'recordings'));
    let failMix = false;
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir,
      mix: () =>
        failMix ? Promise.reject(new Error('ffmpeg')) : Promise.resolve(0),
      log: fakeLogger(),
      now: () => NOW
    });
    fakeAri.addChannel({ id: 'leg-channel' });

    /** One participation on `leg-channel`, its raw pair written as Asterisk would. */
    const participate = async (): Promise<string[]> => {
      const call = buildCall(null);
      await cdr.open(call);
      const leg = buildLeg({ channelId: 'leg-channel', userId });
      const before = recordCalls().length;
      await recorder.onLegUp(call, leg);
      const names = recordCalls()
        .slice(before)
        .map(body => body.name ?? '');
      const files = names.map(name => path.join(mediaDir, `${name}.wav`));
      await Promise.all(files.map(file => writeFile(file, 'raw')));
      const ended = recorder.onLegEnded(call, leg);
      for (const name of names) {
        emitRecordingFinished(name, 5);
      }
      await ended;
      return files;
    };

    for (const file of await participate()) {
      // eslint-disable-next-line no-await-in-loop -- two files, checked one at a time
      await expect(access(file)).rejects.toThrow();
    }
    failMix = true;
    for (const file of await participate()) {
      // eslint-disable-next-line no-await-in-loop -- see above
      await expect(access(file)).resolves.toBeUndefined();
    }
  });

  it('a snoop that cannot start logs an error and never fails the call (§10.2 "Best effort")', async () => {
    const userId = await seedUser(db, true);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const log = fakeLogger();
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: () => Promise.resolve(0),
      log,
      now: () => NOW
    });
    const call = buildCall(null);
    await cdr.open(call);
    // No such channel on the fake, so Asterisk refuses the snoop with a 404.
    const leg = buildLeg({ channelId: 'vanished-channel', userId });

    await expect(recorder.onLegUp(call, leg)).resolves.toBeUndefined();
    await recorder.onLegEnded(call, leg);

    expect(log.errors).toHaveLength(1);
    expect(recordCalls()).toHaveLength(0);
    const rows = await db
      .selectFrom('recordings')
      .selectAll()
      .where('callId', '=', call.id)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('leaves no recordings row and logs when the mix fails', async () => {
    const userId = await seedUser(db, true);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const log = fakeLogger();
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: () => {
        throw new Error('ffmpeg exploded');
      },
      log,
      now: () => NOW
    });
    const call = buildCall(null);
    fakeAri.addChannel({ id: 'leg-channel' });
    const leg = buildLeg({ channelId: 'leg-channel', userId });

    await recorder.onLegUp(call, leg);
    const [leftName, rightName] = recordCalls().map(body => body.name);
    const ended = recorder.onLegEnded(call, leg);
    emitRecordingFinished(leftName, 5);
    emitRecordingFinished(rightName, 5);
    await ended;

    const rows = await db
      .selectFrom('recordings')
      .selectAll()
      .where('callId', '=', call.id)
      .execute();
    expect(rows).toHaveLength(0);
    expect(log.errors).toHaveLength(1);
    expect(recorder.mixFailureCount).toBe(1);
  });

  it('counts a participation in progress from its start until its mix is stored (§6.4)', async () => {
    const userId = await seedUser(db, true);
    const targetId = await seedForwardTargetUser(db, userId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const mixing = Promise.withResolvers<number>();
    const mixStarted = Promise.withResolvers<undefined>();
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: async () => {
        mixStarted.resolve(undefined);
        return mixing.promise;
      },
      log: fakeLogger(),
      now: () => NOW
    });
    const call = buildCall(null);
    await cdr.open(call);
    fakeAri.addChannel({ id: 'leg-channel' });
    const leg = buildLeg({ channelId: 'leg-channel', userId });
    expect(recorder.inProgressCount).toBe(0);

    await recorder.onLegUp(call, leg);
    expect(recorder.inProgressCount).toBe(1);
    const [leftName, rightName] = recordCalls().map(body => body.name);
    const ended = recorder.onLegEnded(call, leg);
    emitRecordingFinished(leftName, 5);
    emitRecordingFinished(rightName, 5);
    await mixStarted.promise;
    // Out of the bridge but not yet mixed: still a recording in progress.
    expect(recorder.inProgressCount).toBe(1);

    mixing.resolve(0);
    await ended;
    expect(recorder.inProgressCount).toBe(0);
  });

  it('records both participations of an internal call between two flagged users', async () => {
    const calleeId = await seedUser(db, true);
    const callerId = await seedUser(db, true);
    const targetId = await seedForwardTargetUser(db, calleeId);
    const didId = await seedDid(db, targetId);
    await seedSettings(db, didId);
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: () => Promise.resolve(0),
      log: fakeLogger(),
      now: () => NOW
    });
    const call = buildCall(null);
    call.callerUserId = callerId;
    await cdr.open(call);
    fakeAri.addChannel({ id: callerChannel(call) });
    fakeAri.addChannel({ id: 'callee-channel' });
    const leg = buildLeg({ channelId: 'callee-channel', userId: calleeId });

    // §10.2 "Internal calls": both parties' own flags are evaluated independently — the caller
    // has no routing group of its own, unlike the callee's `onLegUp` OR-resolution.
    await recorder.onCallerUp(call);
    await recorder.onLegUp(call, leg);
    const names = recordCalls().map(body => body.name);

    const callerEnded = recorder.onCallerEnded(call);
    emitRecordingFinished(names[0], 5);
    emitRecordingFinished(names[1], 5);
    await callerEnded;
    const legEnded = recorder.onLegEnded(call, leg);
    emitRecordingFinished(names[2], 5);
    emitRecordingFinished(names[3], 5);
    await legEnded;

    const rows = await db
      .selectFrom('recordings')
      .selectAll()
      .where('callId', '=', call.id)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.userId).sort()).toEqual(
      [callerId, calleeId].sort()
    );
  });

  /** The `snoopId` of every snoop the recorder requested, in order. */
  function snoopIds(): string[] {
    return fakeAri.calls
      .filter(entry => entry.path.endsWith('/snoop'))
      .map(entry => (entry.body as { snoopId: string }).snoopId);
  }

  function hungUp(channelId: string): boolean {
    return fakeAri.calls.some(
      entry =>
        entry.method === 'DELETE' && entry.path === `channels/${channelId}`
    );
  }

  async function seedRecordingUser(): Promise<string> {
    const userId = await seedUser(db, true);
    const targetId = await seedForwardTargetUser(db, userId);
    await seedSettings(db, await seedDid(db, targetId));
    return userId;
  }

  it('records on a snoop only once it has entered Stasis (409 "Channel not in Stasis application")', async () => {
    const userId = await seedRecordingUser();
    const log = fakeLogger();
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: () => Promise.resolve(0),
      log,
      now: () => NOW
    });
    const call = buildCall(null);
    await cdr.open(call);
    fakeAri.addChannel({ id: 'leg-channel' });
    // Asterisk answers the snoop request well before the snoop's `StasisStart`.
    fakeAri.snoopStasisAfterMs = 50;

    await recorder.onLegUp(
      call,
      buildLeg({ channelId: 'leg-channel', userId })
    );

    expect(log.errors).toHaveLength(0);
    expect(recordCalls()).toHaveLength(2);
  });

  it('a snoop gone before it entered Stasis leaves the call unrecorded, its snoop hung up', async () => {
    const userId = await seedRecordingUser();
    const log = fakeLogger();
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: () => Promise.resolve(0),
      log,
      now: () => NOW
    });
    const call = buildCall(null);
    await cdr.open(call);
    fakeAri.addChannel({ id: 'leg-channel' });
    fakeAri.snoopStasisAfterMs = null;

    const started = recorder.onLegUp(
      call,
      buildLeg({ channelId: 'leg-channel', userId })
    );
    await vi.waitFor(() => {
      expect(snoopIds()).toHaveLength(1);
    });
    const [snoopId = ''] = snoopIds();
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: snoopId }
    } as unknown as AriEvent);
    await started;

    expect(log.errors).toHaveLength(1);
    expect(recordCalls()).toHaveLength(0);
    expect(hungUp(snoopId)).toBe(true);
  });

  it('removes the half-recorded raw file of a pair whose second snoop fails (§10.2 "Best effort")', async () => {
    const userId = await seedRecordingUser();
    const mediaDir = await mkdtemp(path.join(tmpdir(), 'zamfono-recording-'));
    onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
    await mkdir(path.join(mediaDir, 'recordings'));
    const log = fakeLogger();
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir,
      mix: () => Promise.resolve(0),
      log,
      now: () => NOW
    });
    const call = buildCall(null);
    await cdr.open(call);
    fakeAri.addChannel({ id: 'leg-channel' });
    fakeAri.snoopStasisAfterMs = null;

    const started = recorder.onLegUp(
      call,
      buildLeg({ channelId: 'leg-channel', userId })
    );
    await vi.waitFor(() => {
      expect(snoopIds()).toHaveLength(1);
    });
    const [leftSnoop = ''] = snoopIds();
    fakeAri.emit({
      type: 'StasisStart',
      timestamp: nowIso(),
      application: 'zamfono',
      args: ['snoop', 'leg-channel'],
      channel: { id: leftSnoop }
    } as unknown as AriEvent);
    await vi.waitFor(() => {
      expect(recordCalls()).toHaveLength(1);
    });
    // Asterisk has written the left half's header by the time the right half fails.
    const [leftName = ''] = recordCalls().map(body => body.name);
    const leftFile = path.join(mediaDir, `${leftName}.wav`);
    await writeFile(leftFile, 'raw');
    await vi.waitFor(() => {
      expect(snoopIds()).toHaveLength(2);
    });
    const [, rightSnoop = ''] = snoopIds();
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: rightSnoop }
    } as unknown as AriEvent);
    await started;
    expect(hungUp(leftSnoop)).toBe(true);
    emitRecordingFinished(leftName, 1);

    await vi.waitFor(async () => {
      await expect(access(leftFile)).rejects.toThrow();
    });
    expect(log.errors).toHaveLength(1);
  });

  it("the caller hanging up first ends and mixes the answering user's participation (§10.2)", async () => {
    const userId = await seedRecordingUser();
    const mixed: string[] = [];
    const recorder = new Recorder({
      ari,
      cache,
      db,
      mediaDir: MEDIA_DIR,
      mix: (_left, _right, outPath) => {
        mixed.push(outPath);
        return Promise.resolve(4);
      },
      log: fakeLogger(),
      now: () => NOW
    });
    const pipeline = new Pipeline(
      testPipelineDeps(ari, db, { cache, cdr, recorder })
    );
    // An inbound trunk call answered by a user who records (`record_calls`): the trunk's own
    // caller is nobody's participation, the answering user's is.
    const call = buildCall(null);
    await cdr.open(call);
    pipeline.registerCall(call);
    fakeAri.addChannel({ id: callerChannel(call) });
    fakeAri.addChannel({ id: 'leg-channel' });
    const leg = buildLeg({ channelId: 'leg-channel', userId });
    trackLeg(pipeline, call, leg);
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, callerChannel(call));
    await ari.bridges.addChannel(bridge.id, leg.channelId);
    call.bridgeId = bridge.id;
    call.status = 'answered';
    call.answeredByUserId = userId;
    await recorder.onLegUp(call, leg);
    const [leftSnoop = '', rightSnoop = ''] = snoopIds();
    const names = recordCalls().map(body => body.name);

    const ended = handleChannelEnded(pipeline, {
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: call.callerChannelId }
    } as unknown as AriEvent);
    // The participation's snoops are stopped by the recorder, whose `RecordingFinished` wait is
    // what Asterisk then answers.
    await vi.waitFor(() => {
      expect(hungUp(leftSnoop) && hungUp(rightSnoop)).toBe(true);
    });
    for (const name of names) {
      emitRecordingFinished(name, 4);
    }
    await ended;

    expect(mixed).toHaveLength(1);
    const rows = await db
      .selectFrom('recordings')
      .selectAll()
      .where('callId', '=', call.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, durationS: 4 });
    expect(hungUp(leg.channelId)).toBe(true);
  });

  describe('with the real ffmpeg mixer', () => {
    it('two header-only raw files: no row, raw files kept, mix failure counted (§10.2 "Best effort")', async () => {
      const userId = await seedUser(db, true);
      const targetId = await seedForwardTargetUser(db, userId);
      const didId = await seedDid(db, targetId);
      await seedSettings(db, didId);
      const mediaDir = await mkdtemp(
        path.join(tmpdir(), 'zamfono-recording-mix-')
      );
      onTestFinished(() => rm(mediaDir, { recursive: true, force: true }));
      await mkdir(path.join(mediaDir, 'recordings'));
      const log = fakeLogger();
      // No `mix` override: this exercises the real `ffmpegMix` default, not a mocked one.
      const recorder = new Recorder({
        ari,
        cache,
        db,
        mediaDir,
        log,
        now: () => NOW
      });
      fakeAri.addChannel({ id: 'leg-channel' });
      const call = buildCall(null);
      await cdr.open(call);
      const leg = buildLeg({ channelId: 'leg-channel', userId });

      await recorder.onLegUp(call, leg);
      const names = recordCalls().map(body => body.name ?? '');
      const files = names.map(name => path.join(mediaDir, `${name}.wav`));
      for (const file of files) {
        makeHeaderOnlyWav(file);
      }
      const ended = recorder.onLegEnded(call, leg);
      for (const name of names) {
        emitRecordingFinished(name, 0);
      }
      await ended;

      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop -- two files, checked one at a time
        await expect(access(file)).resolves.toBeUndefined();
      }
      const rows = await db
        .selectFrom('recordings')
        .selectAll()
        .where('callId', '=', call.id)
        .execute();
      expect(rows).toHaveLength(0);
      expect(log.errors).toHaveLength(1);
      expect(recorder.mixFailureCount).toBe(1);
    });
  });
});
