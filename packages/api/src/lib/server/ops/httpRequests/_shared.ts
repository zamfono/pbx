import * as env from '$app/env/private';
import type { Selectable } from 'kysely';
import { z } from 'zod';

import {
  CALL_PLACEHOLDER_NAMES,
  httpHeaderWire,
  httpRequestFields,
  requestBlockIssues,
  requestTemplates,
  RESERVED_TEMPLATE_NAMES,
  type DB,
  type Db,
  type HttpHeaderInput,
  type HttpRequestInput
} from '@zamfono/shared';

import { keyringFromEnv } from '#lib/server/secretbox.js';

import { CDR_PLACEHOLDER } from '../afterCall.js';
import {
  findForwardTargetOwners,
  type Reference
} from '../forwardTargetOwners.js';
import { targetSpecSchema } from '../forwardTargetSchema.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import {
  blockWire,
  storeBlock,
  storeSecret,
  type BlockColumns,
  type BlockPurposes
} from '../httpRequestBlock.js';
import { assertNoLiveHolder } from '../liveHolder.js';
import { liveRow } from '../rows.js';
import { assertTemplateNames } from '../templateNames.js';
import { timeoutSeconds } from '../timeoutInput.js';

/** An `http_requests` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type HttpRequestRow = Selectable<DB['httpRequests']>;

export const HTTP_REQUEST_PURPOSES: BlockPurposes = {
  headers: 'httpRequests.secretHeadersEnc',
  secret: 'httpRequests.secretEnc'
};

/** How long a request waits for its answer unless told otherwise, as a webhook's delivery. */
export const DEFAULT_TIMEOUT_S = 5;

/** Loads a live HTTP request by id, or throws `OpError(404)`. */
export async function liveHttpRequest(
  db: Db,
  id: string
): Promise<HttpRequestRow> {
  return liveRow(db, 'httpRequests', id, `HTTP request '${id}' not found`);
}

/** Throws 409 when `name` is already used by another live HTTP request (§11.2). */
export async function assertNameAvailable(
  db: Db,
  name: string,
  excludeId?: string
): Promise<void> {
  await assertNoLiveHolder(
    db,
    'httpRequests: name already in use',
    {
      table: 'httpRequests',
      kind: 'httpRequest',
      label: 'name',
      values: { name }
    },
    excludeId
  );
}

// A name is a template's first path segment, so it is one identifier, and none a template
// already reads as something else.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;
const TAKEN_NAMES = new Set([
  ...CALL_PLACEHOLDER_NAMES,
  ...RESERVED_TEMPLATE_NAMES,
  CDR_PLACEHOLDER
]);

/** The request block as a node's write gives it. */
export type RequestInput = HttpRequestInput & {
  headers: HttpHeaderInput[];
  secret?: string | null | undefined;
  secretSet?: boolean | undefined;
};

const requestSchema: z.ZodType<RequestInput> = z
  .strictObject({
    ...httpRequestFields,
    method: httpRequestFields.method.default('GET'),
    headers: httpRequestFields.headers.pipe(z.array(httpHeaderWire)),
    secret: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Shared secret: with one, the request carries X-Zamfono-Signature, the HMAC-SHA256 of its body under it; write-only, read as secretSet; left out keeps the stored one, null removes it.'
      ),
    secretSet: z
      .boolean()
      .optional()
      .describe('Whether a secret is set; set by a read, ignored on a write.')
  })
  .superRefine((request, ctx) => {
    for (const issue of requestBlockIssues(request)) {
      ctx.addIssue({
        code: 'custom',
        path: [issue.path],
        message: issue.message
      });
    }
  });

/** The fields `httpRequests.create` takes and `httpRequests.update` takes each optionally. */
export const httpRequestFieldsOfNode = {
  name: z
    .string()
    .regex(NAME_PATTERN, 'name must be a letter, then letters, digits or _')
    .refine(
      name => !TAKEN_NAMES.has(name),
      'name is a placeholder or a helper of the templates'
    )
    .describe(
      'Unique among HTTP requests, and the name its answer is read under in templates, such as crm in {{crm.data.tier}}: a letter, then letters, digits or _.'
    ),
  request: requestSchema.describe(
    'The request sent while the call waits (see zamfono.help http-requests).'
  ),
  timeoutS: timeoutSeconds.describe(
    'Seconds the answer may take before the request counts as failed; 5 unless given.'
  ),
  target: targetSpecSchema.describe(
    'Where the call goes once the request answered 2xx with JSON, which templates then read under the name.'
  ),
  errorTarget: targetSpecSchema.describe(
    'Where the call goes when the request fails: no 2xx, no JSON, over 64 KiB, a timeout, a refused address or no connection.'
  )
};

/** An HTTP request's wire shape (§10.3), as `toHttpRequestOut` assembles it. */
export const httpRequestOut = z.object({
  id: z.string(),
  name: z.string(),
  request: requestSchema,
  timeoutS: z.number(),
  target: targetSpecSchema,
  errorTarget: targetSpecSchema
});
export type HttpRequestOut = z.infer<typeof httpRequestOut>;

/** A row's request block as a read returns it. */
export function requestWire(row: HttpRequestRow): RequestInput {
  return { ...blockWire(row), secretSet: row.secretEnc !== null };
}

/**
 * The block columns `request` is stored as, a secret header written without its value and a
 * secret left out kept from `before`; 422 for a template reading a name that is no value of a
 * call.
 */
export async function requestColumns(
  db: Db,
  request: RequestInput,
  before?: HttpRequestRow
): Promise<BlockColumns & { secretEnc: Buffer | null }> {
  await assertTemplateNames(db, requestTemplates(request));
  const kr = keyringFromEnv(env);
  return {
    ...storeBlock(kr, HTTP_REQUEST_PURPOSES, request, before),
    secretEnc:
      request.secret === null
        ? null
        : storeSecret(
            kr,
            HTTP_REQUEST_PURPOSES,
            request.secret,
            before?.secretEnc ?? null
          )
  };
}

/** Assembles the wire shape of an HTTP request from its row and its two targets (§10.3). */
export async function toHttpRequestOut(
  db: Db,
  row: HttpRequestRow
): Promise<HttpRequestOut> {
  const [target, errorTarget] = await Promise.all([
    resolveTarget(db, row.targetId),
    resolveTarget(db, row.errorTargetId)
  ]);
  return {
    id: row.id,
    name: row.name,
    request: requestWire(row),
    timeoutS: row.timeoutS,
    target,
    errorTarget
  };
}

/**
 * The blocking references a soft delete of HTTP request `id` must list, or `[]` when free
 * (§5.9): every rule, number, menu, decision or other request whose target names it; its own
 * two targets naming it travel with it.
 */
export async function findHttpRequestReferences(
  db: Db,
  id: string
): Promise<Reference[]> {
  const rows = await db
    .selectFrom('forwardTargets')
    .select('id')
    .where('httpRequestId', '=', id)
    .execute();
  return findForwardTargetOwners(
    db,
    rows.map(row => row.id),
    { httpRequestId: id }
  );
}
