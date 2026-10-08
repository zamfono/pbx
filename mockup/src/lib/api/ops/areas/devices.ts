/**
 * Devices (`ops/devices/`): a user's SIP endpoints, a `manual` phone or softphone or their one
 * `ringotel` app account. A `user` acts on their own `tls` devices alone; a `plain` device (UDP or
 * TCP from `allowedIps` only) is an admin's. Revealing and rotating credentials is admin-only.
 */
import { conflict, invalid, notFound } from '../../errors';
import { newId } from '../../ids';
import type { Codec, Db, Device } from '../../types';
import { defineOp, type Ctx } from '../core';
import { isIpOrCidr, requireText } from '../validate';
import {
  liveUser,
  ownActingUser,
  randomFrom,
  softDeleteConfirm
} from './users';

/** A device as the wire carries it: never its password; `allowedIps` null unless `plain`. */
export type DeviceOut = Omit<Device, 'password' | 'allowedIps'> & {
  allowedIps: string[] | null;
};

/** A `manual` device's connection settings (`_connectionSettings.ts`). */
export type ConnectionSettings = {
  server: string;
  domain: string;
  transport: ('tls' | 'udp' | 'tcp')[];
  port: number;
  username: string;
  password: string;
  extension: string;
  displayName: string;
  mediaEncryption: 'srtp' | 'none';
  codecs: Codec[];
  voicemailCode: string;
};

export type SipCredentials = { sipUsername: string; sipPassword: string };

const SIP_TLS_PORT = 5061;
const SIP_PLAIN_PORT = 5060;
const SLUG = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ALPHANUMERIC =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function toDeviceOut(device: Device): DeviceOut {
  const { password: _password, ...rest } = device;
  return {
    ...rest,
    allowedIps: device.transport === 'plain' ? device.allowedIps : null
  };
}

function liveDevice(db: Db, id: string): Device {
  const device = db.devices.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (device === undefined) {
    throw notFound('device', id);
  }
  return device;
}

/** `ownTlsDevice`: the caller's own `tls` device alone. */
const ownTlsDevice = (ctx: Ctx, input: { id: string }): boolean => {
  const device = liveDevice(ctx.db, input.id);
  return device.userId === ctx.actor.id && device.transport === 'tls';
};

/** `requireUserExtension`: a device is named after its user's extension. */
function requireUserExtension(db: Db, userId: string): string {
  const user = liveUser(db, userId);
  if (user.extension === null) {
    throw conflict(
      'people.deviceNeedsExtension',
      'devices: the user has no extension; give them one first',
      [{ kind: 'user', id: user.id, label: user.name }]
    );
  }
  return user.extension;
}

function checkIps(ips: unknown): string[] {
  const list = Array.isArray(ips)
    ? (ips as string[]).map(ip => String(ip).trim())
    : [];
  if (list.length === 0) {
    throw invalid(
      'allowedIps',
      'people.plainNeedsIps',
      'devices: a plain device requires allowedIps'
    );
  }
  const bad = list.find(ip => !isIpOrCidr(ip));
  if (bad !== undefined) {
    throw invalid(
      'allowedIps',
      'people.invalidIp',
      `devices: invalid IP or CIDR '${bad}'`,
      { value: bad }
    );
  }
  return list;
}

/** A fresh `e<ext>-d<slug>` naming no live device yet (§9.3 "Naming"). */
function uniqueSipUsername(db: Db, ext: string): string {
  for (;;) {
    const candidate = `e${ext}-d${randomFrom(SLUG, 5)}`;
    if (
      !db.devices.some(
        device => device.deletedAt === null && device.sipUsername === candidate
      )
    ) {
      return candidate;
    }
  }
}

function connectionSettings(db: Db, device: Device): ConnectionSettings {
  const user = liveUser(db, device.userId);
  const extension = requireUserExtension(db, user.id);
  const tls = device.transport === 'tls';
  return {
    server: db.system.stack.domain,
    domain: db.system.stack.domain,
    transport: tls ? ['tls'] : ['udp', 'tcp'],
    port: tls ? SIP_TLS_PORT : SIP_PLAIN_PORT,
    username: device.sipUsername,
    password: device.password,
    extension,
    displayName: user.name,
    mediaEncryption: tls ? 'srtp' : 'none',
    codecs: [...db.settings.codecs],
    voicemailCode: db.settings.featureCodes.ownVoicemail
  };
}

defineOp<
  { userId: string; limit?: number; cursor?: string },
  { items: DeviceOut[]; nextCursor: string | null }
>({
  name: 'devices.list',
  minRole: 'user',
  scope: ownActingUser,
  readOnly: true,
  run: (ctx, input) => ({
    items: ctx.db.devices
      .filter(
        device => device.userId === input.userId && device.deletedAt === null
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(toDeviceOut),
    nextCursor: null
  })
});

export type DeviceCreateInput = {
  userId: string;
  label: string;
  kind: Device['kind'];
  transport?: Device['transport'];
  allowedIps?: string[];
};

defineOp<
  DeviceCreateInput,
  { device: DeviceOut; connectionSettings?: ConnectionSettings }
>({
  name: 'devices.create',
  minRole: 'user',
  scope: (ctx, input) =>
    ownActingUser(ctx, input) && (input.transport ?? 'tls') === 'tls',
  run: (ctx, input) => {
    const db = ctx.db;
    const transport = input.transport ?? 'tls';
    const ext = requireUserExtension(db, input.userId);
    const label = requireText('label', input.label);
    if (input.kind === 'ringotel' && transport !== 'tls') {
      throw invalid(
        'transport',
        'people.ringotelTls',
        'devices: a ringotel device must use the tls transport'
      );
    }
    let allowedIps: string[] = [];
    if (transport === 'plain') {
      allowedIps = checkIps(input.allowedIps);
    } else if (input.allowedIps !== undefined) {
      throw invalid(
        'allowedIps',
        'people.ipsPlainOnly',
        'devices: allowedIps applies only to a plain device'
      );
    }
    if (input.kind === 'ringotel') {
      const existing = db.devices.find(
        device =>
          device.userId === input.userId &&
          device.kind === 'ringotel' &&
          device.deletedAt === null
      );
      if (existing !== undefined) {
        throw conflict(
          'people.oneRingotel',
          'users: already has a ringotel device',
          [{ kind: 'device', id: existing.id, label: existing.label }]
        );
      }
    }
    const device: Device = {
      id: newId(),
      userId: input.userId,
      label,
      kind: input.kind,
      transport,
      allowedIps,
      sipUsername: uniqueSipUsername(db, ext),
      lastRegisteredAt: null,
      password: randomFrom(ALPHANUMERIC, 24),
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('devices', device);
    ctx.audit({
      entityKind: 'device',
      entityId: device.id,
      changes: [{ field: 'label', from: null, to: label }]
    });
    // A ringotel device's credentials go to Ringotel; an admin reveals them later.
    return input.kind === 'ringotel'
      ? { device: toDeviceOut(device) }
      : {
          device: toDeviceOut(device),
          connectionSettings: connectionSettings(db, device)
        };
  }
});

defineOp<
  { id: string; label?: string; allowedIps?: string[] },
  { device: DeviceOut }
>({
  name: 'devices.update',
  minRole: 'user',
  scope: ownTlsDevice,
  run: (ctx, input) => {
    const before = liveDevice(ctx.db, input.id);
    if (input.allowedIps !== undefined && before.transport !== 'plain') {
      throw invalid(
        'allowedIps',
        'people.ipsPlainOnly',
        'devices: allowedIps applies only to a plain device'
      );
    }
    const after: Device = {
      ...before,
      label:
        input.label === undefined
          ? before.label
          : requireText('label', input.label),
      allowedIps:
        input.allowedIps === undefined
          ? before.allowedIps
          : checkIps(input.allowedIps)
    };
    ctx.put('devices', after);
    ctx.audit({ entityKind: 'device', entityId: after.id, before, after });
    return { device: toDeviceOut(after) };
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'devices.delete',
  minRole: 'user',
  scope: ownTlsDevice,
  confirm: (ctx, input) =>
    softDeleteConfirm(
      ctx,
      'devices.delete',
      liveDevice(ctx.db, input.id).label
    ),
  run: (ctx, input) => {
    const device = liveDevice(ctx.db, input.id);
    const before = { ...device };
    ctx.softDelete('devices', device.id);
    ctx.audit({
      entityKind: 'device',
      entityId: device.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: device.id };
  }
});

defineOp<{ id: string }, { keys: string[] }>({
  name: 'devices.getBlf',
  minRole: 'user',
  scope: ownTlsDevice,
  readOnly: true,
  run: (ctx, input) => {
    liveDevice(ctx.db, input.id);
    return {
      keys: [
        ...(ctx.db.blf.find(entry => entry?.deviceId === input.id)?.keys ?? [])
      ]
    };
  }
});

/** Whether `key` is a live extension: a user's, a ring group's, or a parking slot (§11.2). */
function isLiveExtension(db: Db, key: string): boolean {
  return (
    db.users.some(user => user.deletedAt === null && user.extension === key) ||
    db.ringGroups.some(
      group => group.deletedAt === null && group.ext === key
    ) ||
    db.parkingSlots.includes(key)
  );
}

defineOp<{ id: string; keys: string[] }, { id: string; keys: string[] }>({
  name: 'devices.setBlf',
  minRole: 'user',
  scope: ownTlsDevice,
  run: (ctx, input) => {
    const db = ctx.db;
    const device = liveDevice(db, input.id);
    if (device.kind !== 'ringotel') {
      throw invalid(
        'keys',
        'people.blfRingotelOnly',
        'devices: BLF keys apply only to ringotel devices'
      );
    }
    const bad = input.keys.find(key => !isLiveExtension(db, key));
    if (bad !== undefined) {
      throw invalid(
        'keys',
        'people.blfNotExtension',
        `devices: '${bad}' is not a live extension`,
        { key: bad }
      );
    }
    let index = db.blf.findIndex(entry => entry?.deviceId === device.id);
    if (index === -1) {
      // An empty panel shows every extension, as no entry does; recorded from there for undo.
      db.blf.push({ deviceId: device.id, keys: [] });
      index = db.blf.length - 1;
    }
    const before = db.blf[index]?.keys ?? [];
    ctx.setKey('blf', String(index), {
      deviceId: device.id,
      keys: [...input.keys]
    });
    ctx.audit({
      entityKind: 'device',
      entityId: device.id,
      changes: [{ field: 'blfKeys', from: before, to: input.keys }]
    });
    return { id: device.id, keys: input.keys };
  }
});

defineOp<{ id: string }, ConnectionSettings | SipCredentials>({
  name: 'devices.revealCredentials',
  minRole: 'admin',
  run: (ctx, input) => {
    const device = liveDevice(ctx.db, input.id);
    ctx.audit({
      entityKind: 'device',
      entityId: device.id,
      changes: [],
      pure: true
    });
    return device.kind === 'manual'
      ? connectionSettings(ctx.db, device)
      : { sipUsername: device.sipUsername, sipPassword: device.password };
  }
});

defineOp<{ id: string }, SipCredentials>({
  name: 'devices.rotate',
  minRole: 'admin',
  confirm: (ctx, input) => ({
    key: 'devices.rotate',
    params: { label: liveDevice(ctx.db, input.id).label },
    destructive: true,
    irreversible: true
  }),
  run: (ctx, input) => {
    const device = liveDevice(ctx.db, input.id);
    const after: Device = { ...device, password: randomFrom(ALPHANUMERIC, 24) };
    ctx.put('devices', after);
    // A secret is masked in the diff, so the API cannot undo it (§5.8).
    ctx.audit({
      entityKind: 'device',
      entityId: device.id,
      changes: [{ field: 'sipPassword', from: '•••', to: '•••' }],
      undoable: false
    });
    return { sipUsername: after.sipUsername, sipPassword: after.password };
  }
});
