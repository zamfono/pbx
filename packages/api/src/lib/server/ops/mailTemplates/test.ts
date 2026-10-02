import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as env from '$app/env/private';
import { z } from 'zod';

import {
  sendMail,
  type AnyMailRequest,
  type Language
} from '#lib/server/mail/index.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { setUndoable } from '../runner.js';
import { defineOperation } from '../types.js';
import { kindSchema, tenantLanguage } from './_shared.js';

const inputSchema = z.object({ kind: kindSchema }).strict();

type Input = z.infer<typeof inputSchema>;

const SAMPLE_CALLER_NUMBER = '+491234567890';
const SAMPLE_DURATION_S = 90;
const SAMPLE_FROM_VERSION = '1.2.3';
const SAMPLE_TO_VERSION = '1.2.4';
const SAMPLE_BREAKING_VERSION = '2.0.0';

// ponytail: a placeholder file stands in for a real recording — `test` renders the template and
// exercises the relay, not the voicemail pipeline, so the attachment's content is unobserved.
const SAMPLE_ATTACHMENT_TEXT =
  'Sample attachment for mailTemplates.test (§10.2 "Templates").';

/**
 * Writes the placeholder file `mailTemplates.test` attaches for kind `voicemail`, in a fresh
 * per-call directory (`mkdtemp`) rather than a fixed name, since a predictable path in the shared
 * `tmpdir()` lets another local process pre-place a symlink there.
 */
async function sampleAttachmentPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zamfono-mailtest-'));
  const path = join(dir, 'sample.txt');
  await writeFile(path, SAMPLE_ATTACHMENT_TEXT, 'utf8');
  return path;
}

type SampleRequestBuilder = (
  userId: string,
  now: string
) => Promise<AnyMailRequest> | AnyMailRequest;

/** One sample-valued request builder per kind (§10.2), keyed so `sampleRequest` needs no switch to stay exhaustive. */
const SAMPLE_REQUEST_BUILDERS: Record<Input['kind'], SampleRequestBuilder> = {
  voicemail: async (userId, now) => ({
    kind: 'voicemail',
    to: { userId },
    values: {
      callerNumber: SAMPLE_CALLER_NUMBER,
      callerName: 'Sample Caller',
      mailboxName: 'Sample Mailbox',
      receivedAt: now,
      durationS: SAMPLE_DURATION_S
    },
    attachmentPath: await sampleAttachmentPath()
  }),
  missedCall: (userId, now) => ({
    kind: 'missedCall',
    to: { userId },
    values: {
      callerNumber: SAMPLE_CALLER_NUMBER,
      callerName: 'Sample Caller',
      receivedAt: now,
      didLabel: 'Main line'
    }
  }),
  setup: (userId, now) => ({
    kind: 'setup',
    to: { userId },
    values: {
      link: 'https://example.invalid/setup/sample-token',
      linkExpiresAt: now,
      invitedBy: 'Sample Admin'
    }
  }),
  reset: (userId, now) => ({
    kind: 'reset',
    to: { userId },
    values: {
      link: 'https://example.invalid/reset/sample-token',
      linkExpiresAt: now
    }
  }),
  updateFailed: (userId, now) => ({
    kind: 'updateFailed',
    to: { userId },
    values: {
      fromVersion: SAMPLE_FROM_VERSION,
      toVersion: SAMPLE_TO_VERSION,
      reason: 'Sample reason: the backup to the sample target failed.',
      failedAt: now
    }
  }),
  breakingUpdate: (userId, now) => ({
    kind: 'breakingUpdate',
    to: { userId },
    values: {
      currentVersion: SAMPLE_FROM_VERSION,
      version: SAMPLE_BREAKING_VERSION,
      releaseUrl: 'https://example.invalid/releases/sample',
      publishedAt: now
    }
  })
};

/** The sample-valued request `sendMail` renders for `kind` (§10.2). */
async function sampleRequest(
  kind: Input['kind'],
  userId: string,
  now: string
): Promise<AnyMailRequest> {
  return SAMPLE_REQUEST_BUILDERS[kind](userId, now);
}

/**
 * `POST /mailTemplates/{kind}/test` (§10.2 "Templates"): sends the effective template, in the
 * tenant language, to the caller with sample values.
 */
export const test = defineOperation<
  Input,
  { status: 'failed' | 'sent' | 'skipped'; language: Language }
>({
  name: 'mailTemplates.test',
  description: 'Sends a mail template to the caller with sample values',
  input: inputSchema,
  minRole: 'admin',
  pureAction: true,
  entity: (input, output) => ({
    kind: 'mailTemplate',
    id: `${input.kind}:${output.language}`
  }),
  run: async (ctx, input) => {
    const language = await tenantLanguage(ctx.db);
    // A test send is a pure action on no prior state: nothing to revert (§5.8).
    setUndoable(ctx, false);
    const request = await sampleRequest(input.kind, ctx.actor.id, ctx.now);
    try {
      const keyring = keyringFromEnv(env);
      const status = await sendMail(ctx.db, keyring, request);
      return { status, language };
    } finally {
      // Only kind `voicemail` created an attachment dir (via `sampleAttachmentPath`).
      if ('attachmentPath' in request) {
        await rm(dirname(request.attachmentPath), {
          recursive: true,
          force: true
        });
      }
    }
  }
});
