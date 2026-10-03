import pino from 'pino';

import { HTTP_ACCEPTED, newId, type Db } from '@zamfono/shared';

import { runOperation, type RunInput } from '../ops/runner.js';
import { ConfirmationRequired, OpError } from '../ops/types.js';
import { confirmElicitation, isAffirmative } from './confirm.js';
import { asRecord, JSONRPC_INTERNAL_ERROR, type JsonRpcId } from './jsonRpc.js';
import { toolErrorResult, toolResult } from './results.js';

// §10.5: on a legacy 2025-11-25 session a `confirm`-guarded tool call is answered by a
// server-initiated `elicitation/create` request, held open on this tools/call's Streamable HTTP
// response as one SSE event, followed by a second SSE event carrying the eventual tools/call
// result once the client answers. The two ends are correlated purely by the elicitation request's
// JSON-RPC id, in this in-memory map.
const ELICITATION_TIMEOUT_MS = 300_000;
const logger = pino({ name: 'mcp' });
const sseEncoder = new TextEncoder();
type ElicitationAnswer = { action?: unknown; content?: unknown };
type PendingElicitation = {
  resolve: (answer: ElicitationAnswer) => void;
  actorId: string;
};
/** A tools/call awaiting a legacy client's elicitation answer, keyed by the elicitation request id. */
export type LegacyElicitationRequest = {
  db: Db;
  name: string;
  args: Record<string, unknown>;
  run: RunInput;
  toolCallId: JsonRpcId;
  question: string;
};

const pending = new Map<string, PendingElicitation>();

function writeSseEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  message: object
): void {
  controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(message)}\n\n`));
}

/** Tracks whether the stream this elicitation writes to is still open, so a late timer or answer
 * never writes to (or closes) a controller the client has already disconnected; `timer` lives here
 * too, so `cancel()` can clear it without a separate mutable binding. */
type StreamState = {
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

async function settle(
  request: LegacyElicitationRequest,
  answer: ElicitationAnswer,
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState
): Promise<void> {
  if (state.closed) {
    return;
  }
  // Set before the first `await`, so two concurrent settlements of the same elicitation can never
  // both pass the guard above.
  state.closed = true;
  const { db, name, args, run, toolCallId, question } = request;
  // A declined, cancelled or timed-out elicitation mirrors the REST contract (§10.5), as a tool
  // execution error the model reads; so does anything the operation itself refuses. Only an
  // unexpected failure is a protocol-level error, and it leaks no internals.
  try {
    const result = isAffirmative(answer)
      ? toolResult(
          true,
          await runOperation(db, name, args, { ...run, confirm: true })
        )
      : toolErrorResult(true, new ConfirmationRequired(question));
    writeSseEvent(controller, { jsonrpc: '2.0', id: toolCallId, result });
  } catch (error) {
    if (error instanceof OpError) {
      const result = toolErrorResult(true, error);
      writeSseEvent(controller, { jsonrpc: '2.0', id: toolCallId, result });
    } else {
      logger.error({ err: error, operation: name }, 'mcp: tool call failed');
      writeSseEvent(controller, {
        jsonrpc: '2.0',
        id: toolCallId,
        error: { code: JSONRPC_INTERNAL_ERROR, message: 'internal error' }
      });
    }
  } finally {
    try {
      controller.close();
    } catch {
      // the client already disconnected; nothing left to close
    }
  }
}

/** The Streamable HTTP response for a legacy elicitation-capable client's `tools/call` (§10.5). */
export function legacyElicitationResponse(
  request: LegacyElicitationRequest
): Response {
  const elicitId = newId();
  const state: StreamState = { closed: false };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      writeSseEvent(controller, {
        jsonrpc: '2.0',
        id: elicitId,
        method: 'elicitation/create',
        params: confirmElicitation(request.question)
      });
      // An unanswered question times out as an unconfirmed call: the same REST-mirroring
      // `confirmationRequired` result a decline gets (§10.5), after cancelling the
      // `elicitation/create` itself, as the sender of a timed-out request SHOULD
      // (https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts).
      state.timer = setTimeout(() => {
        if (pending.delete(elicitId) && !state.closed) {
          try {
            writeSseEvent(controller, {
              jsonrpc: '2.0',
              method: 'notifications/cancelled',
              params: { requestId: elicitId, reason: 'elicitation timed out' }
            });
          } catch {
            // the client already disconnected; `settle` finds the stream closed too
          }
          settle(request, {}, controller, state).catch(() => undefined);
        }
      }, ELICITATION_TIMEOUT_MS);
      pending.set(elicitId, {
        actorId: request.run.actor.id,
        resolve: answer => {
          clearTimeout(state.timer);
          settle(request, answer, controller, state).catch(() => undefined);
        }
      });
    },
    cancel() {
      // The client disconnected before answering or timing out: stop holding the elicitation
      // and its timer open.
      state.closed = true;
      clearTimeout(state.timer);
      pending.delete(elicitId);
    }
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      // A proxy that buffers the response (Caddy terminates TLS in front of the api, §6.3) would
      // hold the `elicitation/create` event until the stream closes, well after the client
      // needs to see it.
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // 2026-07-28: "When initiating an SSE stream, servers SHOULD include the
      // `X-Accel-Buffering: no` header" so a buffering proxy such as nginx passes each event on
      // at once (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).
      // 2025-11-25, whose sessions this stream serves, says nothing either way; the header is
      // sent here too, for a proxy an operator may put in front of Caddy.
      'x-accel-buffering': 'no'
    }
  });
}

/**
 * `body`'s answer to a pending `elicitation/create`, correlated by its JSON-RPC id — a 202 once
 * resolved, or `null` when `body` is not a JSON-RPC response to one of this process's pending
 * elicitations (an ordinary request, a late/unknown answer, or an answer from an actor other than
 * the one the elicitation was put to, which is left pending for its own actor to answer).
 */
export function resolveElicitationAnswer(
  body: unknown,
  actorId: string
): Response | null {
  const record = asRecord(body);
  const id = record?.id;
  if (!record || typeof record.method === 'string' || typeof id !== 'string') {
    return null;
  }
  const entry = pending.get(id);
  if (entry?.actorId !== actorId) {
    return null;
  }
  pending.delete(id);
  entry.resolve(asRecord(record.result) ?? {});
  // JSON-RPC 2.0 §4.1: the status a notification (no `id` member) is answered with.
  return new Response(null, { status: HTTP_ACCEPTED });
}
