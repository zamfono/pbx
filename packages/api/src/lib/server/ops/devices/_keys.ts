import { z } from 'zod';

import {
  DEVICE_KEY_FEATURES,
  isE164,
  type Db,
  type DeviceKeyFeature
} from '@zamfono/shared';

/** One entry of a device's key list (§10.4, §11.2 `device_blf_keys`). */
export const deviceKey = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z
      .literal('blf')
      .describe(
        "A BLF key showing an extension's state: a user's, a ring group's or a parking slot's."
      ),
    ext: z.string()
  }),
  z.strictObject({
    kind: z
      .literal('quickDial')
      .describe('A key dialling an outside number; yealink devices only.'),
    number: z.string().refine(isE164, 'number must be E.164'),
    label: z.string().min(1)
  }),
  z.strictObject({
    kind: z
      .literal('feature')
      .describe(
        'A feature key: dndToggle a DND key lit while DND is on, ownVoicemail or park dialling that code; yealink devices only.'
      ),
    feature: z.enum(DEVICE_KEY_FEATURES),
    label: z.string().min(1)
  }),
  z.strictObject({
    kind: z
      .literal('mailbox')
      .describe(
        "A mailbox key, lit while the mailbox holds new messages and opening it when pressed: the user's own or a ring group's they belong to; yealink devices only."
      ),
    ext: z.string(),
    label: z.string().min(1)
  }),
  z.strictObject({
    kind: z
      .literal('line')
      .describe(
        "The account's line key, showing its registration and calls; at most one, yealink devices only."
      )
  })
]);
export type DeviceKey = z.infer<typeof deviceKey>;

/**
 * `key` as its `device_blf_keys` columns, one per kind (§11.2). `isLineKey` is always set: a
 * multi-row insert writes every column any row names, NULL where a row leaves one out.
 */
export function keyColumns(key: DeviceKey): {
  ext?: string;
  number?: string;
  feature?: DeviceKeyFeature;
  mailboxExt?: string;
  isLineKey: number;
  label?: string;
} {
  switch (key.kind) {
    case 'blf':
      return { ext: key.ext, isLineKey: 0 };
    case 'quickDial':
      return { number: key.number, label: key.label, isLineKey: 0 };
    case 'feature':
      return { feature: key.feature, label: key.label, isLineKey: 0 };
    case 'mailbox':
      return { mailboxExt: key.ext, label: key.label, isLineKey: 0 };
    case 'line':
      return { isLineKey: 1 };
    default:
      throw new Error(`devices: unknown key kind '${String(key)}'`);
  }
}

/** A new `yealink` device's key list (§10.4): its line key, then a DND key. */
export const YEALINK_DEFAULT_KEYS: DeviceKey[] = [
  { kind: 'line' },
  { kind: 'feature', feature: 'dndToggle', label: 'DND' }
];

/** The extension of every key in `keys` that names one: a BLF key's or a mailbox key's. */
export function keyExtensions(keys: DeviceKey[]): string[] {
  return keys.flatMap(key =>
    key.kind === 'blf' || key.kind === 'mailbox' ? [key.ext] : []
  );
}

/** `deviceId`'s key list in position order. */
export async function loadDeviceKeys(
  db: Db,
  deviceId: string
): Promise<DeviceKey[]> {
  const rows = await db
    .selectFrom('deviceBlfKeys')
    .select(['ext', 'number', 'feature', 'mailboxExt', 'isLineKey', 'label'])
    .where('deviceId', '=', deviceId)
    .orderBy('position')
    .execute();
  // The table's CHECKs make each row exactly one kind, a labelled one with its label.
  return rows.map((row): DeviceKey => {
    const label = row.label ?? '';
    if (row.ext !== null) {
      return { kind: 'blf', ext: row.ext };
    }
    if (row.number !== null) {
      return { kind: 'quickDial', number: row.number, label };
    }
    if (row.feature !== null) {
      return {
        kind: 'feature',
        feature: row.feature as DeviceKeyFeature,
        label
      };
    }
    if (row.mailboxExt !== null) {
      return { kind: 'mailbox', ext: row.mailboxExt, label };
    }
    return { kind: 'line' };
  });
}
