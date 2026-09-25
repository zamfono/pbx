/**
 * What the mailbox menu says (§10.2 "Mailbox access"), composed from Asterisk's core voicemail
 * prompts, which the image ships for every tenant language (§9.1), so the menu speaks the
 * channel's language without a prompt of Zamfono's own. Every key the menu announces is one the
 * prompt's own words name ("Press 7 to delete this message"), which is why the menu uses the
 * keys of Asterisk's own voicemail. Pure functions: `mailbox.ts` and `mailboxMessages.ts` play
 * the lists they return.
 */

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

function sound(name: string): string {
  return `sound:${name}`;
}

/** A spoken count: "no" for zero, else the number in the channel's language. */
function count(value: number): string {
  return value === 0 ? sound(MAILBOX_PROMPTS.no) : `number:${value}`;
}

function messageNoun(value: number): string {
  return sound(
    value === 1 ? MAILBOX_PROMPTS.message : MAILBOX_PROMPTS.messages
  );
}

function folderWord(folder: Folder): string {
  return sound(
    folder === 'new' ? MAILBOX_PROMPTS.newFolder : MAILBOX_PROMPTS.oldFolder
  );
}

/** "You have 2 new messages and 1 old message." */
export function introMedia(newCount: number, oldCount: number): string[] {
  return [
    sound(MAILBOX_PROMPTS.youHave),
    count(newCount),
    folderWord('new'),
    messageNoun(newCount),
    sound(MAILBOX_PROMPTS.and),
    count(oldCount),
    folderWord('old'),
    messageNoun(oldCount)
  ];
}

/**
 * The main menu: "Press 1 for new messages" and "press 2 for old messages" while the folder
 * holds any, then the greeting ("press 0 — after the tone say your unavailable message and then
 * press the pound key"), then "press star for help or pound to exit".
 */
export function mainMenuMedia(newCount: number, oldCount: number): string[] {
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

/** "New message 2", before the message itself. */
export function messageHeaderMedia(folder: Folder, position: number): string[] {
  return [
    folderWord(folder),
    sound(MAILBOX_PROMPTS.message),
    `number:${position}`
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

/** One fixed prompt by its `MAILBOX_PROMPTS` key. */
export function promptMedia(key: keyof typeof MAILBOX_PROMPTS): string {
  return sound(MAILBOX_PROMPTS[key]);
}
