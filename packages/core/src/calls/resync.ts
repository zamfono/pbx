/**
 * Boot resync (§10.1 "Boot and restart"): the restarted core adopts the channels and bridges
 * Asterisk still holds only for cleanup, never reconstructing live state. Every `calls` row still
 * open is marked `interrupted`; a bridge with several parties keeps its media flowing and is torn
 * down as soon as one party leaves; a bridge holding a single channel is a parked call whose
 * parker this process never knew and is hung up now; and a voicemail file without its
 * `voicemails` row is deleted. A channel in no bridge is left to its own end: the party behind it
 * hangs up, or the originate that created it times out.
 */
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { AriEvent } from '../ari/events.js';
import { ignoreGone, logFailure } from '../ari/failures.js';
import type { Logger } from '../ari/types.js';
import { ignoreMissing } from '../fsFailures.js';
import { VOICEMAIL_DIR_NAME } from './mailboxStore.js';
import type { Pipeline } from './pipeline.js';

const VOICEMAIL_EXTENSION = '.wav';

type ResyncDeps = {
  db: Db;
  ari: AriClient;
  now: () => string;
  // The pipeline whose calls arrive while the resync runs; a bridge holding a channel of one of
  // its calls is that call's, not an orphan.
  pipeline: Pipeline;
  log: Logger;
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

/** Watches the adopted multi-party bridges: the first party to leave takes the rest down. */
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

type Adopted = { bridged: number; parked: number };

/**
 * Sorts the bridges Asterisk still holds into watched multi-party bridges and parked calls
 * (§10.1 "Boot and restart"). A bridge holding a channel the pipeline already drives belongs to
 * a call that arrived after the restart and is left to that call. The parking registry lives in
 * memory only and ARI's bridge listing carries no parker, so a channel alone in a bridge is the
 * parked call whose parker this process never knew.
 */
async function adoptBridges(deps: ResyncDeps): Promise<Adopted> {
  const { ari } = deps;
  const bridges = await ari.bridges.list();
  const handled = (channelId: string): boolean =>
    deps.pipeline.callByChannel.has(channelId);
  const watched: AdoptedBridge[] = [];
  const parked: AdoptedBridge[] = [];
  for (const bridge of bridges) {
    if (bridge.channels.some(handled)) {
      continue;
    }
    const adopted = { id: bridge.id, channels: new Set(bridge.channels) };
    if (adopted.channels.size > 1) {
      watched.push(adopted);
    } else {
      parked.push(adopted);
    }
  }
  await Promise.all(parked.map(bridge => tearDown(ari, bridge)));
  watchBridges(ari, watched);
  return { bridged: watched.length, parked: parked.length };
}

/** Deletes every `.wav` in the voicemail directory that no `voicemails` row names; returns the count. */
async function deleteOrphanedVoicemailFiles(deps: ResyncDeps): Promise<number> {
  const dir = path.join(deps.pipeline.deps.mediaDir, VOICEMAIL_DIR_NAME);
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
