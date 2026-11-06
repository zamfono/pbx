/**
 * Default prompt names and audio-asset media references for menus and voicemail (§10.1 step 6,
 * §10.2 "Voicemail", "Greetings and audio"). Asterisk resolves a `sound:` name's language variant
 * from the channel's own language, so one name covers every tenant language (§9.1).
 */
import {
  PROMPTS_SUBDIR,
  type Language,
  type PromptVoice
} from '@zamfono/shared';

import { ignoreGone } from './ari/failures.js';

/** The fixed prompts played where no tenant audio applies, named as Asterisk's core sounds name
 * them; every language's generated set holds them (§9.1, `calls/promptSet.ts`). */
export const PROMPTS = {
  /** Before recording, when the mailbox has no greeting of its own (§10.2 "Voicemail"). */
  vmIntro: 'vm-intro',
  /** After the recording ends, before the caller is hung up. */
  vmGoodbye: 'vm-goodbye',
  /** Instead of the greeting, when the mailbox already holds its message limit (§11.5). */
  vmMailboxFull: 'vm-mailboxfull',
  /** Before a menu replays its greeting on silence or an unmatched string (§10.1 step 6). */
  pbxInvalid: 'pbx-invalid',
  /** Find-me's accept prompt (§10.1 step 4): "press 1 to accept this call, or 2 to reject it". */
  findMeAccept: 'followme/options',
  /** The failed-call announcement (§9.4 "Cross-trunk failover"): "please try again later". */
  failedCall: 'please-try-call-later'
} as const;

type PromptKey = keyof typeof PROMPTS;

/** Where a generated set keeps the form a number clip takes at the end of a sentence, falling
 * where the same clip inside a sentence rises: the last clip of a number nothing follows. */
export const FINAL_DIGITS_DIR = 'digits-final';

/**
 * A digit string read one digit at a time (§10.2 "Call parking"'s slot), the last digit in its
 * end-of-sentence form.
 */
export function digitsMedia(digits: string): string[] {
  return digits
    .split('')
    .map(
      (digit, index) =>
        `sound:${index === digits.length - 1 ? FINAL_DIGITS_DIR : 'digits'}/${digit}`
    );
}

/** The `sound:` reference for one of the fixed default prompts above. */
export function defaultPrompt(key: PromptKey): string {
  return `sound:${PROMPTS[key]}`;
}

/** The media volume as Asterisk mounts it (§11.6), the root of every `sound:` path handed to it;
 * fixed by the asterisk image, whatever `MEDIA_DIR` says for `core`'s own mount. */
export const ASTERISK_MEDIA_DIR = '/media';
const PROMPTS_DIR = `${ASTERISK_MEDIA_DIR}/${PROMPTS_SUBDIR}`;

/**
 * The `sound:` reference for an `audio_assets` row (§10.2 "Greetings and audio"): Asterisk picks
 * the playable format for the transcoded file by its base name, so the stored extension is
 * dropped. Throws for an id missing from `assets`, which only a dangling FK could produce.
 */
export function assetMedia(
  assets: readonly { id: string; filename: string }[],
  audioId: string
): string {
  const asset = assets.find(row => row.id === audioId);
  if (asset === undefined) {
    throw new Error(`audioAssets: missing row ${audioId}`);
  }
  return `sound:${PROMPTS_DIR}/${asset.filename.replace(/\.[^./]+$/u, '')}`;
}

/** A channel's language as Asterisk resolves sounds in it: the tenant language and its voice,
 * `<language>_<voice>`, the name each generated set ships under (§9.1). Branded, so a bare
 * `settings.language` cannot reach a channel. */
export type SoundLanguage = string & { readonly soundLanguage: unique symbol };

export function soundLanguage(settings: {
  language: Language;
  promptVoice: PromptVoice;
}): SoundLanguage {
  return `${settings.language}_${settings.promptVoice}` as SoundLanguage;
}

/**
 * Sets the channel's language, which is what Asterisk resolves a `sound:` name's language variant
 * from (§9.1's tenant languages). Every prompt this module names is played on a channel that
 * has been through here, so one prompt name serves every tenant.
 */
export async function setChannelLanguage(
  ari: {
    channels: {
      setVar: (id: string, name: string, value: string) => Promise<void>;
    };
  },
  channelId: string,
  language: SoundLanguage
): Promise<void> {
  await ari.channels
    .setVar(channelId, 'CHANNEL(language)', language)
    .catch(ignoreGone);
}

/** The originate `variables` entry that gives a channel the core dials the tenant's language from
 * its creation (§9.1 "every channel's language"), so a prompt played the moment it answers —
 * find-me's accept prompt — already follows it, before the leg has been through any entry. */
export function channelLanguageVariable(
  language: SoundLanguage
): Record<string, string> {
  return { 'CHANNEL(language)': language };
}
