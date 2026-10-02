/**
 * The Target-menu step (§10.1 step 6; §10.2 "Auto-attendant menus"): plays the greeting, collects
 * DTMF against the menu's map with `menuStep`, and applies the resolved forward target,
 * a live extension, or, after `menus.max_attempts`, the menu's fallback. The DTMF collection
 * itself is `menuInput.ts`'s.
 */
import type { Snapshot } from '../internal/snapshot.js';
import { assetMedia, defaultPrompt } from '../prompts.js';
import type { MenuMap } from '../routing/menu.js';
import type { ForwardTarget } from '../routing/targets.js';
import {
  callerChannel,
  findForwardTarget,
  release,
  type Call
} from './call.js';
import { enterTarget } from './inbound.js';
import { collectMenuInput } from './menuInput.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';
import { runTarget } from './runTarget.js';

const RELEASE_CODE_UNAVAILABLE = 480;
const RELEASE_CODE_SERVER_ERROR = 500;

type MenuRow = Snapshot['menus'][number];

/** The DTMF strings `menu_targets` maps for `menu`; extension dialling (§10.1 step 6) is resolved
 * separately, once a string this map does not extend goes unmatched. */
function collectionMap(menu: MenuRow, snapshot: Snapshot): MenuMap {
  return snapshot.menuTargets
    .filter(row => row.menuId === menu.id)
    .map(row => ({ digits: row.digits, targetId: row.targetId }));
}

/** The live user/ring-group extensions (parking slots excluded) `menu` may dial straight through
 * to, when it allows it — empty otherwise (§10.1 step 6). Shared between the collector's
 * still-a-prefix check and the exact match below, so both agree on the same candidate set. */
function liveExtensions(
  menu: MenuRow,
  snapshot: Snapshot
): Snapshot['extensions'] {
  if (menu.allowExtensionDialing !== 1) {
    return [];
  }
  return snapshot.extensions.filter(
    row =>
      row.isParkingSlot !== 1 &&
      (row.userId !== null || row.ringGroupId !== null)
  );
}

/** An unmatched, non-waiting string that exactly names one of `extensions`. */
function matchLiveExtension(
  extensions: Snapshot['extensions'],
  typed: string
): ForwardTarget | null {
  const row = extensions.find(candidate => candidate.ext === typed);
  if (row === undefined) {
    return null;
  }
  if (row.userId !== null) {
    return { id: '', kind: 'user', userId: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { id: '', kind: 'ringGroup', ringGroupId: row.ringGroupId };
  }
  return null;
}

/** Whether the call has already been concluded elsewhere, such as by the caller's own hangup
 * (`legsEnded.ts`); a function boundary keeps TypeScript from narrowing `call.status` across the
 * round's awaits. */
function callEnded(call: Call): boolean {
  return call.status !== null;
}

/** One greeting-and-collect round; replays with the invalid prompt, or recurses into the
 * fallback once the shared `call.menuAttempts` reaches the menu's own `max_attempts`. */
async function attemptMenuRound(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  menu: MenuRow
): Promise<void> {
  call.menuAttempts += 1;
  call.log.event({
    event: 'menuAttempt',
    menuId: menu.id,
    attempt: call.menuAttempts
  });
  const channelId = callerChannel(call);
  const extensions = liveExtensions(menu, snapshot);
  const result = await collectMenuInput(
    pipeline.deps.ari,
    {
      channelId,
      media: assetMedia(snapshot.audioAssets, menu.audioId),
      playbackId: `${channelId}:menu:${menu.id}:${call.menuAttempts}`
    },
    collectionMap(menu, snapshot),
    menu.timeoutS,
    extensions.map(row => row.ext)
  );
  if (result.kind === 'hangup' || callEnded(call)) {
    // The caller left: no target, fallback or replay acts on a channel that is gone, and the
    // caller's own channel ending already closed the call out (`legsEnded.ts`).
    call.log.event({ event: 'menuHangup', menuId: menu.id });
    return;
  }

  // A matched menu option, or an unmatched string that is a live extension, applies its target
  // through Entry directly, without counting a hop (§10.1 step 6, step 7).
  const target: ForwardTarget | null =
    result.kind === 'match'
      ? findForwardTarget(snapshot, result.targetId)
      : matchLiveExtension(extensions, result.typed);
  if (target !== null) {
    call.log.event({
      event: 'menuMatch',
      menuId: menu.id,
      digits: result.typed,
      targetId:
        result.kind === 'match' ? result.targetId : `ext:${result.typed}`
    });
    // A key that resolved to `target` restarts the shared attempts budget: a menu entered this
    // way — including one nested inside another (§10.2 "press 5 for technical assistance") —
    // gets its own full `max_attempts` rather than inheriting what this menu had already spent.
    call.menuAttempts = 0;
    // §10.1 step 7: a menu forwards without a caller.
    await enterTarget(pipeline, call, target, null);
    return;
  }
  if (call.menuAttempts >= menu.maxAttempts) {
    call.log.event({ event: 'menuFallback', menuId: menu.id });
    await runTarget(
      pipeline,
      call,
      findForwardTarget(snapshot, menu.fallbackTargetId),
      null,
      null
    );
    return;
  }
  const invalid = await playAndWait(
    pipeline.deps.ari,
    channelId,
    defaultPrompt('pbxInvalid'),
    `${channelId}:menu:${menu.id}:${call.menuAttempts}:invalid`
  );
  if (invalid === 'hangup' || callEnded(call)) {
    call.log.event({ event: 'menuHangup', menuId: menu.id });
    return;
  }
  await attemptMenuRound(pipeline, call, snapshot, menu);
}

/**
 * §10.1 step 6 "Target menu": plays the greeting, collects DTMF, and applies the resolved target.
 * `call.menuAttempts` is shared across every menu reached without a further keypress in between —
 * a fallback, an OOO or closed target that is itself a menu — so two menus falling back to each
 * other end the call once the shared budget runs out instead of re-entering the same loop
 * forever. A menu reached because a key matched (directly, or through another target's own
 * routing) always starts with its own full budget (§10.2 "press 5 for technical assistance").
 */
export async function playMenu(
  pipeline: Pipeline,
  call: Call,
  menuId: string
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const menu = snapshot.menus.find(row => row.id === menuId);
  if (menu === undefined) {
    await release(pipeline, call, RELEASE_CODE_SERVER_ERROR, 'failed');
    return;
  }
  if (call.menuAttempts >= menu.maxAttempts) {
    call.log.event({ event: 'menuAttemptsExceeded', menuId });
    await release(pipeline, call, RELEASE_CODE_UNAVAILABLE, 'missed');
    return;
  }
  // A greeting played into an unanswered channel never reaches a trunk caller, who keeps
  // hearing the provider's ringback and has no media path to key a choice into (§10.1 step 6).
  await pipeline.deps.ari.channels
    .answer(callerChannel(call))
    .catch(() => undefined);
  await attemptMenuRound(pipeline, call, snapshot, menu);
}
