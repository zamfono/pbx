import { env } from '$env/dynamic/private';

const DEFAULT_MEDIA_DIR = '/media';

/** The shared media volume root (`MEDIA_DIR`, `images/api/Dockerfile`), read at call time so tests can override it. */
export function mediaDirFromEnv(): string {
  return env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR;
}
