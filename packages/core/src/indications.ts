/**
 * The special information tone of §9.4 "Cross-trunk failover": for a tenant's `settings.language`
 * (§11.4) whose prompt set lacks {@link PROMPTS.failedCall} (`prompts.ts`), `conclude.ts` plays
 * this ITU-T E.180 tone, in the `itu` zone every tenant shares, instead of the announcement.
 */

/** The one zone `images/asterisk/conf/indications.conf` defines (spec §9.1, §9.4 "Cross-trunk
 * failover"): ITU-T E.180's special information tone, for every tenant, whatever its
 * `settings.country`. */
const ITU_ZONE = 'itu';

/** The `info` tone's `tone:` media reference in the `itu` zone (§9.4 "Cross-trunk failover"). */
export const SPECIAL_INFORMATION_TONE_MEDIA = `tone:info;tonezone=${ITU_ZONE}`;

// The special information tone's own cadence, `950/330,1400/330,1800/330,0/1000` — three rising
// tones of TONE_SEGMENT_MS each, then TONE_SILENCE_MS of silence — exactly as ITU-T E.180 and
// images/asterisk/conf/indications.conf's `info` line both name it. None of its elements starts
// with `!` (indications.conf's format, see the file's own comment), so it repeats forever once
// started; `SIT_REPEAT_COUNT` is how many cycles §9.4 "Cross-trunk failover" plays before the tone
// is stopped ("three short rising tones, repeated three times").
const TONE_SEGMENT_MS = 330;
const TONE_SEGMENT_COUNT = 3;
const TONE_SILENCE_MS = 1000;
const SIT_CYCLE_MS = TONE_SEGMENT_COUNT * TONE_SEGMENT_MS + TONE_SILENCE_MS;
const SIT_REPEAT_COUNT = 3;

/** How long `conclude.ts` lets the special information tone play before stopping it itself
 * (`calls/playback.ts`'s `playToneAndWait`), since the tone never ends on its own. */
export const SIT_DURATION_MS = SIT_REPEAT_COUNT * SIT_CYCLE_MS;
