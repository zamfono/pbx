/** A parsed multipart upload, as the REST layer hands it to the audio operations. */
export type AudioUpload = { filename: string; mimeType: string; data: Buffer };

/** What a stored upload is known as afterward: its `audio_assets` row id and the file on the media volume. */
export type StoredAudio = { id: string; filename: string };
