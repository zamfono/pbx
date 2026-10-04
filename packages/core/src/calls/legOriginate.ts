/**
 * A leg's originate in two steps (§7 level `sip`): `POST /channels/create`, which builds the
 * channel and its SIP dialog without sending anything, the dialog's Call-ID joined to the call,
 * then `POST /channels/{id}/dial`, which sends the INVITE. A leg refused at once (a trunk's 403
 * within milliseconds) is gone before a read after a one-step originate could reach it, and its
 * dialog would reach no call; read between the two steps, it always does.
 *
 * The leg is otherwise the originate's: the same endpoint, app arguments and variables, the
 * caller ID as the originate sets it (the channel's caller and connected line, from which
 * chan_pjsip builds `From` and `P-Asserted-Identity`).
 *
 * The dial sets no timeout of its own: "Timers ... live entirely in the core" (§10.1). The ring a
 * leg belongs to ends it (a user's `ring_timeout_s`, a ring group's per-member or total timeout,
 * a find-me leg's share of its user's), and a trunk leg that alerted rings on until it is
 * answered or refused (§9.4 "Route fallthrough"). ARI's own default for `dial` is none as well
 * (`timeout` 0, `app_control_dial` in res/stasis/control.c); 30 s, `POST /channels`' default,
 * cut every longer ring short while legs still passed it.
 *
 * Asterisk answers the create before the channel is in the app: it hands the channel to Stasis
 * on a thread of its own (`ari_channel_thread`, res/ari/resource_channels.c), and a dial reaching
 * it first is refused with 409 "Channel not in Stasis application", as happens on a loaded host. So
 * the leg is dialled once its `StasisStart` has arrived.
 *
 * The caller picks the channel's id and tracks the leg under it, `placing`, before the create, so
 * every event of the channel finds it tracked. `dialling` runs with the created channel as the dial
 * is sent: from then on the leg rings, and its far end may answer or refuse before the dial's own
 * answer arrives.
 *
 * A leg that cannot be placed (`core` stopping, §3.1 "Independence"; the create or the dial
 * refused, the channel gone or never in the app; the call's caller gone meanwhile) throws `PlacementError`; every caller takes it as a leg that ended at once, so a refusal
 * never escapes the ring or the attempt it belongs to. A refused dial's channel is hung up without
 * waiting for the answer, so the caller has settled the leg before that hangup's
 * `ChannelDestroyed` can arrive.
 */
import { logUnlessGone } from '../ari/failures.js';
import type { Channel, OriginateParams } from '../ari/types.js';
import { waitForStasisEntry } from './ariWaits.js';
import type { Call } from './call.js';
import type { Pipeline } from './pipeline.js';

// `POST /channels/{id}/dial`'s "no timeout": the ring the leg is part of times it out.
const NO_DIAL_TIMEOUT = 0;
// How long a created channel may take to enter the app before it counts as not placed.
export const STASIS_WAIT_MS = 5000;

/** Why a leg could not be placed: its create or dial refused, its channel gone or never in the
 * app before the dial, or the call's caller gone by then. */
export class PlacementError extends Error {
  readonly step: 'stopping' | 'create' | 'stasis' | 'callerGone' | 'dial';

  constructor(step: PlacementError['step'], cause?: unknown) {
    super(`leg placement failed at ${step}`, { cause });
    this.name = 'PlacementError';
    this.step = step;
  }
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
 * Creates `params`' channel under the caller's `channelId`, joins its SIP dialog to `call`
 * (waiting for the join at level `sip`, where it is what the call records), then dials it once it
 * is in the app, running `dialling` first. A leg that cannot be placed has its created channel
 * hung up and throws `PlacementError`.
 */
export async function originateLeg(
  pipeline: Pipeline,
  call: Call,
  params: OriginateParams & { channelId: string },
  dialling: (channel: Channel) => void
): Promise<Channel> {
  // A timer or a step still running for a call already wound down places nothing.
  if (pipeline.stopping) {
    throw new PlacementError('stopping');
  }
  const { ari, cdr } = pipeline.deps;
  const { callerId, variables, ...placement } = params;
  const { channelId } = placement;
  const stasis = waitForStasisEntry(
    ari,
    channelId,
    pipeline.deps.legStasisWaitMs
  );
  const channel = await ari.channels
    .create({
      ...placement,
      variables: { ...callerIdVariables(callerId), ...variables }
    })
    .catch((error: unknown) => {
      stasis.settle('gone');
      throw new PlacementError('create', error);
    });
  const joined = cdr.dialogs.joinLeg(call, channel.id);
  if (call.log.level === 'sip') {
    await joined;
  }
  const entered = (await stasis.promise) === 'entered';
  // The caller hanging up ends every leg of the call (`legsEnded.ts`), this one included while
  // it is still being placed: it is hung up before its INVITE leaves.
  if (!entered || call.callerEnded === true) {
    await ari.channels.hangup(channel.id).catch(
      logUnlessGone(pipeline.deps.logger, 'unplaced leg hangup', {
        callId: call.id
      })
    );
    throw new PlacementError(entered ? 'callerGone' : 'stasis');
  }
  dialling(channel);
  try {
    await ari.channels.dial(channel.id, NO_DIAL_TIMEOUT);
  } catch (error: unknown) {
    ari.channels.hangup(channel.id).catch(
      logUnlessGone(pipeline.deps.logger, 'undialled leg hangup', {
        callId: call.id
      })
    );
    throw new PlacementError('dial', error);
  }
  return channel;
}
