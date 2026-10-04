import pino from 'pino';

import type { Db } from '@zamfono/shared';

import { isPropagationPending } from '#lib/server/propagationPending.js';
import {
  activeRingotelProvider,
  type DeviceRow
} from '#lib/server/provisioning/index.js';
import { liveRingotelDevices } from '#lib/server/provisioning/ringotelUser.js';

import { oweRestartPush } from '../afterCommit.js';
import { JOB_CALLER } from '../outcomeLog.js';
import { runPush, storedCredentialsPush } from './_ringotelPush.js';

const log = pino({ name: 'ringotel' });

/** One device's stored credentials, pushed again as the job (`pushEveryDevice`). */
async function pushStoredCredentials(db: Db, device: DeviceRow): Promise<void> {
  const warning = await runPush(
    db,
    JOB_CALLER,
    storedCredentialsPush('api.start', device.id)
  );
  if (warning !== null) {
    log.error(
      { deviceId: device.id, warning },
      'ringotel: a device push failed'
    );
  }
}

/**
 * Pushes every live `ringotel` device's stored credentials (`onCredentialsRotated`, which creates
 * a Ringotel user that is missing), as the job, with trigger `api.start`: what the pushes the
 * `api` before this one held for an owed propagation were to send (§3.1, §10.4). Every outcome is
 * a `ringotel.push` row; a refusal is logged. A stack without Ringotel pushes nothing.
 */
async function pushEveryDevice(db: Db): Promise<void> {
  if ((await activeRingotelProvider(db)) === null) {
    return;
  }
  for (const device of await liveRingotelDevices(db)) {
    // eslint-disable-next-line no-await-in-loop -- one Ringotel request at a time: no roster-sized burst against the provider's API
    await pushStoredCredentials(db, device);
  }
}

/**
 * At `api`'s start, while a propagation is owed: the device pushes that waited for it were held
 * in memory and went with the `api` before this one, so the first propagation that succeeds
 * pushes every device again (`pushEveryDevice`).
 */
export async function oweDevicePushesAtStart(db: Db): Promise<void> {
  if (await isPropagationPending(db)) {
    oweRestartPush(pushEveryDevice);
  }
}
