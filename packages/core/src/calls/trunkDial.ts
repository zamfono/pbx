/**
 * One INVITE over a trunk (§9.4 "Hosts", "Caller-ID", "Anonymous calls (CLIR)"): the trunk's dial
 * targets, the originate that carries an attempt's resolved identity, and the reading of how it
 * ended, for every outbound attempt (`externalAttempt.ts`).
 */
import { sipHostUri, trunkSectionName } from '@zamfono/shared';

import type { AriEventOf } from '../ari/events.js';
import type { Snapshot } from '../internal/snapshot.js';
import { channelLanguageVariable } from '../prompts.js';
import type { AttemptFailure } from '../routing/trunk.js';
import { SIP_SERVER_ERROR } from '../sipCodes.js';
import { type Call } from './call.js';
import {
  trunkFromHost,
  type AttemptIdentity,
  type TrunkRow
} from './callerIdentity.js';
import { raiseLogLevel } from './callLogLevel.js';
import { forwardVariables, type ForwardLeg } from './forwardContext.js';
import { diversionTrunk } from './forwardDiversion.js';
import { originateLeg } from './legOriginate.js';
import type { Pipeline } from './pipeline.js';
import type { TrunkLeg } from './provisional.js';
import type { TrunkChannels } from './trunkChannels.js';
import { outboundHosts } from './trunkStatus.js';

const SIP_5XX_LOW = 500;
const SIP_5XX_HIGH = 599;
const SIP_FINAL_LOW = 300;
const SIP_FINAL_HIGH = 699;

/**
 * Q.850 hangup cause → SIP final response, RFC 3398 §7.2.6.1's ISUP-to-SIP mapping table (keyed by
 * cause number), for a `ChannelDestroyed` that carries no SIP response of its own (`endedSipStatus`).
 * A cause RFC 3398 does not list falls back to 500.
 */
const CAUSE_TO_SIP_STATUS: Readonly<Record<number, number>> = {
  1: 404,
  2: 404,
  3: 404,
  17: 486,
  18: 408,
  19: 480,
  20: 480,
  21: 603,
  22: 410,
  27: 502,
  28: 484,
  29: 501,
  31: 480,
  34: 503,
  38: 503,
  41: 503,
  42: 503,
  47: 503,
  55: 403,
  57: 403,
  58: 503,
  65: 488,
  79: 501,
  88: 488,
  102: 504,
  111: 500,
  127: 500
};

/** The SIP status a `ChannelDestroyed` cause stands for; a cause with no mapping reads as 500. */
function causeToSipStatus(cause: number): number {
  return CAUSE_TO_SIP_STATUS[cause] ?? SIP_SERVER_ERROR;
}

/**
 * The final response a trunk attempt's `ChannelDestroyed` stands for (§9.4 "Route fallthrough").
 * Asterisk 22 carries the SIP response chan_pjsip received as the event's `tech_cause`; its Q.850
 * `cause` alone cannot be read back, since chan_pjsip maps 401, 403, 407 and 603 all to 21, "Call
 * rejected". A channel that ended on no SIP response (hung up here, or by a transport failure
 * Asterisk records no code for) falls back to translating the Q.850 cause.
 */
export function endedSipStatus(event: AriEventOf<'ChannelDestroyed'>): number {
  const techCause = event.tech_cause;
  return techCause !== undefined &&
    techCause >= SIP_FINAL_LOW &&
    techCause <= SIP_FINAL_HIGH
    ? techCause
    : causeToSipStatus(event.cause);
}

/**
 * The dial target for one `ip`-trunk host (§9.4 "Hosts"): the trunk's single PJSIP endpoint
 * section with an explicit request URI, which Asterisk originates to in place of the AOR's
 * static contact — chan_pjsip's documented `PJSIP/<exten>@<endpoint>/<uri>` form — so every host
 * is reachable without a PJSIP section per host.
 */
function hostDialTarget(
  trunkId: string,
  host: { host: string; port: number | null }
): string {
  return `${trunkSectionName(trunkId)}/${sipHostUri(host)}`;
}

/**
 * The endpoints one attempt over `trunk` tries in turn (§9.4 "Hosts"): every `outbound` or `both`
 * host of an `ip` trunk in priority order, which the core fails over itself; the trunk's own
 * section alone for a `registration` trunk, whose registrar flow PJSIP resolves.
 */
export function dialTargets(trunk: TrunkRow, snapshot: Snapshot): string[] {
  if (trunk.authMode !== 'ip') {
    return [trunkSectionName(trunk.id)];
  }
  return outboundHosts(snapshot, trunk.id).map(host =>
    hostDialTarget(trunk.id, host)
  );
}

/** Whether a failed `ip`-trunk host attempt tries the next host (§9.4 "Hosts"): a 5xx before alerting, or no provisional response. */
export function retriesNextHost(failure: AttemptFailure): boolean {
  if (failure.kind === 'noResponse') {
    return true;
  }
  return (
    failure.kind === 'final' &&
    !failure.alerted &&
    failure.code >= SIP_5XX_LOW &&
    failure.code <= SIP_5XX_HIGH
  );
}

export type TrunkLegCtx = {
  pipeline: Pipeline;
  call: Call;
  trunkChannels: TrunkChannels;
  trunk: TrunkRow;
  number: string;
  identity: AttemptIdentity;
  /** A leg dialled for a forward target, `external` or `sip`: the hops that led to it, whose
   * context it carries (§9.4 "Forwarded calls"); absent for a user's own dial. */
  forward?: ForwardLeg;
};

/**
 * Originates one INVITE for `number` to `endpoint` (`PJSIP/<number>@<endpoint>`, §9.4 "Flows") with
 * the attempt's resolved caller identity, counted against the trunk's channels (§9.4 "Channels")
 * from here on; the caller counts it off again once the channel ends. The channel takes the
 * caller's `channelId`, under which its leg is tracked already, and `dialling` runs as its
 * INVITE is sent (`legOriginate.ts`). Returns the channel's id and name.
 */
export async function originateTrunkLeg(
  ctx: TrunkLegCtx,
  endpoint: string,
  channelId: string,
  dialling: () => void
): Promise<TrunkLeg> {
  const { pipeline, call, trunkChannels, trunk, number, identity } = ctx;
  const variables: Record<string, string> = {
    'CALLERID(num)': identity.number
  };
  if (identity.withhold) {
    // chan_pjsip builds `From`, `P-Asserted-Identity` and `Privacy` from the channel's connected
    // line, which the originate's caller ID sets. Its presentation restricted, `From` becomes
    // `"Anonymous" <sip:anonymous@anonymous.invalid>`, `SIPFROMDOMAIN` notwithstanding (a `pai`
    // trunk's `from_user` and `from_domain` keep the account identity), `Privacy: id` is added,
    // and the endpoint's `trust_id_outbound` keeps the real number in the asserted identity (§9.4
    // "Anonymous calls (CLIR)", RFC 3325).
    variables['CONNECTEDLINE(pres)'] = 'prohib';
  }
  // §7: the trunk carrying the call's leg counts toward its diagnostics level.
  raiseLogLevel(call.log, trunk, pipeline.deps.now());
  trunkChannels.noteAttemptStarted(trunk.id, channelId);
  try {
    // Read after the attempt is counted, so the language adds no wait ahead of the channel count.
    const snapshot = await pipeline.deps.cache.get();
    const { stackSipHost } = pipeline.deps;
    const fromHost = trunkFromHost(trunk, snapshot, stackSipHost);
    // A `from` trunk's endpoint names the host itself (`from_domain`), it never carrying a
    // withheld call, whose anonymous `From` host a `from_domain` would keep (§9.4 "Caller-ID").
    if (fromHost !== null && trunk.callerIdHeader !== 'from') {
      variables.SIPFROMDOMAIN = fromHost;
    }
    if (ctx.forward !== undefined) {
      // The one place a forwarded leg's `REDIRECTING` data, `Diversion` and custom headers are
      // applied, the `Diversion` under this attempt's trunk's policy (§9.4 "Forwarded calls").
      Object.assign(
        variables,
        forwardVariables(
          ctx.forward,
          diversionTrunk(trunk, snapshot, stackSipHost)
        )
      );
    }
    const channel = await originateLeg(
      pipeline,
      call,
      {
        channelId,
        endpoint: `PJSIP/${number}@${endpoint}`,
        app: 'zamfono',
        appArgs: `leg,${call.id}`,
        callerId: identity.number,
        variables: {
          ...channelLanguageVariable(snapshot.settings.language),
          ...variables
        }
      },
      dialling
    );
    return { id: channel.id, name: channel.name };
  } catch (error: unknown) {
    trunkChannels.noteAttemptEnded(channelId);
    throw error;
  }
}
