import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext
} from '@modelcontextprotocol/server';
import pino from 'pino';

import { isRecord, newId } from '@zamfono/shared';

import { BinaryResult } from '../binaryResult.js';
// Side-effect import: fills the registry (§10.3) with every operation a tool call runs.
import '../ops/index.js';

import { runOperation, type RunInput } from '../ops/runner.js';
import { ConfirmationRequired, OpError } from '../ops/types.js';
import { uploadRoute } from '../restRoutes.js';
import {
  CONFIRM_KEY,
  confirmElicitation,
  hasElicitationCapability,
  isAffirmative
} from './confirm.js';
import { callHelp, HELP_TOOL_NAME } from './guide.js';
import { downloadLink, uploadLink } from './links.js';
import { toolErrorResult, toolResult } from './results.js';
import type { McpCall } from './server.js';

// MCP splits a failed `tools/call` in two. A request the server cannot even dispatch — a tool it
// does not have — is a protocol error, a JSON-RPC `-32602`, which `McpServer` answers itself.
// Anything else refused (arguments the tool's input schema refuses, in the SDK's words; RBAC, a
// business rule, a confirmation still owed, as the REST problem) is a tool execution error, a
// result with `isError: true` the model gets to read
// (https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling).
const logger = pino({ name: 'mcp' });
type ToolCallAnswer = CallToolResult | InputRequiredResult;

/** The tool's own value: the operation's output, a download link for a file it returns, or for
 * an upload operation the upload link its file is posted to, which runs it. */
async function runTool(
  call: McpCall,
  name: string,
  args: Record<string, unknown>,
  run: RunInput
): Promise<unknown> {
  if (uploadRoute(name)) {
    return uploadLink(call.deps, call.auth, run, name, args);
  }
  const output = await runOperation(call.deps.db, name, args, run);
  return output instanceof BinaryResult
    ? downloadLink(call.deps, call.auth, name, args)
    : output;
}

/** The capabilities the request declared in its `_meta`; 2.3.1 types the envelope as `{}`. */
function clientCapabilities(
  ctx: ServerContext
): Record<string, unknown> | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  return isRecord(capabilities) ? capabilities : undefined;
}

/** `body`'s value as a tool result, a refusal of its own as a tool execution error, and an
 * unexpected failure as one that leaks no internals: `McpServer` would put the thrown error's own
 * message into the result. */
async function asToolResult(
  name: string,
  body: () => Promise<ToolCallAnswer>
): Promise<ToolCallAnswer> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof OpError) {
      return toolErrorResult(error);
    }
    logger.error({ err: error, tool: name }, 'mcp: tool call failed');
    throw new Error('internal error', { cause: error });
  }
}

/** `zamfono.help` (§10.5), its arguments as `McpServer` validated them. */
export function helpCall(args: { topic?: string }): Promise<ToolCallAnswer> {
  return asToolResult(HELP_TOOL_NAME, () =>
    Promise.resolve(toolResult(callHelp(args)))
  );
}

/**
 * Operation `name`'s tool call (§10.5), its arguments as `McpServer` validated them against the
 * operation's own input: the operation run through the runner with channel `mcp`. A
 * `confirm`-guarded operation called unconfirmed asks through elicitation where the client can
 * answer it, as `input_required`, the client calling again with its answer; otherwise, or once
 * the person declines, it mirrors the REST contract: the `confirmationRequired` problem, answered
 * by a second call carrying `confirm: true`.
 */
export function operationCall(
  call: McpCall,
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: ServerContext
): Promise<ToolCallAnswer> {
  return asToolResult(name, async () => {
    const answer = ctx.mcpReq.inputResponses?.[CONFIRM_KEY];
    // `confirm` travels alongside the operation's own input (§10.5's fallback "second call
    // carries `confirm: true`"), so it must not reach a confirm-guarded operation's own zod
    // schema, which rejects unknown keys.
    const { confirm: confirmArg, ...args } = rawArgs;
    const run: RunInput = {
      actor: call.auth.actor,
      channel: 'mcp',
      clientId: call.auth.clientId,
      clientName: call.auth.clientName,
      requestId: newId(),
      confirm: isAffirmative(answer) || confirmArg === true
    };
    try {
      return toolResult(await runTool(call, name, args, run));
    } catch (error) {
      // A client that already answered, and did not accept, is not asked again (§10.5).
      if (
        error instanceof ConfirmationRequired &&
        answer === undefined &&
        hasElicitationCapability(clientCapabilities(ctx))
      ) {
        return inputRequired({
          inputRequests: {
            [CONFIRM_KEY]: {
              method: 'elicitation/create',
              params: confirmElicitation(error.question)
            }
          }
        });
      }
      throw error;
    }
  });
}
