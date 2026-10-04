import * as env from '$app/env/private';
import { form } from '$app/server';
import { z } from 'zod';

import { isRecord } from '@zamfono/shared';

import { getDb } from '#lib/server/db.js';
import { OpError } from '#lib/server/ops/types.js';
import { formValue } from '#lib/server/restBody.js';
import { originFromEnv } from '#lib/server/stackAddress.js';
import { runUploadLink } from '#lib/server/uploadLink.js';

/** `link` is the upload link the page was opened at; its token is what authorizes the run. */
const UploadPayloadSchema = z.object({
  link: z.string(),
  upload: z.instanceof(File)
});

/** A submission's outcome, rendered above the form: the file was taken, or why not. */
export type UploadOutcome = { uploaded: true } | { refusal: string };

/** The refusal's own words: a validation failure's issues (such as a type other than WAV or
 *  MP3), else its title. */
function refusalText(error: OpError): string {
  if (!Array.isArray(error.detail)) {
    return error.title;
  }
  return error.detail
    .map(issue => (isRecord(issue) ? String(issue.message) : ''))
    .join('; ');
}

/**
 * The upload page's form (§10.5 "Uploads"): runs the operation link `link` stands for with the
 * picked file, as a `POST` of it to the link does.
 */
export const upload = form(
  UploadPayloadSchema,
  async ({ link, upload: file }): Promise<UploadOutcome> => {
    try {
      await runUploadLink(
        { db: getDb(), jwtSecret: env.JWT_SECRET },
        new URL(link, originFromEnv()),
        async () => ({ upload: await formValue(file) })
      );
      return { uploaded: true };
    } catch (error) {
      if (error instanceof OpError) {
        return { refusal: refusalText(error) };
      }
      throw error;
    }
  }
);
