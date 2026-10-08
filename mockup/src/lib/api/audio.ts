/**
 * The demo audio clips, files of the build: what a voicemail, a recording or an asset of the audio
 * library plays. The real API hands out 5-minute signed download links (§10.5).
 */
import manifest from '#lib/assets/audio/manifest.json';

const files = import.meta.glob<string>('/src/lib/assets/audio/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default'
});

const byKey = new Map(
  Object.entries(files).map(([path, url]) => [
    path.slice(path.lastIndexOf('/') + 1, -'.mp3'.length),
    url
  ])
);

/** The playable URL of clip `key`, or null when the clip does not exist. */
export function clipUrl(key: string | null | undefined): string | null {
  return key === null || key === undefined ? null : (byKey.get(key) ?? null);
}

/** The waveform of clip `key` (0–1 per bar, from manifest.json), or null when it has none. */
export function clipPeaks(key: string | null | undefined): number[] | null {
  if (key === null || key === undefined) {
    return null;
  }
  const entry = (manifest as Record<string, { peaks?: number[] }>)[key];
  return entry?.peaks ?? null;
}
