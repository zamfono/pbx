// §10.2 "Greetings and audio": uploads are WAV or MP3, keyed by the upload's declared MIME type.
// `.get()` returns `string | undefined` for a MIME type outside the five listed below.
const MASTER_EXTENSION_BY_MIME_TYPE = new Map<string, string>([
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/wave', '.wav'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3']
]);

/** The master file's extension for an upload of `mimeType`, or `undefined` for a type §10.2 does not accept. */
export function masterExtensionFor(mimeType: string): string | undefined {
  return MASTER_EXTENSION_BY_MIME_TYPE.get(mimeType.toLowerCase());
}

/** Whether §10.2 accepts an upload of `mimeType` (WAV or MP3), for input validation ahead of `storeAudio`. */
export function isAcceptedUploadType(mimeType: string): boolean {
  return masterExtensionFor(mimeType) !== undefined;
}
