/** Audio kinds accepted by an upload (§11.2 `audio_assets.kind`). */
export type AudioKind = 'greeting' | 'moh' | 'vmGreeting' | 'announcement';

/** A parsed multipart upload, as the REST layer hands it to the audio operations (Task 35). */
export type AudioUpload = { filename: string; mimeType: string; data: Buffer };

/** What a stored upload is known as afterward: its `audio_assets` row id and the file on the media volume. */
export type StoredAudio = { id: string; filename: string };

export { storeAudio, deleteAudioFile } from './store.js';
