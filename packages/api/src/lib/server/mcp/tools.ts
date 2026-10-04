// Side-effect import: fills the registry (§10.3) with every operation `tools/list` offers.
import '../ops/index.js';

import { z } from 'zod';

import { outputJsonSchema, outputMediaTypes } from '../ops/publishedOutput.js';
import {
  publishedInputSchema,
  type JsonSchema
} from '../ops/publishedSchema.js';
import { registry, type ErasedOperation } from '../ops/registry.js';
import { UPLOAD_FIELD, uploadRoute } from '../restRoutes.js';
import { HELP_TOOL } from './guide.js';
import { operationLink } from './links.js';

// An MCP `Tool` (the same fields in 2025-11-25 and 2026-07-28); the two hints §10.5 derives from
// the operation are `ToolAnnotations`, so they sit under `annotations`, not on the tool itself.
export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema?: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
};

const LINK_SCHEMA = z.toJSONSchema(operationLink, { io: 'output' });

/**
 * The JSON Schema of `op`'s `structuredContent`: a file or an upload answers with its link
 * (§10.5), anything else with the operation's own result. MCP fixes an output schema to an
 * object, so an operation answering with any other value has none.
 */
function outputSchema(op: ErasedOperation): JsonSchema | undefined {
  if (uploadRoute(op.name) || outputMediaTypes(op)) {
    return LINK_SCHEMA;
  }
  const schema = outputJsonSchema(op);
  return schema.type === 'object' ? schema : undefined;
}

/** Every registered operation plus the always-present help tool, sorted by name (§10.5). */
export function listTools(): ToolDescriptor[] {
  const tools = [...registry.values()].map(
    (op: ErasedOperation): ToolDescriptor => ({
      name: op.name,
      description: op.description,
      // With `confirm` beside a confirm-guarded operation's own fields: the fallback's second
      // call carries it in its input (§10.5), and `toolCall.ts` strips it before validation. An
      // upload operation's file is no tool argument: the call answers with its upload link.
      inputSchema: publishedInputSchema(
        op,
        new Set(uploadRoute(op.name) ? [UPLOAD_FIELD] : [])
      ),
      outputSchema: outputSchema(op),
      annotations: {
        readOnlyHint: Boolean(op.readOnly),
        destructiveHint: Boolean(op.confirm)
      }
    })
  );
  tools.push(HELP_TOOL);
  // Code-point order, not `localeCompare`: collation is locale-dependent, and clients rely on a
  // stable order to hit their prompt cache across deployments (§10.5).
  return tools.sort(
    (left, right) =>
      Number(left.name > right.name) - Number(left.name < right.name)
  );
}
