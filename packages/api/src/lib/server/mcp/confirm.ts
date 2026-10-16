import type { ElicitRequestFormParams } from '@modelcontextprotocol/server';

import { isRecord } from '@zamfono/shared';

// §10.5 "Confirmation over MCP": the question a `confirm`-guarded tool asks through elicitation,
// inside an `input_required` result. It is a form with one boolean field, and the
// tool runs only when the person accepts it with that field true.
export const CONFIRM_KEY = 'confirm';

/** The `elicitation/create` params (`ElicitRequestFormParams`) asking `question`. */
export function confirmElicitation(question: string): ElicitRequestFormParams {
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

/**
 * Whether the client can answer the form-mode elicitation a confirmation asks, by the capabilities
 * it declared, as the SDK's own gate reads them: `{ elicitation: {} }` means form mode only,
 * `{ elicitation: { form: {} } }` names it, and `{ elicitation: { url: {} } }` alone offers URL
 * mode, which cannot carry the question's boolean field.
 */
export function hasElicitationCapability(
  capabilities: Record<string, unknown> | undefined
): boolean {
  const value = capabilities?.elicitation;
  return isRecord(value) && ('form' in value || !('url' in value));
}

/** Whether an `ElicitResult` is an affirmative answer; a decline or a cancel is not. */
export function isAffirmative(answer: unknown): boolean {
  return (
    isRecord(answer) &&
    answer.action === 'accept' &&
    isRecord(answer.content) &&
    answer.content[CONFIRM_KEY] === true
  );
}
