import { mwiMailboxOf, presenceHintDevice } from '@zamfono/shared';

import { MOH_CLASSES_DIR } from '../audio/mohLayout.js';
import {
  assertExtension,
  assertSafeConfigValue,
  assertSafeId,
  assertWholeConfigValue,
  compareStrings,
  escapeConfigValue,
  formatAllow,
  joinSections,
  type Device,
  type Rendered,
  type RenderInput
} from './shared.js';
import {
  renderRows,
  UnrenderableValueError,
  type SkippedRow
} from './skippedRows.js';
import { renderTrunksConf } from './trunks.js';

function assertSafeDevice(device: Device, ringGroupIds: string[]): void {
  assertSafeConfigValue(device.userId, 'device.userId');
  assertSafeConfigValue(device.sipUsername, 'device.sipUsername');
  assertWholeConfigValue(device.sipPassword, 'device.sipPassword');
  for (const ip of device.allowedIps ?? []) {
    assertSafeConfigValue(ip, 'device.allowedIps');
  }
  for (const ringGroupId of ringGroupIds) {
    assertSafeConfigValue(ringGroupId, 'user.ringGroupIds');
  }
}

// PJSIP OPTIONS-probes a registered device at this interval. A contact nobody probes keeps the
// status `NonQualified`, and the core reads a device as registered from its endpoint's
// `PeerStatusChange`, `Reachable` while a contact is (§9.3), so the ring reaches only
// qualified devices. The probe is
// also what holds a NAT binding open between calls, which a softphone on a mobile network needs.
const DEVICE_QUALIFY_FREQUENCY_S = 30;

/**
 * A device's dynamic AOR: `max_contacts` per §10.4 (3 default for `ringotel`, 1 for `manual`),
 * `qualify_frequency` so the device's reachability reaches the core, and `mailboxes` so PJSIP
 * accepts the device's message-summary subscription (§9.3 "MWI"): the owner's own mailbox
 * followed by every ring group the owner belongs to, so MWI for a group mailbox reaches its
 * members (§5.3).
 */
function renderDeviceAor(
  device: Device,
  ringotelMaxRegs: number,
  ringGroupIds: string[]
): string {
  const maxContacts = device.kind === 'ringotel' ? ringotelMaxRegs : 1;
  const mailboxes = [
    mwiMailboxOf({ userId: device.userId }),
    ...ringGroupIds.map(ringGroupId => mwiMailboxOf({ ringGroupId }))
  ].join(',');
  return [
    `[${device.sipUsername}]`,
    'type = aor',
    `max_contacts = ${maxContacts}`,
    'remove_existing = yes',
    `qualify_frequency = ${DEVICE_QUALIFY_FREQUENCY_S}`,
    `mailboxes = ${mailboxes}`
  ].join('\n');
}

function renderDeviceAuth(device: Device): string {
  return [
    `[${device.sipUsername}]`,
    'type = auth',
    'auth_type = userpass',
    `username = ${device.sipUsername}`,
    `password = ${escapeConfigValue(device.sipPassword)}`
  ].join('\n');
}

/**
 * A `plain` device's endpoint ACL (§5.6, §9.3 "Transport policy"): the allowlist and nothing
 * else. An address matching no rule of a PJSIP ACL is accepted, and a rule only ever matches a
 * source of its own address family, so both families are denied first and the allowlist then
 * permits back into whichever family it names.
 */
function deviceAclLines(allowedIps: string[]): string[] {
  return [
    'deny = 0.0.0.0/0',
    'deny = ::/0',
    ...allowedIps.map(ip => `permit = ${ip}`)
  ];
}

/**
 * The device's caller ID, `"<owner's name>" <<owner's extension>>`: chan_pjsip takes an inbound
 * call's caller from the endpoint's own `callerid` whenever it names a number, so the core sees
 * the owner's extension rather than the SIP username in `From` (§11.2 `calls.from_uri`: "an
 * internal extension"), and a colleague's phone shows the owner's name. The name is free text,
 * so a character that would end the quoted name (`"`, `\`) or the line (a control character) is
 * dropped, and a `;` escaped so the config parser does not read it as a comment.
 */
function formatCallerId(name: string, ext: string): string {
  assertExtension(ext, 'user.ext');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  const safeName = name.replaceAll(/["\\\u0000-\u001f\u007f]/gu, '').trim();
  return `callerid = "${escapeConfigValue(safeName)}" <${ext}>`;
}

// No `transport =` line: an endpoint ACL applies to every bound transport alike (§9.3
// "Transport policy"), so `identify_by = auth_username` matches by digest username instead.
// `moh_suggest` is the class a party this device puts on hold hears (§10.2 "Hold music").
function renderDeviceEndpoint(
  device: Device,
  owner: RenderInput['users'][number],
  settings: RenderInput['settings']
): string {
  const lines = [
    `[${device.sipUsername}]`,
    'type = endpoint',
    'context = from-users',
    formatAllow(settings.codecs),
    `aors = ${device.sipUsername}`,
    `auth = ${device.sipUsername}`,
    'identify_by = auth_username',
    formatCallerId(owner.name, owner.ext),
    `moh_suggest = ${settings.holdMohClass}`,
    'rewrite_contact = yes',
    'rtp_symmetric = yes',
    'force_rport = yes',
    'direct_media = no'
  ];
  if (device.transport === 'tls') {
    lines.push('media_encryption = sdes');
  } else {
    lines.push(...deviceAclLines(device.allowedIps ?? []));
  }
  return lines.join('\n');
}

// A device without a live owner holding an extension has no caller ID or mailbox to render.
function renderUsersConf(input: RenderInput, skipped: SkippedRow[]): string {
  const usersById = new Map(input.users.map(user => [user.id, user]));
  const devices = [...input.devices].sort((left, right) =>
    compareStrings(left.sipUsername, right.sipUsername)
  );
  assertSafeId(input.settings.holdMohClass, 'settings.holdMohClass');
  const sections = renderRows(
    devices,
    device => ({ type: 'device', id: device.id }),
    device => {
      const owner = usersById.get(device.userId);
      if (owner === undefined) {
        throw new UnrenderableValueError('device.userId');
      }
      assertSafeDevice(device, owner.ringGroupIds);
      return [
        renderDeviceAor(
          device,
          input.settings.ringotelMaxRegs,
          owner.ringGroupIds
        ),
        renderDeviceAuth(device),
        renderDeviceEndpoint(device, owner, input.settings)
      ];
    },
    skipped
  );
  return joinSections(sections);
}

/** Every extension's hint, by extension; a parking slot is known by its extension alone. */
function renderHintsConf(input: RenderInput, skipped: SkippedRow[]): string {
  const holders: (Pick<SkippedRow, 'type' | 'id'> & { ext: string })[] = [
    ...input.users.map(user => ({ type: 'user' as const, ...user })),
    ...input.ringGroups.map(group => ({
      type: 'ringGroup' as const,
      ...group
    })),
    ...input.parkingSlots.map(ext => ({
      type: 'parkingSlot' as const,
      id: ext,
      ext
    }))
  ].sort((left, right) => compareStrings(left.ext, right.ext));
  const lines = renderRows(
    holders,
    ({ type, id }) => ({ type, id }),
    ({ type, ext }) => {
      assertExtension(ext, `${type}.ext`);
      return [`exten => ${ext},hint,${presenceHintDevice(ext)}`];
    },
    skipped
  );
  return `${lines.join('\n')}\n`;
}

/** One class per `moh` asset (§10.2); Asterisk's own built-in `default` class is not rendered here. */
function renderMohConf(input: RenderInput, skipped: SkippedRow[]): string {
  const assets = [...input.moh].sort((left, right) =>
    compareStrings(left.id, right.id)
  );
  const sections = renderRows(
    assets,
    asset => ({ type: 'audioAsset', id: asset.id }),
    asset => {
      assertSafeId(asset.id, 'audioAsset.id');
      return [
        [
          `[${asset.id}]`,
          'mode = files',
          `directory = /media/${MOH_CLASSES_DIR}/${asset.id}/`
        ].join('\n')
      ];
    },
    skipped
  );
  return joinSections(sections);
}

/**
 * The four generated files, and the rows left out of them since a value of theirs cannot be
 * written into the config (§3.1 "Config propagation").
 */
export function render(input: RenderInput): {
  files: Rendered;
  skipped: SkippedRow[];
} {
  const skipped: SkippedRow[] = [];
  const files: Rendered = {
    'pjsip_users.conf': renderUsersConf(input, skipped),
    'pjsip_trunks.conf': renderTrunksConf(input, skipped),
    'extensions_hints.conf': renderHintsConf(input, skipped),
    'musiconhold.conf': renderMohConf(input, skipped)
  };
  return { files, skipped };
}
