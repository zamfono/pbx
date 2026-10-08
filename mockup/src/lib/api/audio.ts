/**
 * The demo audio clips, inlined into the build as data URLs: what a voicemail or recording plays.
 * The real API hands out 5-minute signed download links instead (§10.5); the player shows that.
 */
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
