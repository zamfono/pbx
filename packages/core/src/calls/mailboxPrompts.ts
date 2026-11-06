/**
 * What the mailbox menu says (§10.2 "Mailbox access"). A Debian set's menu is composed from
 * Asterisk's core voicemail prompts, which the image ships for every tenant language (§9.1), so
 * the menu speaks the channel's language without a prompt of Zamfono's own. Every key the menu
 * announces is one the prompt's own words name ("Press 7 to delete this message"), which is why the
 * menu uses the keys of Asterisk's own voicemail. A generated set (§9.1) says each of the main
 * menu's options as one sentence of its own instead of joining words spoken apart. The counted
 * phrases, whose grammar differs by language, are `mailboxGrammar.ts`'s. Pure functions:
 * `mailbox.ts` and `mailboxMessages.ts` play the lists they return.
 */
import type { Language } from '@zamfono/shared';

import { isGeneratedLanguage } from '../prompts.js';

/** The core-sounds names the menu composes its prompts from; the image test checks each ships. */
export const MAILBOX_PROMPTS = {
  youHave: 'vm-youhave',
  no: 'vm-no',
  newFolder: 'vm-INBOX',
  oldFolder: 'vm-Old',
  message: 'vm-message',
  messages: 'vm-messages',
  and: 'vm-and',
  pressOneFor: 'vm-onefor',
  press: 'vm-press',
  for: 'vm-for',
  recordGreeting: 'vm-rec-unv',
  helpExit: 'vm-helpexit',
  previous: 'vm-prev',
  repeat: 'vm-repeat',
  next: 'vm-next',
  delete: 'vm-delete',
  starMain: 'vm-starmain',
  deleted: 'vm-deleted',
  noMore: 'vm-nomore',
  saved: 'vm-msgsaved',
  sorry: 'vm-sorry',
  goodbye: 'vm-goodbye',
  digitTwo: 'digits/2',
  digitZero: 'digits/0'
} as const;

/** The prompts that are whole sentences in every set, which a generated set therefore names as
 * Asterisk's do; the rest of {@link MAILBOX_PROMPTS} only a Debian set's menu joins. */
export const MAILBOX_SENTENCE_KEYS = [
  'recordGreeting',
  'deleted',
  'noMore',
  'saved',
  'sorry',
  'goodbye'
] as const satisfies readonly (keyof typeof MAILBOX_PROMPTS)[];
type SentenceKey = (typeof MAILBOX_SENTENCE_KEYS)[number];

/** A generated set's main-menu options, one sentence each ("To hear your new messages, press 1"). */
export const GENERATED_MAILBOX_PROMPTS = {
  menuNew: 'mailbox/menu-new',
  menuOld: 'mailbox/menu-old',
  menuGreeting: 'mailbox/menu-greeting'
} as const;

/** The menu's keys (§10.2 "Mailbox access"): the main menu's and a message's own. */
export const MAILBOX_KEYS = {
  newMessages: '1',
  oldMessages: '2',
  recordGreeting: '0',
  previous: '4',
  repeat: '5',
  next: '6',
  delete: '7',
  mainMenu: '*',
  exit: '#'
} as const;

export type Folder = 'new' | 'old';

export function sound(name: string): string {
  return `sound:${name}`;
}

export function folderWord(folder: Folder): string {
  return sound(
    folder === 'new' ? MAILBOX_PROMPTS.newFolder : MAILBOX_PROMPTS.oldFolder
  );
}

/**
 * The main menu: "Press 1 for new messages" and "press 2 for old messages" while the folder
 * holds any, then the greeting ("press 0 — after the tone say your unavailable message and then
 * press the pound key"), then "press star for help or pound to exit".
 */
export function mainMenuMedia(
  language: Language,
  newCount: number,
  oldCount: number
): string[] {
  if (isGeneratedLanguage(language)) {
    return [
      ...(newCount > 0 ? [sound(GENERATED_MAILBOX_PROMPTS.menuNew)] : []),
      ...(oldCount > 0 ? [sound(GENERATED_MAILBOX_PROMPTS.menuOld)] : []),
      sound(GENERATED_MAILBOX_PROMPTS.menuGreeting),
      sound(MAILBOX_PROMPTS.helpExit)
    ];
  }
  const media: string[] = [];
  if (newCount > 0) {
    media.push(
      sound(MAILBOX_PROMPTS.pressOneFor),
      folderWord('new'),
      sound(MAILBOX_PROMPTS.messages)
    );
  }
  if (oldCount > 0) {
    media.push(
      sound(MAILBOX_PROMPTS.press),
      sound(MAILBOX_PROMPTS.digitTwo),
      sound(MAILBOX_PROMPTS.for),
      folderWord('old'),
      sound(MAILBOX_PROMPTS.messages)
    );
  }
  media.push(
    sound(MAILBOX_PROMPTS.press),
    sound(MAILBOX_PROMPTS.digitZero),
    sound(MAILBOX_PROMPTS.recordGreeting),
    sound(MAILBOX_PROMPTS.helpExit)
  );
  return media;
}

/** After a message: previous (when there is one), repeat, next (when there is one), delete, and
 * back to the main menu. */
export function messageOptionsMedia(
  hasPrevious: boolean,
  hasNext: boolean
): string[] {
  return [
    ...(hasPrevious ? [sound(MAILBOX_PROMPTS.previous)] : []),
    sound(MAILBOX_PROMPTS.repeat),
    ...(hasNext ? [sound(MAILBOX_PROMPTS.next)] : []),
    sound(MAILBOX_PROMPTS.delete),
    sound(MAILBOX_PROMPTS.starMain)
  ];
}

/** One fixed sentence by its `MAILBOX_PROMPTS` key. */
export function promptMedia(key: SentenceKey): string {
  return sound(MAILBOX_PROMPTS[key]);
}
