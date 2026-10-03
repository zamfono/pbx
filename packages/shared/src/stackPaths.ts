/**
 * Where `api` and `core` find the stack's `db` and `media` volumes, as compose.yaml mounts them
 * (§6.3): the defaults of `DB_FILE` and `MEDIA_DIR`, which a run outside the stack sets.
 */
export const DEFAULT_DB_FILE = '/data/zamfono.sqlite3';
export const DEFAULT_MEDIA_DIR = '/media';
