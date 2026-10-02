/**
 * Listening through a mailbox (§10.2 "Mailbox access": "play new and old messages, delete"): a
 * menu session, walking its messages new before old and each folder oldest first, and the
 * per-message keys — previous, repeat, next, delete, back to the main menu. A new message is
 * marked read as soon as it starts playing (`mailboxStore.ts`).
 */
import type { Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { callerChannel, type Call, type Owner } from './call.js';
import { playForDigit, type MenuInput } from './mailboxInput.js';
import {
  MAILBOX_KEYS,
  messageHeaderMedia,
  messageOptionsMedia,
  promptMedia
} from './mailboxPrompts.js';
import {
  deleteMessage,
  markRead,
  VOICEMAIL_DIR,
  type MailboxMessage
} from './mailboxStore.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';

/** How long the menu waits for a key once a prompt has played out. */
export const MAILBOX_KEY_WAIT_MS = 5000;

/** Prompts replayed this many times in a row without a key end the session, the way a caller who
 * put the phone down without hanging up is let go. */
export const MAILBOX_MAX_SILENT_PROMPTS = 3;

/** One menu session: its call, the mailbox, the messages as loaded at the start (deleted ones
 * leave the list), a counter keeping each playback id unique, and whether any wait saw the
 * caller hang up, which ends the session wherever it is. */
export type MailboxSession = {
  pipeline: Pipeline;
  call: Call;
  owner: Owner;
  messages: MailboxMessage[];
  playbacks: number;
  hungUp: boolean;
};

/** Records that a wait saw the caller hang up; nothing ever clears it again. */
function markHungUp(session: MailboxSession): void {
  session.hungUp = true;
}

/** Whether the caller is gone: a wait saw the hangup. The call's own status says nothing here,
 * since the menu marks the call answered the moment it answers (`mailbox.ts`). */
export function sessionOver(session: MailboxSession): boolean {
  return session.hungUp;
}

/** How a stretch of the menu ended: back to the main menu, the caller leaving the menu (by key
 * or by silence), or the caller hanging up. */
export type MenuEnd = 'mainMenu' | 'exit' | 'hangup';

/** Plays `media` as the session's next playback and takes the caller's key (`mailboxInput.ts`). */
export async function sessionInput(
  session: MailboxSession,
  media: string | readonly string[],
  waitMs: number
): Promise<MenuInput> {
  session.playbacks += 1;
  const channelId = callerChannel(session.call);
  const input = await playForDigit(
    session.pipeline.deps.ari,
    channelId,
    media,
    `${channelId}:mailbox:${session.playbacks}`,
    waitMs
  );
  if (input.kind === 'hangup') {
    markHungUp(session);
  }
  return input;
}

/** Plays one fixed prompt to the end, no key taken. */
export async function sayPrompt(
  session: MailboxSession,
  key: Parameters<typeof promptMedia>[0]
): Promise<void> {
  session.playbacks += 1;
  const channelId = callerChannel(session.call);
  const end = await playAndWait(
    session.pipeline.deps.ari,
    channelId,
    promptMedia(key),
    `${channelId}:mailbox:${session.playbacks}`
  );
  if (end === 'hangup') {
    markHungUp(session);
  }
}

function positionInFolder(messages: MailboxMessage[], index: number): number {
  const message = messages[index];
  if (message === undefined) {
    throw new Error(`mailbox: no message at index ${index}`);
  }
  const { folder } = message;
  return messages.slice(0, index + 1).filter(entry => entry.folder === folder)
    .length;
}

/** The session's store dependencies. */
function storeDeps(session: MailboxSession): { ari: AriClient; db: Db } {
  const { ari, db } = session.pipeline.deps;
  return { ari, db };
}

/** "New message 2" and the message itself, as one playback a key interrupts. */
async function playMessage(
  session: MailboxSession,
  index: number
): Promise<MenuInput> {
  const message = session.messages[index];
  if (message === undefined) {
    throw new Error(`mailbox: no message at index ${index}`);
  }
  const base = message.filename.replace(/\.[^./]+$/u, '');
  const input = sessionInput(
    session,
    [
      ...messageHeaderMedia(
        message.folder,
        positionInFolder(session.messages, index)
      ),
      `sound:${VOICEMAIL_DIR}/${base}`
    ],
    0
  );
  await markRead(storeDeps(session), session.owner, message);
  return input;
}

/** The next step a message key leads to: another message to play, the options again, or an end. */
type MessageStep =
  | { kind: 'play'; index: number }
  | { kind: 'options' }
  | { kind: 'end'; end: MenuEnd };

async function messageKey(
  session: MailboxSession,
  index: number,
  digit: string
): Promise<MessageStep> {
  const last = session.messages.length - 1;
  switch (digit) {
    case MAILBOX_KEYS.previous:
    case MAILBOX_KEYS.next: {
      const target = digit === MAILBOX_KEYS.previous ? index - 1 : index + 1;
      if (target >= 0 && target <= last) {
        return { kind: 'play', index: target };
      }
      await sayPrompt(session, 'noMore');
      return { kind: 'options' };
    }
    case MAILBOX_KEYS.repeat:
      return { kind: 'play', index };
    case MAILBOX_KEYS.delete: {
      const message = session.messages[index];
      if (message === undefined) {
        throw new Error(`mailbox: no message at index ${index}`);
      }
      await deleteMessage(storeDeps(session), session.owner, message);
      session.messages = session.messages.filter(
        (_entry, position) => position !== index
      );
      await sayPrompt(session, 'deleted');
      if (index <= session.messages.length - 1) {
        return { kind: 'play', index };
      }
      await sayPrompt(session, 'noMore');
      return { kind: 'end', end: 'mainMenu' };
    }
    case MAILBOX_KEYS.mainMenu:
      return { kind: 'end', end: 'mainMenu' };
    case MAILBOX_KEYS.exit:
      return { kind: 'end', end: 'exit' };
    default:
      await sayPrompt(session, 'sorry');
      return { kind: 'options' };
  }
}

/**
 * Walks the messages from `start` until the caller goes back to the main menu, leaves or hangs
 * up. After each message the options play; a key pressed during a message or its options acts
 * at once. The options replayed `MAILBOX_MAX_SILENT_PROMPTS` times without a key end the menu.
 */
export async function browseMessages(
  session: MailboxSession,
  start: number
): Promise<MenuEnd> {
  let index = start;
  let input = await playMessage(session, index);
  let silentOptions = 0;
  for (;;) {
    if (input.kind === 'hangup' || sessionOver(session)) {
      return 'hangup';
    }
    if (input.kind === 'digit') {
      silentOptions = 0;
      session.call.log.event({ event: 'mailboxKey', key: input.digit });
      // eslint-disable-next-line no-await-in-loop -- one key at a time, from the same caller
      const step = await messageKey(session, index, input.digit);
      if (step.kind === 'end') {
        return step.end;
      }
      if (step.kind === 'play') {
        index = step.index;
        // eslint-disable-next-line no-await-in-loop -- see above
        input = await playMessage(session, index);
        continue;
      }
    } else if (silentOptions >= MAILBOX_MAX_SILENT_PROMPTS) {
      return 'exit';
    }
    const hasNext = index < session.messages.length - 1;
    // eslint-disable-next-line no-await-in-loop -- see above
    input = await sessionInput(
      session,
      messageOptionsMedia(index > 0, hasNext),
      MAILBOX_KEY_WAIT_MS
    );
    if (input.kind === 'timeout') {
      silentOptions += 1;
    }
  }
}
