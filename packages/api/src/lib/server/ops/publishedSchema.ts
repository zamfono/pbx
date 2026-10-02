/**
 * The JSON Schema an operation publishes as its input (§10.3 OpenAPI, §10.5 MCP tools): its zod
 * `input` exported, plus the `confirm` flag the transports read beside it. REST strips `confirm`
 * from the body and MCP from the tool arguments before the operation's own strict schema sees
 * them, so a confirm-guarded operation's exported schema alone would forbid the very field its
 * confirmation needs (§10.3 "Confirmation", §10.5).
 */
import { z } from 'zod';

import type { ErasedOperation } from './registry.js';

export type JsonSchema = Record<string, unknown>;

const CONFIRM_SCHEMA: JsonSchema = {
  type: 'boolean',
  description:
    '`true` once a human has answered the confirmation question; without it the operation is refused with 409 and the question (§10.3 "Confirmation").'
};

/** `schema` with `exclude`d property names dropped from `properties` and `required`. */
export function withoutFields(
  schema: JsonSchema,
  exclude: ReadonlySet<string>
): JsonSchema {
  const properties = schema.properties as
    Record<string, JsonSchema> | undefined;
  if (exclude.size === 0 || !properties) {
    return schema;
  }
  const filteredProperties = Object.fromEntries(
    Object.entries(properties).filter(([name]) => !exclude.has(name))
  );
  const required = (schema.required as string[] | undefined)?.filter(
    name => !exclude.has(name)
  );
  return {
    ...schema,
    properties: filteredProperties,
    ...(required ? { required } : {})
  };
}

/**
 * `op`'s zod input as JSON Schema, from the input side (`io: 'input'`): a field with a default is
 * optional to send, and only a `.strict()` object forbids unknown keys, as validation does.
 * `unrepresentable: 'any'`: an operation whose input carries bytes (a multipart upload's
 * `Buffer`) has no JSON Schema for that field, and every registered operation is published, so
 * such a field is exported as an unconstrained value.
 */
export function inputJsonSchema(op: ErasedOperation): JsonSchema {
  return z.toJSONSchema(op.input, {
    io: 'input',
    unrepresentable: 'any'
  });
}

/**
 * The input a client sends for `op`: its own fields minus `exclude`d ones (the fields a REST
 * route fills from its path), plus an optional `confirm` for a confirm-guarded operation.
 * Optional, because the first, unconfirmed call is what earns the
 * question. Any other field is as the operation's own schema has it: a `.strict()` one still
 * forbids an unknown key, since validation rejects it (§10.3, e.g. `PATCH /settings`).
 */
export function publishedInputSchema(
  op: ErasedOperation,
  exclude: ReadonlySet<string> = new Set()
): JsonSchema {
  const schema = withoutFields(inputJsonSchema(op), exclude);
  if (!op.confirm) {
    return schema;
  }
  const properties =
    (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
  return { ...schema, properties: { ...properties, confirm: CONFIRM_SCHEMA } };
}
