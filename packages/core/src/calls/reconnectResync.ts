/**
 * §10.1 "Boot and restart": an ARI connection that reopens under a running core, Asterisk having
 * restarted or only the WebSocket having dropped, may follow channels that went without their
 * `ChannelDestroyed` ever arriving. Each reconnection hands every channel this process knows of
 * and Asterisk no longer holds the `ChannelDestroyed` it missed, so the call, the parking slot,
 * the trunk channel and every wait on it end as they would have; a call none of whose channels is
 * left ends as `interrupted`. Behind an Asterisk that started anew the lamps turn back as at boot.
 */
import type { AriEvent } from '../ari/events.js';
import { logFailure } from '../ari/failures.js';
import { AST_CAUSE_NETWORK_OUT_OF_ORDER } from '../sipCodes.js';
import type { Call } from './call.js';
import { settleStatus } from './missedCall.js';
import type { Pipeline } from './pipeline.js';

/** Every call the pipeline tracks, once each. */
function trackedCalls(pipeline: Pipeline): Set<Call> {
  return new Set([
    ...pipeline.callByChannel.values(),
    ...pipeline.channelless.values()
  ]);
}

/** `call`'s channels still in it: its caller's and its legs' not ended. */
function channelsOf(call: Call): string[] {
  return [
    ...(call.callerChannelId === null ? [] : [call.callerChannelId]),
    ...[...call.legs.values()]
      .filter(leg => leg.state !== 'ended')
      .map(leg => leg.channelId)
  ];
}

/** The `ChannelDestroyed` Asterisk would have sent for `channelId`. */
function destroyed(channelId: string): AriEvent {
  return {
    type: 'ChannelDestroyed',
    timestamp: new Date().toISOString(),
    application: 'zamfono',
    channel: {
      id: channelId,
      name: '',
      state: 'Down',
      caller: { number: '', name: '' },
      connected: { number: '', name: '' },
      dialplan: { context: '', exten: '' },
      creationtime: ''
    },
    cause: AST_CAUSE_NETWORK_OUT_OF_ORDER,
    cause_txt: 'Network out of order'
  };
}

async function reconcile(
  pipeline: Pipeline,
  asteriskRestarted: boolean
): Promise<void> {
  const { ari, presence, trunkState } = pipeline.deps;
  const live = new Set((await ari.channels.list()).map(channel => channel.id));
  const calls = [...trackedCalls(pipeline)];
  const known = new Set([
    ...calls.flatMap(channelsOf),
    ...pipeline.parkedSlotByChannel.keys(),
    ...trunkState.countedChannels
  ]);
  const gone = [...known].filter(id => !live.has(id));
  const ended = calls.filter(call => {
    const channels = channelsOf(call);
    return channels.length > 0 && channels.every(id => !live.has(id));
  });
  await Promise.all(
    ended.map(call => settleStatus(pipeline, call, 'interrupted'))
  );
  for (const channelId of gone) {
    ari.emit('event', destroyed(channelId));
  }
  if (asteriskRestarted) {
    await presence.resyncOnBoot();
  }
  pipeline.deps.logger.info(
    { gone: gone.length, interrupted: ended.length, asteriskRestarted },
    'ARI reconnected: channels gone meanwhile ended'
  );
}

/** Registers the reconciliation on every ARI connection from now on; call it once the boot's own
 * connection is up, which `resyncOnBoot` covers. */
export async function resyncOnReconnect(pipeline: Pipeline): Promise<void> {
  const { ari, logger } = pipeline.deps;
  const startupTime = (): Promise<string | undefined> =>
    ari.asterisk.startupTime().catch((error: unknown) => {
      logger.warn({ err: error }, 'asterisk start time unavailable');
      return undefined;
    });
  let startedAt = await startupTime();
  ari.on('connected', () => {
    startupTime()
      .then(async startedNow => {
        // A start time unreadable on either side counts as a new Asterisk: a lamp it left stale
        // costs more than one reset to what this process shows anyway.
        const restarted = startedNow === undefined || startedNow !== startedAt;
        startedAt = startedNow;
        await reconcile(pipeline, restarted);
      })
      .catch(logFailure(logger, 'reconnect resync'));
  });
}
