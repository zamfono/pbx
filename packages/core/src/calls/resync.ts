/**
 * Boot resync (§10.1 "Boot and restart"): the restarted core adopts the channels and bridges
 * Asterisk still holds only for cleanup, never reconstructing live state. Every `calls` row still
 * open is marked `interrupted`; a bridge with several parties keeps its media flowing and is torn
 * down as soon as one party leaves; a parked call, alone in its bridge, has a parker this process
 * never knew and is hung up now; and a voicemail file without its
 * `voicemails` row is deleted. A channel in no bridge that no call of this process holds (a party
 * held out of its conversation, a menu caller, a voicemail depositor) has nothing left to drive it
 * and is hung up.
 */
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { VOICEMAIL_SUBDIR, type Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { AriEvent } from '../ari/events.js';
import { ignoreGone, logFailure } from '../ari/failures.js';
import { asteriskTimeMs } from '../ari/restApi.js';
import type { Logger } from '../ari/types.js';
import { ignoreMissing } from '../fsFailures.js';
import { PARKED_BRIDGE_NAME } from './parkingRingback.js';
import type { Pipeline } from './pipeline.js';

const VOICEMAIL_EXTENSION = '.wav';

type ResyncDeps = {
  db: Db;
  ari: AriClient;
  now: () => string;
  // The pipeline whose calls arrive while the resync runs; a channel of one of its calls, and a
  // bridge holding one, is that call's, not an orphan.
  pipeline: Pipeline;
  log: Logger;
  // When this process began opening its ARI connection, in milliseconds since the epoch. A
  // channel created since enters the Stasis app over that connection, so its `StasisStart`
  // reaches the pipeline: it is a call of this process however far its handling has come.
  connectingSince: number;
};

type AdoptedBridge = { id: string; channels: Set<string> };

/** Marks every `calls` row without an end as `interrupted`, ended now; returns the count. */
async function markOpenCallsInterrupted(deps: ResyncDeps): Promise<number> {
  const result = await deps.db
    .updateTable('calls')
    .set({ status: 'interrupted', endedAt: deps.now() })
    .where('endedAt', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** Hangs up every channel still in `bridge` and destroys it. */
async function tearDown(ari: AriClient, bridge: AdoptedBridge): Promise<void> {
  await Promise.all(
    [...bridge.channels].map(channelId =>
      ari.channels.hangup(channelId).catch(ignoreGone)
    )
  );
  await ari.bridges.destroy(bridge.id).catch(ignoreGone);
}

/** Watches the adopted bridges: the first party to leave takes the rest down. */
function watchBridges(ari: AriClient, bridges: AdoptedBridge[]): void {
  const byChannel = new Map<string, AdoptedBridge>();
  for (const bridge of bridges) {
    for (const channelId of bridge.channels) {
      byChannel.set(channelId, bridge);
    }
  }
  if (byChannel.size === 0) {
    return;
  }
  const onEvent = (ev: AriEvent): void => {
    const leaving =
      ev.type === 'ChannelDestroyed' ||
      ev.type === 'ChannelLeftBridge' ||
      ev.type === 'StasisEnd';
    const channel = ev.channel;
    const bridge =
      channel === undefined ? undefined : byChannel.get(channel.id);
    if (!leaving || channel === undefined || bridge === undefined) {
      return;
    }
    for (const channelId of bridge.channels) {
      byChannel.delete(channelId);
    }
    bridge.channels.delete(channel.id);
    tearDown(ari, bridge).catch(
      logFailure(ari.log, 'adopted bridge teardown', { bridgeId: bridge.id })
    );
    if (byChannel.size === 0) {
      ari.off('event', onEvent);
    }
  };
  ari.on('event', onEvent);
}

type Adopted = { bridged: number; parked: number; unbridged: number };

/**
 * Sorts the bridges Asterisk still holds into watched conversations and parked calls (§10.1 "Boot
 * and restart"). A bridge holding a channel the pipeline already drives belongs to a call that
 * arrived after the restart and is left to that call. The parking registry lives in memory only
 * and ARI's bridge listing carries no parker, so a channel alone in a parked bridge, waiting in
 * the park or for the ring-back, is the parked call whose parker this process never knew. A
 * channel alone in any other bridge is one side of a conversation, such as the one who held the
 * other party (`hold.ts`), and is watched like the rest. A channel in no bridge, created before
 * this process connected and not driven by the pipeline, is hung up.
 */
async function adoptBridges(deps: ResyncDeps): Promise<Adopted> {
  const { ari } = deps;
  const [bridges, channels] = await Promise.all([
    ari.bridges.list(),
    ari.channels.list()
  ]);
  const handled = (channelId: string): boolean =>
    deps.pipeline.tracks(channelId);
  const watched: AdoptedBridge[] = [];
  const parked: AdoptedBridge[] = [];
  for (const bridge of bridges) {
    if (bridge.channels.some(handled)) {
      continue;
    }
    const adopted = { id: bridge.id, channels: new Set(bridge.channels) };
    if (bridge.name === PARKED_BRIDGE_NAME && adopted.channels.size === 1) {
      parked.push(adopted);
    } else {
      watched.push(adopted);
    }
  }
  const bridged = new Set(bridges.flatMap(bridge => bridge.channels));
  const unbridged = channels
    .filter(
      channel =>
        asteriskTimeMs(channel.creationtime) < deps.connectingSince &&
        !bridged.has(channel.id) &&
        !handled(channel.id)
    )
    .map(channel => channel.id);
  await Promise.all([
    ...parked.map(bridge => tearDown(ari, bridge)),
    ...unbridged.map(id => ari.channels.hangup(id).catch(ignoreGone))
  ]);
  watchBridges(ari, watched);
  return {
    bridged: watched.length,
    parked: parked.length,
    unbridged: unbridged.length
  };
}

/** Deletes every `.wav` in the voicemail directory that no `voicemails` row names; returns the count. */
async function deleteOrphanedVoicemailFiles(deps: ResyncDeps): Promise<number> {
  const dir = path.join(deps.pipeline.deps.mediaDir, VOICEMAIL_SUBDIR);
  // A fresh volume has no voicemail directory until the first message is recorded; any other
  // failure to read it is logged, and the files are left for the next boot.
  const names = await readdir(dir)
    .catch(ignoreMissing)
    .catch(logFailure(deps.log, 'voicemail directory read', { dir }));
  if (names === undefined) {
    return 0;
  }
  const rows = await deps.db
    .selectFrom('voicemails')
    .select('filename')
    .execute();
  const known = new Set(rows.map(row => row.filename));
  const orphans = names.filter(
    name => name.endsWith(VOICEMAIL_EXTENSION) && !known.has(name)
  );
  await Promise.all(
    orphans.map(name =>
      unlink(path.join(dir, name)).catch(
        logFailure(deps.log, 'orphaned voicemail removal')
      )
    )
  );
  return orphans.length;
}

/** Runs the boot resync of §10.1 "Boot and restart" once the ARI connection is up. */
export async function resyncOnBoot(deps: ResyncDeps): Promise<void> {
  const interrupted = await markOpenCallsInterrupted(deps);
  const adopted = await adoptBridges(deps);
  const deletedFiles = await deleteOrphanedVoicemailFiles(deps);
  deps.log.info(
    { interrupted, ...adopted, deletedFiles },
    'boot resync: orphaned bridges adopted for cleanup'
  );
}
