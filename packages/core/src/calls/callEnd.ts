/**
 * Who ended a call, and how (§7 `events`: the routing trace's `ended` line). The party that hangs
 * up first is the caller or an answered leg whose hangup request Asterisk raises on its own — a
 * BYE, a CANCEL — and the core's own hangups (a release, a REST hangup, the other side of a
 * bridge the first party left) are soft requests, `system`. The line is written once per call,
 * as the first party's channel is destroyed, with the cause Asterisk reports for it.
 */
import type { AriEvent, Channel } from '../ari/types.js';
import type { Call } from './call.js';

type Party = 'caller' | 'callee';

/** The caller's own channel, or an answered leg's; a ringing leg ending is a decline, which the
 * ring race traces itself (`declined`). */
function partyOf(call: Call, channelId: string): Party | null {
  if (channelId === call.callerChannelId) {
    return 'caller';
  }
  return call.legs.get(channelId)?.state === 'up' ? 'callee' : null;
}

/** A `ChannelHangupRequest` on one of `call`'s channels: the first one names who ends the call. */
export function noteHangupRequest(call: Call, ev: AriEvent): void {
  if (call.ending !== undefined) {
    return;
  }
  const channelId = (ev.channel as Channel).id;
  const party = partyOf(call, channelId);
  if (party === null) {
    return;
  }
  call.ending = {
    by: ev.soft === true ? 'system' : party,
    channelId,
    logged: false
  };
}

/** A `ChannelDestroyed` on one of `call`'s channels: the first party's writes the `ended` line,
 * with the channel's Q.850 cause and, for a PJSIP channel, the SIP response that ended it. Runs
 * before the channel's leg is marked ended. */
export function traceChannelEnded(call: Call, ev: AriEvent): void {
  const channelId = (ev.channel as Channel).id;
  const party = partyOf(call, channelId);
  if (party === null) {
    return;
  }
  call.ending ??= { by: party, channelId, logged: false };
  if (call.ending.logged) {
    return;
  }
  call.ending.logged = true;
  call.log.event({
    event: 'ended',
    by: call.ending.by,
    channelId,
    cause: ev.cause,
    causeTxt: ev.cause_txt,
    sipCode: ev.tech_cause
  });
}

/** The core closing `call` out itself (`liveCall.ts`'s `closeCall`: a REST hangup, a transfer
 * handing the conversation on), unless a party's own hangup already wrote the line. */
export function traceSystemEnd(call: Call): void {
  call.ending ??= {
    by: 'system',
    channelId: call.callerChannelId,
    logged: false
  };
  if (call.ending.logged) {
    return;
  }
  call.ending.logged = true;
  call.log.event({ event: 'ended', by: call.ending.by });
}
