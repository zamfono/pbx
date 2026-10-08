/**
 * Call parking (`ops/parking/`, §10.2 "Call parking"): the calls parked now, which every user sees
 * as every phone's BLF shows every slot, and the set of slot extensions (admin), replaced as a
 * whole. A new slot has the tenant's extension length, is no emergency number and names no
 * user's or ring group's extension; removing a slot drops the BLF keys on it.
 */
import { conflict, invalid } from '../../errors';
import { defineOp } from '../core';
import { paginate, type Page, type PageInput } from './calls';

export type ParkedOut = {
  slot: string;
  callId: string;
  /** The parked party's number as phones show it; null when withheld. */
  caller: string | null;
  parkedAt: string;
  parkedByUserId: string;
};

const EXT_PATTERN = /^[0-9]+$/u;

defineOp<PageInput, Page<ParkedOut>>({
  name: 'parking.list',
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: (ctx, input) =>
    paginate(
      ctx.operation,
      [...ctx.db.parked]
        .sort((a, b) => a.slot.localeCompare(b.slot))
        .map(entry => ({
          slot: entry.slot,
          callId: entry.callId,
          caller:
            entry.from === 'anonymous' || entry.from === '' ? null : entry.from,
          parkedAt: entry.parkedAt,
          parkedByUserId: entry.parkedByUserId ?? ''
        })),
      input
    )
});

defineOp<Record<string, never>, { slots: string[] }>({
  name: 'parking.get',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({ slots: [...ctx.db.parkingSlots].sort() })
});

defineOp<{ slots: string[] }, { slots: string[] }>({
  name: 'parking.set',
  minRole: 'admin',
  run: (ctx, input) => {
    const slots = input.slots.map(slot => slot.trim());
    slots.forEach((slot, index) => {
      if (!EXT_PATTERN.test(slot)) {
        throw invalid(
          'slots',
          'parkingSlotDigits',
          `parking: '${slot}' is not an extension`,
          { slot }
        );
      }
      if (slots.indexOf(slot) !== index) {
        throw invalid(
          'slots',
          'parkingSlotDuplicate',
          'parking: duplicate slot',
          { slot }
        );
      }
    });
    const before = [...ctx.db.parkingSlots].sort();
    const additions = slots.filter(slot => !before.includes(slot));
    const removals = before.filter(slot => !slots.includes(slot));
    const { extLength, emergencyNumbers } = ctx.db.settings;
    for (const slot of additions) {
      if (slot.length !== extLength) {
        throw invalid(
          'slots',
          'parkingSlotLength',
          `extension must be ${extLength} digits`,
          { slot, length: extLength }
        );
      }
      if (emergencyNumbers.includes(slot)) {
        throw invalid(
          'slots',
          'parkingSlotEmergency',
          `${slot} is an emergency number and cannot be an extension`,
          { slot }
        );
      }
    }
    const owners = [
      ...ctx.db.users
        .filter(
          user =>
            user.deletedAt === null &&
            user.extension !== null &&
            additions.includes(user.extension)
        )
        .map(user => ({
          kind: 'user',
          id: user.id,
          label: `${user.extension} · ${user.name}`
        })),
      ...ctx.db.ringGroups
        .filter(
          group => group.deletedAt === null && additions.includes(group.ext)
        )
        .map(group => ({
          kind: 'ringGroup',
          id: group.id,
          label: `${group.ext} · ${group.name}`
        }))
    ];
    if (owners.length > 0) {
      throw conflict(
        'parkingSlotTaken',
        'parking: extension already assigned',
        owners
      );
    }
    const after = [...slots].sort();
    const changes: { field: string; from: unknown; to: unknown }[] = [
      { field: 'slots', from: before, to: after }
    ];
    const dropped = ctx.db.blf.flatMap(panel =>
      panel.keys.flatMap((ext, position) =>
        removals.includes(ext)
          ? [{ deviceId: panel.deviceId, ext, position }]
          : []
      )
    );
    if (dropped.length > 0) {
      // The FK cascade of `extensions` drops the BLF keys on a removed slot (§11.2).
      ctx.db.blf.forEach((panel, index) => {
        if (panel.keys.some(ext => removals.includes(ext))) {
          ctx.setKey('blf', String(index), {
            ...panel,
            keys: panel.keys.filter(ext => !removals.includes(ext))
          });
        }
      });
      changes.push({ field: 'droppedBlfKeys', from: dropped, to: [] });
    }
    ctx.setRoot('parkingSlots', after);
    ctx.audit({ entityKind: 'parking', entityId: 'parking', changes });
    return { slots: after };
  }
});
