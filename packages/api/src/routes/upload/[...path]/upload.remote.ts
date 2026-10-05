import * as env from '$app/env/private';
import { form } from '$app/server';
import { z } from 'zod';

import {
  HTTP_FORBIDDEN,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE_CONTENT
} from '@zamfono/shared';

import type { Dictionary } from '#lib/i18n/index.js';
import { loadBranding } from '#lib/server/auth/branding.js';
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

/** The page's text for a refusal, in the tenant's language: a failing token is a link that has
 *  expired since the page opened, invalid input a file other than WAV or MP3. */
function refusalText(error: OpError, dict: Dictionary['upload']): string {
  switch (error.status) {
    case HTTP_UNAUTHORIZED:
      return dict.expired;
    case HTTP_FORBIDDEN:
      return dict.forbidden;
    case HTTP_UNPROCESSABLE_CONTENT:
      return dict.invalid;
    default:
      return dict.failed;
  }
}

/**
 * The upload page's form (§10.5 "Uploads"): runs the operation link `link` stands for with the
 * picked file, as a `POST` of it to the link does.
 */
export const upload = form(
  UploadPayloadSchema,
  async ({ link, upload: file }): Promise<UploadOutcome> => {
    const db = getDb();
    try {
      await runUploadLink(
        { db, jwtSecret: env.JWT_SECRET },
        new URL(link, originFromEnv()),
        async () => ({ upload: await formValue(file) })
      );
      return { uploaded: true };
    } catch (error) {
      if (error instanceof OpError) {
        const dict = (await loadBranding(db)).dictionary.upload;
        return { refusal: refusalText(error, dict) };
      }
      throw error;
    }
  }
);
