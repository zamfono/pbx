import { asRecord } from './jsonRpc.js';

// §10.5 "Confirmation over MCP": the question a `confirm`-guarded tool asks through elicitation,
// in both eras — inside a 2026-07-28 `input_required` result, or as a legacy 2025-11-25
// server-initiated `elicitation/create` request. It is a form with one boolean field, and the
// tool runs only when the person accepts it with that field true.
export const CONFIRM_KEY = 'confirm';

/** The `elicitation/create` params (`ElicitRequestFormParams`) asking `question`. */
export function confirmElicitation(question: string): Record<string, unknown> {
  return {
    mode: 'form',
    message: question,
    requestedSchema: {
      type: 'object',
      properties: { [CONFIRM_KEY]: { type: 'boolean' } },
      required: [CONFIRM_KEY]
    }
  };
}

/** Whether an `ElicitResult` is an affirmative answer; a decline or a cancel is not. */
export function isAffirmative(answer: unknown): boolean {
  const result = asRecord(answer);
  return (
    result?.action === 'accept' &&
    asRecord(result.content)?.[CONFIRM_KEY] === true
  );
}
