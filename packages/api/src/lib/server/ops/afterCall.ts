/**
 * A forward target's after-call request on write and read (§10.6 "After-call requests", §10.3
 * "Forward targets"): the HTTP request block, its signing secret and which tokens each recording
 * carries, in `after_call_requests`, a row of the target's own.
 */
import * as env from '$app/env/private';
import { z } from 'zod';

import {
  HTTP_UNPROCESSABLE_CONTENT,
  httpHeaderWire,
  httpRequestFields,
  newId,
  requestBlockIssues,
  requestTemplates,
  WEBHOOK_STATUSES,
  wireHeaders,
  type Db,
  type HttpHeaderInput,
  type HttpRequestInput,
  type WebhookStatus
} from '@zamfono/shared';

import { keyringFromEnv } from '../secretbox.js';
import { setUndoable } from './audit.js';
import {
  blockWire,
  storeBlock,
  storeSecret,
  type BlockPurposes
} from './httpRequestBlock.js';
import { assertTemplateNames } from './templateNames.js';
import { OpError, type Context } from './types.js';

/** What an after-call request's recordings may carry a token for. */
export const RECORDING_TOKEN_SCOPES = ['download', 'delete'] as const;
export type RecordingTokenScope = (typeof RECORDING_TOKEN_SCOPES)[number];

/** The name an after-call request's templates read the call's record under (§10.6). */
export const CDR_PLACEHOLDER = 'cdr';

export const AFTER_CALL_PURPOSES: BlockPurposes = {
  headers: 'afterCallRequests.secretHeadersEnc',
  secret: 'afterCallRequests.secretEnc'
};

/** An after-call request as a write gives it and a read returns it; what only a read sets is
 * ignored on a write, so that a target read can be written back as it is. */
export type AfterCallSpec = HttpRequestInput & {
  headers: HttpHeaderInput[];
  secret?: string | undefined;
  secretSet?: true | undefined;
  recordings: RecordingTokenScope[];
  lastStatus?: WebhookStatus | null | undefined;
  lastDeliveryAt?: string | null | undefined;
  failingSince?: string | null | undefined;
  failedDeliveries?: number | undefined;
  lastError?: string | null | undefined;
  lastErrorAt?: string | null | undefined;
};

const readOnly = <T extends z.ZodType>(schema: T) =>
  schema.optional().describe('Set by a read; ignored on a write.');

export const afterCallSchema: z.ZodType<AfterCallSpec | null> = z
  .strictObject({
    ...httpRequestFields,
    headers: httpRequestFields.headers.pipe(z.array(httpHeaderWire)),
    secret: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Shared secret: the request carries X-Zamfono-Signature, the HMAC-SHA256 of its body under it; write-only, read as secretSet; required unless the target written to has a request already, whose secret is then kept.'
      ),
    secretSet: readOnly(z.literal(true)),
    recordings: z
      .array(z.enum(RECORDING_TOKEN_SCOPES))
      .default([])
      .describe(
        "What each recording of the call carries a link for, valid for an hour: download (downloadUrl), delete (deleteUrl, a DELETE of it removes the recording for good), or both; empty, the recordings' ids alone."
      ),
    lastStatus: readOnly(z.enum(WEBHOOK_STATUSES).nullable()),
    lastDeliveryAt: readOnly(z.string().nullable()),
    failingSince: readOnly(z.string().nullable()),
    failedDeliveries: readOnly(z.number()),
    lastError: readOnly(z.string().nullable()),
    lastErrorAt: readOnly(z.string().nullable())
  })
  .superRefine((request, ctx) => {
    for (const issue of requestBlockIssues(request)) {
      ctx.addIssue({
        code: 'custom',
        path: [issue.path],
        message: issue.message
      });
    }
  })
  .nullable()
  .default(null)
  .describe(
    'An HTTP request sent after every attempt of this target, once the call is over and its recordings are written: without a body, a POST of the call record as JSON; admin-only (see zamfono.help after-call-request); null sends none.'
  )
  .meta({ id: 'AfterCallRequest' });

/** Forward target `forwardTargetId`'s after-call request as a read returns it, `null` without
 * one. */
export async function readAfterCall(
  db: Db,
  forwardTargetId: string
): Promise<AfterCallSpec | null> {
  const row = await db
    .selectFrom('afterCallRequests')
    .selectAll()
    .where('forwardTargetId', '=', forwardTargetId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    ...blockWire(row),
    secretSet: true,
    recordings: RECORDING_TOKEN_SCOPES.filter(scope =>
      scope === 'download'
        ? row.recordingDownload === 1
        : row.recordingDelete === 1
    ),
    lastStatus: row.lastStatus,
    lastDeliveryAt: row.lastDeliveryAt,
    failingSince: row.failingSince,
    failedDeliveries: row.failedDeliveries,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt
  };
}

/** Whether writing `spec` over the stored headers `storedHeadersJson` sets a secret or drops a
 * stored one: a signing secret or a secret header's value given, or a stored secret header left
 * out or made plain. Such a write cannot be undone, since its entry holds no value to restore
 * (§5.8); any other write leaves every stored secret where an undo finds it. */
function writesSecret(spec: AfterCallSpec, storedHeadersJson: string): boolean {
  const keptSecret = new Set(
    spec.headers
      .filter(header => header.secret)
      .map(header => header.name.toLowerCase())
  );
  return (
    spec.secret !== undefined ||
    spec.headers.some(header => header.secret && header.value !== undefined) ||
    wireHeaders(storedHeadersJson).some(
      header => header.secret && !keptSecret.has(header.name.toLowerCase())
    )
  );
}

/**
 * Writes `spec` as forward target `forwardTargetId`'s after-call request, the row the target has
 * updated in place: its id and delivery health stay, and so do its secret and the value of a
 * secret header the write leaves out, so a target read can be written back. A target without one
 * gets a new row, for which a missing secret is 422; a template reading a name that is no value
 * of the call or its record is 422 either way. `null` deletes the target's request. `spec` is
 * rewritten in place to what a read returns, without its secrets. A write that deletes a request
 * or sets or drops one of its secrets cannot be undone (§5.8); any other can.
 */
export async function writeAfterCall(
  ctx: Context,
  forwardTargetId: string,
  spec: AfterCallSpec | null
): Promise<void> {
  const before = await ctx.db
    .selectFrom('afterCallRequests')
    .select(['id', 'headersJson', 'secretHeadersEnc', 'secretEnc'])
    .where('forwardTargetId', '=', forwardTargetId)
    .executeTakeFirst();
  if (spec === null) {
    if (before !== undefined) {
      await ctx.db
        .deleteFrom('afterCallRequests')
        .where('id', '=', before.id)
        .execute();
      setUndoable(ctx, false);
    }
    return;
  }
  await assertTemplateNames(ctx.db, requestTemplates(spec), [CDR_PLACEHOLDER]);
  const kr = keyringFromEnv(env);
  const secretEnc = storeSecret(
    kr,
    AFTER_CALL_PURPOSES,
    spec.secret,
    before?.secretEnc ?? null
  );
  if (secretEnc === null) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'afterCall has no stored secret to keep; give its secret'
    );
  }
  const columns = {
    ...storeBlock(kr, AFTER_CALL_PURPOSES, spec, before),
    secretEnc,
    recordingDownload: spec.recordings.includes('download') ? 1 : 0,
    recordingDelete: spec.recordings.includes('delete') ? 1 : 0
  };
  if (before === undefined) {
    await ctx.db
      .insertInto('afterCallRequests')
      .values({ id: newId(), forwardTargetId, ...columns })
      .execute();
  } else {
    await ctx.db
      .updateTable('afterCallRequests')
      .set(columns)
      .where('id', '=', before.id)
      .execute();
  }
  if (writesSecret(spec, before?.headersJson ?? '[]')) {
    setUndoable(ctx, false);
  }
  // From here on `spec` is the request as a read returns it, in place: the operation answers
  // with the target it was given and records it in its audit entry, and neither may carry the
  // secret or a secret header's value.
  delete spec.secret;
  Object.assign(spec, await readAfterCall(ctx.db, forwardTargetId));
}
