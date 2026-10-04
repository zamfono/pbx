/**
 * Default prompt names and audio-asset media references for menus and voicemail (§10.1 step 6,
 * §10.2 "Voicemail", "Greetings and audio"). Asterisk resolves a `sound:` name's language variant
 * from the channel's own language, so one name covers every tenant language (§9.1).
 */
import { PROMPTS_SUBDIR } from '@zamfono/shared';

import { ignoreGone } from './ari/failures.js';

/** Asterisk core-sounds names played where no tenant audio applies. */
export const PROMPTS = {
  /** Before recording, when the mailbox has no greeting of its own (§10.2 "Voicemail"). */
  vmIntro: 'vm-intro',
  /** After the recording ends, before the caller is hung up. */
  vmGoodbye: 'vm-goodbye',
  /** Instead of the greeting, when the mailbox already holds its message limit (§11.5). */
  vmMailboxFull: 'vm-mailboxfull',
  /** Before a menu replays its greeting on silence or an unmatched string (§10.1 step 6). */
  pbxInvalid: 'pbx-invalid',
  /** Find-me's accept prompt (§10.1 step 4), core sounds' "press 1 to accept this call, or 2 to
   * reject it". The German set has no `followme/` prompts, so a `de` tenant hears the English
   * file, as §9.1 has a prompt missing from a community set fall back. */
  findMeAccept: 'followme/options',
  /** The failed-call announcement (§9.4 "Cross-trunk failover"), core sounds' "Please try your call
   * again later". The `en`, `fr` and `it` sets have it; the German, Spanish and Russian sets do
   * not — Russian names its own `pls-try-call-later` — so `conclude.ts` plays the special
   * information tone instead for those three (`indications.ts`), rather than falling back to the
   * English file as an ordinary missing prompt would (§9.1's general fallback rule). */
  failedCall: 'please-try-call-later'
} as const;

type PromptKey = keyof typeof PROMPTS;

/** Tenant languages (§11.4 `language`) whose prompt set actually names {@link PROMPTS.failedCall}
 * (verified against the image, §9.1, `test/integration/prompts.sh`): `en`'s own file and the
 * community `fr` and `it` sets. `de` and `es` ship no file of that name at all, and `ru`'s
 * community set names its own `pls-try-call-later` instead, so all three fall outside this list.
 * `conclude.ts` plays the special information tone (`indications.ts`) for a `language` not here. */
export const LANGUAGES_WITH_FAILED_CALL_PROMPT: readonly string[] = [
  'en',
  'fr',
  'it'
];

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

/**
 * Sets the channel's language, which is what Asterisk resolves a `sound:` name's language variant
 * from (§9.1's six tenant languages). Every prompt this module names is played on a channel that
 * has been through here, so one prompt name serves every tenant.
 */
export async function setChannelLanguage(
  ari: {
    channels: {
      setVar: (id: string, name: string, value: string) => Promise<void>;
    };
  },
  channelId: string,
  language: string
): Promise<void> {
  await ari.channels
    .setVar(channelId, 'CHANNEL(language)', language)
    .catch(ignoreGone);
}

/** The originate `variables` entry that gives a channel the core dials the tenant's language from
 * its creation (§9.1 "every channel's language"), so a prompt played the moment it answers —
 * find-me's accept prompt — already follows it, before the leg has been through any entry. */
export function channelLanguageVariable(
  language: string
): Record<string, string> {
  return { 'CHANNEL(language)': language };
}
