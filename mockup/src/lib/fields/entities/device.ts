import { defineFields } from '../registry';

/** A device's fields (`devices.create`, `devices.update`, `devices.setBlf`). `plain` transport
 * and its IP allowlist are SIP internals, shown in Expert mode, set by admins alone. */
defineFields({
  entity: 'device',
  ops: ['devices.create', 'devices.update', 'devices.setBlf'],
  fields: [
    { key: 'label', tier: 'basic', self: true },
    { key: 'kind', tier: 'basic', self: true },
    { key: 'transport', tier: 'expert' },
    { key: 'allowedIps', tier: 'expert' },
    { key: 'keys', tier: 'advanced', self: true }
  ],
  notFields: ['id', 'userId', 'limit', 'cursor', 'confirm']
});
