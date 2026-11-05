import { describe, expect, it } from 'vitest';

import { mainMenuMedia, messageOptionsMedia } from './mailboxPrompts.js';

describe('mailbox menu prompts (§10.2 "Mailbox access")', () => {
  it('offers each folder only while it holds messages, and always the greeting and exit', () => {
    expect(mainMenuMedia('en', 0, 3)).toEqual([
      'sound:vm-press',
      'sound:digits/2',
      'sound:vm-for',
      'sound:vm-Old',
      'sound:vm-messages',
      'sound:vm-press',
      'sound:digits/0',
      'sound:vm-rec-unv',
      'sound:vm-helpexit'
    ]);
    expect(mainMenuMedia('en', 0, 0)).toEqual([
      'sound:vm-press',
      'sound:digits/0',
      'sound:vm-rec-unv',
      'sound:vm-helpexit'
    ]);
  });

  it('announces previous and next only where they exist', () => {
    expect(messageOptionsMedia(true, true)).toEqual([
      'sound:vm-prev',
      'sound:vm-repeat',
      'sound:vm-next',
      'sound:vm-delete',
      'sound:vm-starmain'
    ]);
    expect(messageOptionsMedia(true, false)).toEqual([
      'sound:vm-prev',
      'sound:vm-repeat',
      'sound:vm-delete',
      'sound:vm-starmain'
    ]);
  });
});

describe('a generated set’s mailbox menu (§9.1, §10.2 "Mailbox access")', () => {
  it('says each option as one sentence of its own', () => {
    expect(mainMenuMedia('pl', 2, 1)).toEqual([
      'sound:mailbox/menu-new',
      'sound:mailbox/menu-old',
      'sound:mailbox/menu-greeting',
      'sound:vm-helpexit'
    ]);
    expect(mainMenuMedia('pl', 0, 0)).toEqual([
      'sound:mailbox/menu-greeting',
      'sound:vm-helpexit'
    ]);
  });
});
