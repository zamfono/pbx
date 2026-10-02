import type { ChangeEntry } from '../audit/_shared.js';
import { replayOperation } from '../runner.js';
import type { Context } from '../types.js';

/** The recorded `from` of `field`, or `null` where the entry recorded no such field. */
function fromOf(changes: ChangeEntry[], field: string): unknown {
  return changes.find(change => change.field === field)?.from ?? null;
}

/**
 * Reverts one `mailTemplates.put` or `mailTemplates.delete` entry (§5.8, §11.1 "mail_templates":
 * "undo re-inserts the row from the audit diff"). The entity id is `<kind>:<language>`. Where the
 * entry had no override before it (a first `put`, whose recorded `subject` comes from `null`), the
 * revert removes the override through `mailTemplates.delete`, so the shipped template applies
 * again; otherwise the recorded override goes back through `mailTemplates.put`.
 */
export async function revertMailTemplate(
  ctx: Context,
  entityId: string,
  changes: ChangeEntry[]
): Promise<void> {
  const [kind, language] = entityId.split(':');
  const subject = fromOf(changes, 'subject');
  if (subject === null) {
    await replayOperation(ctx, 'mailTemplates.delete', { kind, language });
    return;
  }
  await replayOperation(ctx, 'mailTemplates.put', {
    kind,
    language,
    subject,
    bodyText: fromOf(changes, 'bodyText'),
    bodyHtml: fromOf(changes, 'bodyHtml')
  });
}
