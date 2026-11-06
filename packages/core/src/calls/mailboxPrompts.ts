/**
 * What the mailbox menu says (§10.2 "Mailbox access"): each main-menu option is a sentence of its
 * own ("To listen to your new messages, press 1"), as are a message's options, and every key the
 * menu announces is one the prompt's own words name, which is why the menu uses the keys of
 * Asterisk's own voicemail. The counted phrases, whose grammar differs by language, are
 * `mailboxGrammar.ts`'s. Pure functions: `mailbox.ts` and `mailboxMessages.ts` play the lists they
 * return.
 */
/** The menu's sentences, named as Asterisk's core sounds name them. */
export const MAILBOX_PROMPTS = {
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
  goodbye: 'vm-goodbye'
} as const;

/** The sentences played on their own, not in a list. */
export const MAILBOX_SENTENCE_KEYS = [
  'recordGreeting',
  'deleted',
  'noMore',
  'saved',
  'sorry',
  'goodbye'
] as const satisfies readonly (keyof typeof MAILBOX_PROMPTS)[];
type SentenceKey = (typeof MAILBOX_SENTENCE_KEYS)[number];

/** The main menu's options, one sentence each. */
export const MAIN_MENU_PROMPTS = {
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

/** The main menu: new messages and old messages while the folder holds any, then the greeting,
 * then "press star to hear this menu again, or pound to exit". */
export function mainMenuMedia(newCount: number, oldCount: number): string[] {
  return [
    ...(newCount > 0 ? [sound(MAIN_MENU_PROMPTS.menuNew)] : []),
    ...(oldCount > 0 ? [sound(MAIN_MENU_PROMPTS.menuOld)] : []),
    sound(MAIN_MENU_PROMPTS.menuGreeting),
    sound(MAILBOX_PROMPTS.helpExit)
  ];
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
