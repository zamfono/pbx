import { newId } from '@zamfono/shared';

import type { Authenticated } from '../auth/bearer.js';
import { registry } from '../ops/registry.js';
import { runOperation, type RunInput } from '../ops/runner.js';
import { ConfirmationRequired, OpError } from '../ops/types.js';
import type { McpDeps } from './auth.js';
import { CONFIRM_KEY, confirmElicitation, isAffirmative } from './confirm.js';
import type { Era } from './era.js';
import { callHelp, HELP_TOOL_NAME } from './guide.js';
import {
  asRecord,
  JSONRPC_INVALID_PARAMS,
  jsonRpcError,
  jsonRpcResult,
  type IncomingMessage
} from './jsonRpc.js';
import { legacyElicitationResponse } from './legacyElicitation.js';
import { inputRequiredResult, toolErrorResult, toolResult } from './results.js';

// MCP splits a failed `tools/call` in two. A request the server cannot even dispatch — no tool
// name, arguments that are not an object, a tool it does not have — is a protocol error, answered
// as a JSON-RPC `-32602`. Anything the tool itself refuses (validation, RBAC, a business rule, a
// confirmation still owed) is a tool execution error, a result with `isError: true` the model gets
// to read (https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling).

/** The call's arguments, or `null` when `arguments` is present but not a JSON object. */
function toolArguments(
  params: Record<string, unknown>
): Record<string, unknown> | null {
  if (params.arguments === undefined) {
    return {};
  }
  const args = asRecord(params.arguments);
  return args && !Array.isArray(args) ? args : null;
}

function helpResult(legacy: boolean, args: Record<string, unknown>): object {
  try {
    return toolResult(legacy, callHelp(args));
  } catch (error) {
    if (error instanceof OpError) {
      return toolErrorResult(legacy, error);
    }
    throw error;
  }
}

/**
 * `tools/call` (§10.5): the help tool, or an operation run through the runner with channel `mcp`.
 * A `confirm`-guarded operation called unconfirmed asks through elicitation where the client can
 * answer it — inline as `input_required` (2026-07-28) or as a server-initiated request on a
 * legacy session — and otherwise, or once the person declines, mirrors the REST contract: the
 * `confirmationRequired` problem, answered by a second call carrying `confirm: true`.
 */
export async function handleToolsCall(
  deps: McpDeps,
  auth: Authenticated,
  msg: IncomingMessage,
  era: Era
): Promise<Response> {
  const name = msg.params.name;
  const rawArgs = toolArguments(msg.params);
  if (typeof name !== 'string' || !rawArgs) {
    return jsonRpcError(
      msg.id,
      JSONRPC_INVALID_PARAMS,
      'tools/call needs a tool name and object arguments'
    );
  }
  if (name === HELP_TOOL_NAME) {
    return jsonRpcResult(msg.id, helpResult(era.legacy, rawArgs));
  }
  const op = registry.get(name);
  if (!op) {
    return jsonRpcError(
      msg.id,
      JSONRPC_INVALID_PARAMS,
      `Unknown tool: ${name}`
    );
  }
  // `confirm` travels alongside the operation's own input (§10.5's fallback "second call carries
  // `confirm: true`"), so it must not reach a confirm-guarded operation's own zod schema, which
  // rejects unknown keys; an operation without a `confirm` guard keeps its arguments untouched.
  const { confirm: confirmArg, ...argsWithoutConfirm } = rawArgs;
  const args = op.confirm ? argsWithoutConfirm : rawArgs;
  // The answer to an earlier `input_required`, keyed as its `inputRequests` entry was.
  const answer = asRecord(msg.params.inputResponses)?.[CONFIRM_KEY];
  const run: RunInput = {
    actor: auth.actor,
    channel: 'mcp',
    clientId: auth.clientId,
    clientName: auth.clientName,
    requestId: newId(),
    confirm: isAffirmative(answer) || confirmArg === true
  };
  try {
    const output = await runOperation(deps.db, name, args, run);
    return jsonRpcResult(msg.id, toolResult(era.legacy, output));
  } catch (error) {
    if (!(error instanceof OpError)) {
      throw error;
    }
    if (error instanceof ConfirmationRequired && era.elicits) {
      if (era.legacy) {
        return legacyElicitationResponse({
          db: deps.db,
          name,
          args,
          run,
          toolCallId: msg.id,
          question: error.question
        });
      }
      // A client that already answered, and did not accept, is not asked again (§10.5).
      if (answer === undefined) {
        return jsonRpcResult(
          msg.id,
          inputRequiredResult(CONFIRM_KEY, confirmElicitation(error.question))
        );
      }
    }
    return jsonRpcResult(msg.id, toolErrorResult(era.legacy, error));
  }
}
