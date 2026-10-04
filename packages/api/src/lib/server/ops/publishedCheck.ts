/**
 * The suites' check that an operation call answers as the operation publishes it (§10.3 OpenAPI,
 * §10.5 MCP tools), applied to every `runOperation` a suite makes (`testEnv.ts`).
 */
import { isDeepStrictEqual } from 'node:util';

import { BinaryResult } from '../binaryResult.js';
import {
  outputMediaTypes,
  problemStatuses,
  publishedOutput
} from './publishedOutput.js';
import { registry } from './registry.js';
import { OpError } from './types.js';

/**
 * Throws unless `output`, the result of operation `name`, is its published `output` as the wire
 * carries it: a file in one of its media types, or JSON its schema parses to the same value, so
 * a field the schema leaves out fails as well as a wrong one.
 */
export function checkPublishedOutput(name: string, output: unknown): void {
  const op = registry.get(name);
  if (!op) {
    return;
  }
  const mediaTypes = outputMediaTypes(op);
  if (mediaTypes) {
    if (
      !(output instanceof BinaryResult) ||
      !mediaTypes.includes(output.contentType)
    ) {
      throw new Error(`${name}: the result is not a file it publishes`);
    }
    return;
  }
  const wire: unknown = JSON.parse(JSON.stringify(output));
  const parsed = publishedOutput(op).safeParse(wire);
  if (!parsed.success) {
    throw new Error(
      `${name}: the result does not match its output: ${parsed.error.message}`
    );
  }
  if (!isDeepStrictEqual(parsed.data, wire)) {
    throw new Error(
      `${name}: the result carries what its output leaves out: ${JSON.stringify(wire)}`
    );
  }
}

/** Throws unless `error`, thrown by operation `name`, is a problem status it publishes. */
export function checkPublishedProblem(name: string, error: unknown): void {
  const op = registry.get(name);
  if (
    op &&
    error instanceof OpError &&
    !problemStatuses(op).includes(error.status)
  ) {
    throw new Error(
      `${name}: answered ${error.status} (${error.title}), which it does not publish`
    );
  }
}
