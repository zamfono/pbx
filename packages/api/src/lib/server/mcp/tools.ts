// Side-effect import: fills the registry (§10.3) with every operation `tools/list` offers.
import '../ops/index.js';

import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  outputJsonSchema,
  outputMediaTypes,
  publishedOutput
} from '../ops/publishedOutput.js';
import { CONFIRM_DESCRIPTION } from '../ops/publishedSchema.js';
import { registry, type ErasedOperation } from '../ops/registry.js';
import { UPLOAD_FIELD, uploadRoute } from '../restRoutes.js';
import { HELP_TOOL } from './guide.js';
import { operationLink } from './links.js';

/** A tool as `McpServer.registerTool` takes it: the SDK publishes the zod schemas as JSON Schema
 * and validates each call's arguments against `inputSchema` before the tool runs. The two hints
 * §10.5 derives from the operation are `ToolAnnotations`, so they sit under `annotations`. */
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema?: z.ZodType;
  annotations: ToolAnnotations;
};

const CONFIRM_FIELD = z.boolean().optional().describe(CONFIRM_DESCRIPTION);

/**
 * The arguments `op`'s tool takes: its own input, with `confirm` beside a confirm-guarded
 * operation's own fields, since the fallback's second call carries it (§10.5) and `toolCall.ts`
 * strips it before the operation runs; an upload operation's file is no tool argument, the call
 * answers with its upload link.
 */
function inputSchema(op: ErasedOperation): z.ZodObject {
  if (!(op.input instanceof z.ZodObject)) {
    throw new Error(`${op.name}: an MCP tool's input must be an object`);
  }
  const own = uploadRoute(op.name)
    ? op.input.omit({ [UPLOAD_FIELD]: true })
    : op.input;
  return op.confirm ? own.extend({ confirm: CONFIRM_FIELD }) : own;
}

/**
 * The schema of `op`'s `structuredContent`: a file or an upload answers with its link (§10.5),
 * anything else with the operation's own result. MCP fixes an output schema to an object, so an
 * operation answering with any other value has none.
 */
function outputSchema(op: ErasedOperation): z.ZodType | undefined {
  if (uploadRoute(op.name) || outputMediaTypes(op)) {
    return operationLink;
  }
  return outputJsonSchema(op).type === 'object'
    ? publishedOutput(op)
    : undefined;
}

/** Every registered operation plus the always-present help tool, sorted by name (§10.5). */
export function listTools(): ToolDefinition[] {
  const tools = [...registry.values()].map(
    (op: ErasedOperation): ToolDefinition => ({
      name: op.name,
      description: op.description,
      inputSchema: inputSchema(op),
      outputSchema: outputSchema(op),
      annotations: {
        readOnlyHint: Boolean(op.readOnly),
        destructiveHint: Boolean(op.confirm)
      }
    })
  );
  tools.push(HELP_TOOL);
  // Code-point order, not `localeCompare`: collation is locale-dependent, and clients rely on a
  // stable order to hit their prompt cache across deployments (§10.5). `McpServer` lists tools in
  // the order they were registered.
  return tools.sort(
    (left, right) =>
      Number(left.name > right.name) - Number(left.name < right.name)
  );
}
