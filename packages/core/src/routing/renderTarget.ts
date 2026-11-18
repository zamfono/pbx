/**
 * A target's templated field rendered for a call (§10.1 step 7 "Templates"), where its decisions
 * are resolved (`decision.ts`). Pure: the values are handed in.
 */
import { isTemplate, renderTargetField } from '@zamfono/shared';

import type { Snapshot } from '../internal/snapshot.js';
import type { ForwardTarget } from './targets.js';

/** The target the live extension `ext` leads to, as a dialled extension does (§10.1 "Outbound"
 * step 3): its user, ring group, decision or menu; `null` for an extension nobody owns and for a
 * parking slot. */
function extensionTarget(
  snapshot: Snapshot,
  ext: string
): ForwardTarget | null {
  const row = snapshot.extensions.find(candidate => candidate.ext === ext);
  if (row === undefined) {
    return null;
  }
  if (row.userId !== null) {
    return { kind: 'user', userId: row.userId };
  }
  if (row.ringGroupId !== null) {
    return { kind: 'ringGroup', ringGroupId: row.ringGroupId };
  }
  if (row.decisionId !== null) {
    return { kind: 'decision', decisionId: row.decisionId };
  }
  return row.menuId === null ? null : { kind: 'menu', menuId: row.menuId };
}

export type Rendered =
  | { ok: true; target: ForwardTarget }
  | { ok: false; field: string; value: string };

/**
 * `target` with its templated field rendered for the call (§10.1 step 7 "Templates"): an
 * `external` target's number, a `sip` target's user part, a `webSocket` target's URL, and an
 * `extension` target as the target its extension leads to. Not ok for a value that is none of
 * its field's, an extension nobody owns among them.
 */
export function renderTarget(
  snapshot: Snapshot,
  target: ForwardTarget,
  values: Readonly<Record<string, unknown>>
): Rendered {
  if (target.kind === 'external' && isTemplate(target.number)) {
    const { ok, value } = renderTargetField('external', target.number, values);
    return ok
      ? { ok, target: { ...target, number: value } }
      : { ok, field: 'external', value };
  }
  if (target.kind === 'sip' && isTemplate(target.user)) {
    const { ok, value } = renderTargetField('user', target.user, values);
    return ok
      ? { ok, target: { ...target, user: value } }
      : { ok, field: 'user', value };
  }
  if (target.kind === 'webSocket' && isTemplate(target.url)) {
    const { ok, value } = renderTargetField('url', target.url, values);
    return ok
      ? { ok, target: { ...target, url: value } }
      : { ok, field: 'url', value };
  }
  if (target.kind === 'extension') {
    const { ok, value } = renderTargetField(
      'extension',
      target.extension,
      values
    );
    const owner = ok ? extensionTarget(snapshot, value) : null;
    return owner === null
      ? { ok: false, field: 'extension', value }
      : { ok: true, target: owner };
  }
  return { ok: true, target };
}
