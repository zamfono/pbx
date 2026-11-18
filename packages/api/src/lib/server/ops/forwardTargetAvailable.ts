import type { Db } from '@zamfono/shared';

import { assertAudioOfKind } from './audio/_shared.js';
import type { TargetSpec } from './forwardTargetType.js';
import type { LiveTable } from './liveHolder.js';
import { liveRow } from './rows.js';

/**
 * Throws 404 when an id `spec` references names no live row (§5.9: routing never depends on a
 * soft-deleted row, so a rule can only ever target one), its announcement's included, which is
 * of that kind (422); `external` names no row and needs none.
 */
export async function assertTargetAvailable(
  db: Db,
  spec: TargetSpec
): Promise<void> {
  // A `forward_targets` column's `RESTRICT` FK names a live row of `table`.
  const assertLiveRow = (table: LiveTable, id: string, label: string) =>
    liveRow(db, table, id, `${label} '${id}' not found`);
  const audioId = spec.announcementAudioId ?? null;
  if (audioId !== null) {
    await assertAudioOfKind(db, audioId, 'announcement');
  }
  if (spec.kind === 'user' || spec.kind === 'mailboxUser') {
    await assertLiveRow('users', spec.userId, 'user');
    return;
  }
  if (spec.kind === 'ringGroup' || spec.kind === 'mailboxRingGroup') {
    await assertLiveRow('ringGroups', spec.ringGroupId, 'ring group');
    return;
  }
  if (spec.kind === 'menu') {
    await assertLiveRow('menus', spec.menuId, 'menu');
    return;
  }
  if (spec.kind === 'decision') {
    await assertLiveRow('decisions', spec.decisionId, 'decision');
    return;
  }
  if (spec.kind === 'httpRequest') {
    await assertLiveRow('httpRequests', spec.httpRequestId, 'HTTP request');
    return;
  }
  if (spec.kind === 'sip') {
    await assertLiveRow('trunks', spec.trunkId, 'trunk');
  }
}
