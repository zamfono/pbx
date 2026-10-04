import path from 'node:path';

import { PROMPTS_SUBDIR } from '@zamfono/shared';

/**
 * Where the hold-music classes live on the media volume, relative to its root. §11.6 keeps hold
 * music in `media/prompts/` and §6.3 copies the bundled tracks "into media/prompts/", so each
 * `moh` asset's class directory (§10.2 "Hold music", one class per asset) sits below it, at
 * `prompts/moh/<id>/`, the directory `musiconhold.conf` names.
 */
export const MOH_CLASSES_DIR = `${PROMPTS_SUBDIR}/moh`;

/** The class directory of the `moh` asset `id` under the media volume root `mediaDir`. */
export function mohClassDir(mediaDir: string, id: string): string {
  return path.join(mediaDir, MOH_CLASSES_DIR, id);
}
