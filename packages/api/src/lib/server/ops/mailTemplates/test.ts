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

type SampleRequestBuilder = (userId: string, now: string) => AnyMailRequest;

/** One sample-valued request builder per kind (§10.2), keyed so `sampleRequest` needs no switch to stay exhaustive. */
const SAMPLE_REQUEST_BUILDERS: Record<Input['kind'], SampleRequestBuilder> = {
  // A test mail carries no recording: it renders the template and exercises the relay.
  voicemail: (userId, now) => ({
    kind: 'voicemail',
    to: { userId },
    values: {
      callerNumber: SAMPLE_CALLER_NUMBER,
      callerName: 'Sample Caller',
      mailboxName: 'Sample Mailbox',
      receivedAt: now,
      durationS: SAMPLE_DURATION_S
    }
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
    const request = SAMPLE_REQUEST_BUILDERS[input.kind](ctx.actor.id, ctx.now);
    const status = await sendMail(ctx.db, keyringFromEnv(env), request);
    return { status, language };
  }
});
