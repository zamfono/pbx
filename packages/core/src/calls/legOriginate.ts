/**
 * A leg's originate in two steps (§7 level `sip`): `POST /channels/create`, which builds the
 * channel and its SIP dialog without sending anything, the dialog's Call-ID joined to the call,
 * then `POST /channels/{id}/dial`, which sends the INVITE. A leg refused at once (a trunk's 403
 * within milliseconds) is gone before a read after a one-step originate could reach it, and its
 * dialog would reach no call; read between the two steps, it always does.
 *
 * The leg is otherwise the originate's: the same endpoint, app arguments and variables, the
 * caller ID as the originate sets it (the channel's caller and connected line, from which
 * chan_pjsip builds `From` and `P-Asserted-Identity`), and the same 30 s dial timeout.
 *
 * Asterisk answers the create before the channel is in the app: it hands the channel to Stasis
 * on a thread of its own (`ari_channel_thread`, res/ari/resource_channels.c), and a dial reaching
 * it first is refused with 409 "Channel not in Stasis application", as a loaded host showed. So
 * the leg is dialled once its `StasisStart` has arrived.
 *
 * A leg that cannot be placed (the create or the dial refused, the channel gone or never in the
 * app) throws `PlacementError`; every caller takes it as a leg that ended at once, so a refusal
 * never escapes the ring or the attempt it belongs to.
 */
import { newId } from '@zamfono/shared';

import type { AriEvent, Channel, OriginateParams } from '../ari/types.js';
import type { Call } from './call.js';
import type { Pipeline } from './pipeline.js';

// ARI's own originate default, which every leg rang under before it was dialled in two steps.
const ORIGINATE_TIMEOUT_S = 30;
// How long a created channel may take to enter the app before it counts as not placed.
export const STASIS_WAIT_MS = 5000;

/** Why a leg could not be placed: its create or dial refused, or its channel gone or never in
 * the app before the dial. */
export class PlacementError extends Error {
  readonly step: 'create' | 'stasis' | 'dial';

  constructor(step: PlacementError['step'], cause?: unknown) {
    super(`leg placement failed at ${step}`, { cause });
    this.name = 'PlacementError';
    this.step = step;
  }
}

type StasisResult = 'entered' | 'gone' | 'timeout';

/** Resolves once `channelId` has entered the app, has gone, or `waitMs` has passed;
 * listening from before the create, since the `StasisStart` may precede the create's answer. */
function stasisEntry(
  ari: Pipeline['deps']['ari'],
  channelId: string,
  waitMs: number
): { entered: Promise<StasisResult>; stop: () => void } {
  const { promise, resolve } = Promise.withResolvers<StasisResult>();
  const onEvent = (event: AriEvent): void => {
    const channel = event.channel as Channel | undefined;
    if (channel?.id !== channelId) {
      return;
    }
    if (event.type === 'StasisStart') {
      resolve('entered');
    } else if (event.type === 'ChannelDestroyed') {
      resolve('gone');
    }
  };
  const timer = setTimeout(() => {
    resolve('timeout');
  }, waitMs);
  timer.unref();
  ari.on('event', onEvent);
  const stop = (): void => {
    clearTimeout(timer);
    ari.off('event', onEvent);
  };
  return {
    entered: promise.then(result => {
      stop();
      return result;
    }),
    stop
  };
}

/** An originate's caller ID as the variables a created channel takes it in. */
function callerIdVariables(
  callerId: string | undefined
): Record<string, string> {
  return callerId === undefined || callerId === ''
    ? {}
    : { 'CALLERID(all)': callerId, 'CONNECTEDLINE(all)': callerId };
}

/**
 * Creates `params`' channel, joins its SIP dialog to `call` (waiting for the join at level `sip`,
 * where it is what the call records), then dials it once it is in the app. A leg that cannot be
 * placed has its created channel hung up and throws `PlacementError`.
 */
export async function originateLeg(
  pipeline: Pipeline,
  call: Call,
  params: OriginateParams
): Promise<Channel> {
  const { ari, cdr } = pipeline.deps;
  const { callerId, timeout, variables, ...placement } = params;
  const channelId = placement.channelId ?? newId();
  const stasis = stasisEntry(
    ari,
    channelId,
    pipeline.deps.legStasisWaitMs ?? STASIS_WAIT_MS
  );
  const channel = await ari.channels
    .create({
      ...placement,
      channelId,
      variables: { ...callerIdVariables(callerId), ...variables }
    })
    .catch((error: unknown) => {
      stasis.stop();
      throw new PlacementError('create', error);
    });
  const joined = cdr.joinLeg?.(call, channel.id) ?? Promise.resolve();
  if (call.log.level === 'sip') {
    await joined;
  }
  if ((await stasis.entered) !== 'entered') {
    await ari.channels.hangup(channel.id).catch(() => undefined);
    throw new PlacementError('stasis');
  }
  try {
    await ari.channels.dial(channel.id, timeout ?? ORIGINATE_TIMEOUT_S);
  } catch (error: unknown) {
    await ari.channels.hangup(channel.id).catch(() => undefined);
    throw new PlacementError('dial', error);
  }
  return channel;
}
