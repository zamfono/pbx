/**
 * What an operation answers with, as the transports publish it (§10.3 OpenAPI, §10.5 MCP tools):
 * its `output` on success, and the problem statuses it can answer with instead.
 */
import { z } from 'zod';

import {
  HTTP_CONFLICT,
  HTTP_FORBIDDEN,
  HTTP_UNPROCESSABLE_CONTENT
} from '@zamfono/shared';

import { binaryMediaTypes } from '../binaryResult.js';
import type { JsonSchema } from './publishedSchema.js';
import type { ErasedOperation } from './registry.js';
import type { ProblemStatus } from './types.js';

const WARNINGS = z
  .array(z.string())
  .optional()
  .describe(
    'What did not complete once the write was stored, such as its propagation to Asterisk; the write stands.'
  );

/**
 * `op`'s `output` as it reaches the wire: a write's object result also carries the `warnings` the
 * runner appends once the write committed (`withWarnings`).
 */
export function publishedOutput(op: ErasedOperation): z.ZodType {
  if (op.readOnly || !(op.output instanceof z.ZodObject)) {
    return op.output;
  }
  return op.output.extend({ warnings: WARNINGS });
}

/** The media types of `op`'s file, or `undefined` when it answers with JSON (`binaryOutput`). */
export function outputMediaTypes(
  op: ErasedOperation
): readonly string[] | undefined {
  return binaryMediaTypes.get(op.output)?.mediaTypes;
}

/** `op`'s JSON result as JSON Schema; only for an operation that answers with JSON. */
export function outputJsonSchema(op: ErasedOperation): JsonSchema {
  return z.toJSONSchema(publishedOutput(op), { io: 'output' });
}

/**
 * Every problem status `op` answers with: input validation's 422, a 403 for a role above `user`,
 * an own scope (§5.3) or `ownerOnly` (§10.3), a 409 for `confirm` (§10.3), and its own
 * `problems`; ascending.
 */
export function problemStatuses(op: ErasedOperation): ProblemStatus[] {
  const statuses = new Set<ProblemStatus>([
    HTTP_UNPROCESSABLE_CONTENT,
    ...(op.problems ?? [])
  ]);
  if (op.minRole !== 'user' || op.scope !== 'any' || op.ownerOnly) {
    statuses.add(HTTP_FORBIDDEN);
  }
  if (op.confirm) {
    statuses.add(HTTP_CONFLICT);
  }
  return [...statuses].sort((left, right) => left - right);
}
