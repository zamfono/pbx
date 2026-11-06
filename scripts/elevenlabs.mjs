// ElevenLabs for scripts/generate-prompts.mjs (spec §9.1): speech, and transcripts to check a
// clip by. Every answer is kept in `.cache/prompts/` (ignored by git) under the request it
// answers, so a rerun pays for nothing it has asked before.
/* eslint-disable camelcase -- the ElevenLabs API's field names */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api.elevenlabs.io/v1';
// One model and settings for every language and voice.
const SPEECH_MODEL = 'eleven_v4';
const TRANSCRIPT_MODEL = 'scribe_v2';
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, speed: 1.0 };
const TOO_MANY_REQUESTS = 429;
const RETRIES = 10;
const RETRY_MS = 2000;

// JSON.parse is necessarily `any`; each caller names the shape it reads.
/* eslint-disable @typescript-eslint/no-unsafe-return */
/** @template T @param {string} text @returns {T} */
export function parseJson(text) {
  return JSON.parse(text);
}
/* eslint-enable @typescript-eslint/no-unsafe-return */

/** Lower case, letters and digits only, without accents or word breaks, to compare a transcript
 * by: "ё" and "е", "Sterntaste" and "Stern-Taste" read alike. @param {string} text */
export function plain(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** @param {string | Buffer} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * @param {{ apiKey: string, cacheDir: string, language: string }} options
 */
export function elevenLabs({ apiKey, cacheDir, language }) {
  /**
   * The answer cached under `key`, asked for with `request` the first time.
   * @param {string} key @param {() => Promise<Response>} request @returns {Promise<string>}
   */
  async function cached(key, request) {
    const file = join(cacheDir, `${key}.json`);
    if (!existsSync(file)) {
      let response = await request();
      // The plan's concurrency is shared by every running generator: wait for a slot.
      for (
        let attempt = 1;
        response.status === TOO_MANY_REQUESTS && attempt <= RETRIES;
        attempt += 1
      ) {
        // eslint-disable-next-line no-await-in-loop -- each retry waits for the one before
        await new Promise(resolve => {
          setTimeout(resolve, attempt * RETRY_MS);
        });
        // eslint-disable-next-line no-await-in-loop -- as above
        response = await request();
      }
      if (!response.ok) {
        throw new Error(
          `ElevenLabs ${response.status}: ${await response.text()}`
        );
      }
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, await response.text());
    }
    return readFileSync(file, 'utf8');
  }

  return {
    /**
     * The text spoken by the voice as base64 16-bit PCM at `rate`, said as if `previous` came
     * before it and `next` after, which shape its intonation without being spoken.
     * @param {string} voiceId @param {{ text: string, previous: string, next: string }} words
     * @param {number} rate @param {number} seed
     * @returns {Promise<{ audio_base64: string }>}
     */
    async speak(voiceId, { text, previous, next }, rate, seed) {
      const url = `${API}/text-to-speech/${voiceId}/with-timestamps?output_format=pcm_${rate}`;
      const body = JSON.stringify({
        text,
        ...(previous === '' ? {} : { previous_text: previous }),
        ...(next === '' ? {} : { next_text: next }),
        model_id: SPEECH_MODEL,
        language_code: language,
        seed,
        voice_settings: VOICE_SETTINGS
      });
      const headers = {
        'xi-api-key': apiKey,
        'content-type': 'application/json'
      };
      return parseJson(
        await cached(sha256(url + body), () =>
          fetch(url, { method: 'POST', headers, body })
        )
      );
    },

    /**
     * What a WAV file says, as speech-to-text hears it.
     * @param {Buffer} wav @returns {Promise<string>}
     */
    async transcribe(wav) {
      const key = sha256(
        Buffer.concat([Buffer.from(`${TRANSCRIPT_MODEL} ${language} `), wav])
      );
      const request = () => {
        const form = new FormData();
        form.append(
          'file',
          new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
          'clip.wav'
        );
        form.append('model_id', TRANSCRIPT_MODEL);
        form.append('language_code', language);
        form.append('tag_audio_events', 'false');
        return fetch(`${API}/speech-to-text`, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey },
          body: form
        });
      };
      /** @type {{ text: string }} */
      const answer = parseJson(await cached(`stt-${key}`, request));
      return answer.text;
    }
  };
}
