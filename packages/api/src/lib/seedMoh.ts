import { access, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';

import { newId, type Db } from '@zamfono/shared';

import { mohClassDir } from './audio/mohLayout.js';

// §10.2 "Hold music": Debian's `asterisk-moh-opsound-wav` and `asterisk-moh-opsound-g722`
// packages install the five bundled tracks under this directory, the wav package the
// narrowband file and the g722 package the wideband one, both under the same five basenames.
const DEFAULT_MOH_SOURCE_DIR = '/usr/share/asterisk/moh';
export const MOH_TRACK_BASENAMES = [
  'macroform-cold_day',
  'macroform-robot_dity',
  'macroform-the_simplicity',
  'manolo_camp-morning_coffee',
  'reno_project-system'
] as const;
export const MOH_NARROWBAND_EXT = 'wav';
export const MOH_WIDEBAND_EXT = 'g722';

/**
 * Copies one file out of a source directory already confirmed to exist; a missing individual
 * file there means an incomplete install of the two Debian packages (§10.2 "Hold music"), so
 * this fails loudly rather than register an `audio_assets` row with no audio behind it.
 */
async function copyRequiredMohFile(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch (error) {
    throw new Error(
      `seed: could not copy bundled hold-music file ${from}: ${String(error)}`,
      { cause: error }
    );
  }
}

type MohAssetRow = {
  id: string;
  label: string;
  kind: 'moh';
  filename: string;
  uploadedBy: null;
  createdAt: string;
  deletedAt: null;
};

/** Turns a bundled track's basename (`artist-track_name`, always one hyphen) into a label. */
function labelFromBasename(basename: string): string {
  const [artist, track] = basename.split('-');
  if (artist === undefined || track === undefined) {
    throw new Error(`seedMoh: malformed track basename: ${basename}`);
  }
  const titleCase = (segment: string): string =>
    segment
      .split('_')
      .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
      .join(' ');
  return `${titleCase(artist)} — ${titleCase(track)}`;
}

/**
 * One track's files, laid out the way the PJSIP renderer and Task 38's `storeAudio` read them:
 * the wav and g722 variants under the class's own `prompts/moh/<id>/` directory (`render.ts`'s
 * `directory = /media/prompts/moh/<id>/`, one MoH class per asset, so a wideband call gets the
 * g722 file without transcoding), plus the narrowband copy again as the flat `prompts/<id>.wav`
 * playback file (Task 38's `storeAudio` layout). Both stay under `media/prompts/`, where §6.3
 * copies the bundled hold music and §11.6 keeps it.
 */
async function seedMohTrack(
  paths: { sourceDir: string; mediaDir: string; promptsDir: string },
  basename: string,
  now: string
): Promise<MohAssetRow> {
  const id = newId();
  const classDir = mohClassDir(paths.mediaDir, id);
  await mkdir(classDir, { recursive: true });
  const narrowbandSource = path.join(
    paths.sourceDir,
    `${basename}.${MOH_NARROWBAND_EXT}`
  );
  await copyRequiredMohFile(
    narrowbandSource,
    path.join(classDir, `${basename}.${MOH_NARROWBAND_EXT}`)
  );
  await copyRequiredMohFile(
    path.join(paths.sourceDir, `${basename}.${MOH_WIDEBAND_EXT}`),
    path.join(classDir, `${basename}.${MOH_WIDEBAND_EXT}`)
  );
  const promptFilename = `${id}.${MOH_NARROWBAND_EXT}`;
  await copyRequiredMohFile(
    narrowbandSource,
    path.join(paths.promptsDir, promptFilename)
  );
  return {
    id,
    label: labelFromBasename(basename),
    kind: 'moh',
    // Matches the file this function just wrote to `prompts/` (Task 38's `storeAudio` layout),
    // so `deleteAudioFile` and prompt playback resolve the same file the row names.
    filename: promptFilename,
    uploadedBy: null,
    createdAt: now,
    deletedAt: null
  };
}

/** Throws unless `dir` can be reached; the check that names the missing install in one line. */
async function assertSourceDir(dir: string): Promise<void> {
  try {
    await access(dir);
  } catch (error) {
    throw new Error(
      `seed: no hold-music source directory at ${dir}; the image needs asterisk-moh-opsound-wav and asterisk-moh-opsound-g722, or MOH_SOURCE_DIR pointing at the tracks`,
      { cause: error }
    );
  }
}

/**
 * The five bundled opsound tracks (§10.2 "Hold music"), from `sourceDir`. §6.3 counts them
 * among what a first boot leaves behind, so an unreachable source directory or an incomplete
 * set of files fails the seed transaction; the image installs them through
 * `asterisk-moh-opsound-wav` and `-g722`, and `MOH_SOURCE_DIR` names another location.
 */
export async function createMohAssets(
  db: Db,
  env: NodeJS.ProcessEnv,
  mediaDir: string,
  now: string,
  log: Logger
): Promise<void> {
  const sourceDir = env.MOH_SOURCE_DIR ?? DEFAULT_MOH_SOURCE_DIR;
  await assertSourceDir(sourceDir);
  log.info(`seed: seeding bundled hold music from ${sourceDir}`);
  const promptsDir = path.join(mediaDir, 'prompts');
  await mkdir(promptsDir, { recursive: true });
  const rows = await Promise.all(
    MOH_TRACK_BASENAMES.map(basename =>
      seedMohTrack({ sourceDir, mediaDir, promptsDir }, basename, now)
    )
  );
  await db.insertInto('audioAssets').values(rows).execute();
}
