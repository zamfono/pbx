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
 */
import type { Channel, OriginateParams } from '../ari/types.js';
import type { Call } from './call.js';
import type { Pipeline } from './pipeline.js';

// ARI's own originate default, which every leg rang under before it was dialled in two steps.
const ORIGINATE_TIMEOUT_S = 30;

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
 * where it is what the call records), then dials it. A dial Asterisk refuses hangs the created
 * channel up and throws, as a refused originate would.
 */
export async function originateLeg(
  pipeline: Pipeline,
  call: Call,
  params: OriginateParams
): Promise<Channel> {
  const { ari, cdr } = pipeline.deps;
  const { callerId, timeout, variables, ...placement } = params;
  const channel = await ari.channels.create({
    ...placement,
    variables: { ...callerIdVariables(callerId), ...variables }
  });
  const joined = cdr.joinLeg?.(call, channel.id) ?? Promise.resolve();
  if (call.log.level === 'sip') {
    await joined;
  }
  try {
    await ari.channels.dial(channel.id, timeout ?? ORIGINATE_TIMEOUT_S);
  } catch (error: unknown) {
    await ari.channels.hangup(channel.id).catch(() => undefined);
    throw error;
  }
  return channel;
}
