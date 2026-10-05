/**
 * `*95<ext>`/`*96` and their small DTMF menu (§10.2 "Mailbox access": "play new and old messages,
 * delete, and record a greeting"): the permission check, and the main menu — the message counts,
 * then `1` new messages, `2` old messages, `0` record the greeting, `*` the menu again and `#`
 * leave. Walking the messages is `mailboxMessages.ts`'s, the spoken prompts `mailboxPrompts.ts`'s,
 * recording the greeting `mailboxGreeting.ts`'s.
 */
import { ignoreGone } from '../ari/failures.js';
import { SIP_FORBIDDEN, SIP_NOT_FOUND } from '../sipCodes.js';
import { callerChannel, type Call } from './call.js';
import { ownerForExt, ringGroupMemberIds } from './extensionOwner.js';
import { concludeFeature } from './featureCall.js';
import { introMedia } from './mailboxGrammar.js';
import { recordGreeting } from './mailboxGreeting.js';
import type { MenuInput } from './mailboxInput.js';
import {
  browseMessages,
  MAILBOX_KEY_WAIT_MS,
  MAILBOX_MAX_SILENT_PROMPTS,
  sayPrompt,
  sessionInput,
  sessionOver,
  type MailboxSession,
  type MenuEnd
} from './mailboxMessages.js';
import { MAILBOX_KEYS, mainMenuMedia, promptMedia } from './mailboxPrompts.js';
import { loadMessages } from './mailboxStore.js';
import type { Pipeline } from './pipeline.js';
import { release, type Owner } from './release.js';

function folderCounts(session: MailboxSession): {
  newCount: number;
  oldCount: number;
} {
  const newCount = session.messages.filter(
    entry => entry.folder === 'new'
  ).length;
  return { newCount, oldCount: session.messages.length - newCount };
}

/** `0`: the greeting's instructions and tone, the recording, and "your message has been saved". */
async function recordGreetingStep(session: MailboxSession): Promise<void> {
  const { pipeline, call, owner } = session;
  const saved = await recordGreeting(
    pipeline,
    call,
    owner,
    promptMedia('recordGreeting')
  );
  call.log.event({ event: 'mailboxGreeting', saved });
  if (!sessionOver(session)) {
    await sayPrompt(session, saved ? 'saved' : 'sorry');
  }
}

/** A main-menu key: where the menu goes next, `null` to replay the main menu. */
async function mainMenuKey(
  session: MailboxSession,
  digit: string
): Promise<MenuEnd | null> {
  const index = session.messages.findIndex(
    entry =>
      entry.folder === (digit === MAILBOX_KEYS.oldMessages ? 'old' : 'new')
  );
  switch (digit) {
    case MAILBOX_KEYS.newMessages:
    case MAILBOX_KEYS.oldMessages:
      if (index === -1) {
        await sayPrompt(session, 'noMore');
        return null;
      }
      return browseMessages(session, index);
    case MAILBOX_KEYS.recordGreeting:
      await recordGreetingStep(session);
      return null;
    case MAILBOX_KEYS.mainMenu:
      return null;
    case MAILBOX_KEYS.exit:
      return 'exit';
    default:
      await sayPrompt(session, 'sorry');
      return null;
  }
}

/**
 * The main menu until the caller leaves or hangs up: the counts at the start, after `*` and back
 * from the messages, then the menu. Valid keys are never counted against the caller, so any
 * mailbox can be listened through; the menu replayed `MAILBOX_MAX_SILENT_PROMPTS` times without a
 * key ends it.
 */
async function mainMenu(session: MailboxSession): Promise<MenuEnd> {
  let withIntro = true;
  let silent = 0;
  for (;;) {
    const { newCount, oldCount } = folderCounts(session);
    const media = [
      ...(withIntro ? introMedia(session.language, newCount, oldCount) : []),
      ...mainMenuMedia(newCount, oldCount)
    ];
    // eslint-disable-next-line no-await-in-loop -- one key at a time, from the same caller
    const input: MenuInput = await sessionInput(
      session,
      media,
      MAILBOX_KEY_WAIT_MS
    );
    if (input.kind === 'hangup' || sessionOver(session)) {
      return 'hangup';
    }
    withIntro = false;
    if (input.kind === 'timeout') {
      silent += 1;
      if (silent >= MAILBOX_MAX_SILENT_PROMPTS) {
        return 'exit';
      }
      continue;
    }
    silent = 0;
    // §7: the routing trace lists the keys pressed, as it does a menu's path.
    session.call.log.event({ event: 'mailboxKey', key: input.digit });
    // eslint-disable-next-line no-await-in-loop -- see above
    const end = await mainMenuKey(session, input.digit);
    if (end === 'exit' || end === 'hangup') {
      return end;
    }
    // Back from the messages, the counts they may have moved come first.
    withIntro = end === 'mainMenu' || input.digit === MAILBOX_KEYS.mainMenu;
    if (sessionOver(session)) {
      return 'hangup';
    }
  }
}

/** Answered from here on (§11.2 `calls.status`): hanging up is how most callers leave the menu,
 * and the caller's channel ending must not close the call out as a missed one. */
function markAnswered(pipeline: Pipeline, call: Call): void {
  call.status = 'answered';
  call.answeredAt = pipeline.deps.now();
}

/** Runs the menu on the answered feature call and closes it out: "goodbye" when the caller left
 * the menu rather than hanging up. */
async function runMailboxMenu(
  pipeline: Pipeline,
  call: Call,
  owner: Owner
): Promise<void> {
  await pipeline.deps.ari.channels
    .answer(callerChannel(call))
    .catch(ignoreGone);
  markAnswered(pipeline, call);
  const session: MailboxSession = {
    pipeline,
    call,
    owner,
    language: (await pipeline.deps.cache.get()).settings.language,
    messages: await loadMessages(pipeline.deps.db, owner),
    playbacks: 0,
    hungUp: false
  };
  const end = await mainMenu(session);
  if (end === 'exit' && !sessionOver(session)) {
    await sayPrompt(session, 'goodbye');
  }
  // Closes the row once; a caller who hung up has had it closed by their channel's end already.
  await concludeFeature(pipeline, call, 'answered');
}

/** `*96`: the caller's own mailbox (§9.3, §10.2 "Mailbox access"). */
export async function ownVoicemail(
  pipeline: Pipeline,
  call: Call
): Promise<void> {
  if (call.callerUserId === null) {
    await release(pipeline, call, SIP_FORBIDDEN, 'failed');
    return;
  }
  await runMailboxMenu(pipeline, call, { userId: call.callerUserId });
}

/** `*95<ext>`: permission-checked mailbox access — the owner themselves, or a member of the
 * owning ring group, direct or through a user group (§9.3). */
export async function mailboxAccess(
  pipeline: Pipeline,
  call: Call,
  ext: string
): Promise<void> {
  if (call.callerUserId === null) {
    await release(pipeline, call, SIP_FORBIDDEN, 'failed');
    return;
  }
  const snapshot = await pipeline.deps.cache.get();
  const owner = ownerForExt(snapshot, ext);
  if (owner === null) {
    await release(pipeline, call, SIP_NOT_FOUND, 'failed');
    return;
  }
  const allowed =
    'userId' in owner
      ? owner.userId === call.callerUserId
      : ringGroupMemberIds(snapshot, owner.ringGroupId).has(call.callerUserId);
  if (!allowed) {
    await release(pipeline, call, SIP_FORBIDDEN, 'failed');
    return;
  }
  await runMailboxMenu(pipeline, call, owner);
}
