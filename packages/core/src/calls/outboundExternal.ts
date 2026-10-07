/**
 * The external-number dialling engine (§9.4 "Outbound routing", "Route fallthrough").
 * `dialExternal` is outbound step 6's own call settlement; `originateExternalLeg` is the same
 * route cursor and waiting dial (`dialAttempt.ts`) for a caller that joins the answered leg into a
 * bridge of its own, `features.ts`'s `addParty` for `*5` to an external number (§10.2 "Three-way
 * calls"). The route match and each route's pre-checks are `routeSelection.ts`'s.
 */
import { userById } from '../internal/snapshot.js';
import { settleAnswered } from './answer.js';
import type { Call } from './call.js';
import { concludeExhausted, concludeFinal } from './conclude.js';
import { dialRoutes, type DialResult } from './dialAttempt.js';
import { openCursor, routeWays } from './externalLegRoutes.js';
import type { ForwardLeg } from './forwardLeg.js';
import type { Pipeline } from './pipeline.js';
import type { TrunkChannels } from './trunkChannels.js';

/** Who dials an external leg: the pipeline and its trunk channel count, and for a leg dialled
 * for a forward target or a blind transfer, the hops that led to it (§9.4 "Forwarded calls"). */
type ExternalDialCtx = {
  pipeline: Pipeline;
  trunkChannels: TrunkChannels;
  forward?: ForwardLeg;
};

/**
 * `number`'s matching routes in priority order (§9.4 "Outbound routing"), skipping an unreachable
 * or capped trunk or one that cannot carry a withheld call, attempting each in turn and falling
 * through per §9.4 "Route fallthrough" until one answers or the list is exhausted. The call is
 * made as `asUser` — route caller lists, presented number and CLIR are all theirs, `null` for a
 * leg dialled on nobody's behalf — which need not be `call.callerUserId`: a transfer is the
 * transferrer's call, a forward the forwarding user's (§9.4 "Outbound routing", §10.1). `call`'s
 * own log and legs record every attempt regardless of who dials it — `dialExternal`'s own
 * outbound step 6, or `addParty`'s `*5` to an external number, which joins the answered leg into
 * the caller's own bridge in place of `dialExternal`'s settlement.
 */
export async function originateExternalLeg(
  ctx: ExternalDialCtx,
  call: Call,
  number: string,
  asUser: string | null,
  clirPerCall: boolean | null
): Promise<DialResult> {
  const { pipeline, trunkChannels } = ctx;
  const snapshot = await pipeline.deps.cache.get();
  return dialRoutes(
    openCursor(
      {
        pipeline,
        trunkChannels,
        call,
        snapshot,
        number,
        callerUser: userById(snapshot, asUser),
        clirPerCall,
        forward: ctx.forward
      },
      routeWays(snapshot, number, asUser)
    )
  );
}

/** Settles `call` on a waiting dial's `result`: bridged with the answered leg, or concluded on its
 * final failure or its exhausted ways (§9.4 "Route fallthrough"). */
export async function settleDial(
  pipeline: Pipeline,
  call: Call,
  result: DialResult
): Promise<void> {
  if (result.kind === 'answered') {
    await settleAnswered(pipeline, call, result.channelId);
    return;
  }
  if (result.kind === 'final') {
    await concludeFinal(pipeline, call, result.failure);
    return;
  }
  await concludeExhausted(pipeline, call, result.lastFailureKind);
}

/**
 * Dials `number` externally (§9.4 "Outbound routing"): the matching routes in priority order,
 * skipping an unreachable or capped trunk or one that cannot carry a withheld call, attempting
 * each in turn and falling through per §9.4 "Route fallthrough" until one answers or exhausted.
 */
export async function dialExternal(
  ctx: ExternalDialCtx,
  call: Call,
  number: string,
  asUser: string | null,
  clirPerCall: boolean | null
): Promise<void> {
  await settleDial(
    ctx.pipeline,
    call,
    await originateExternalLeg(ctx, call, number, asUser, clirPerCall)
  );
}
