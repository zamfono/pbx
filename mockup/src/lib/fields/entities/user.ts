import { defineFields } from '../registry';

/** A user's fields (`users.create`, `users.update`, forwarding, presence, greeting). Self-service:
 * `clir`, `rejectAnonymous`, `ringTimeoutS`, `notifyMissedCalls`, `findMe`, plus the own
 * forwarding rules, DND and greeting, which have operations of their own. */
defineFields({
  entity: 'user',
  ops: [
    'users.create',
    'users.update',
    'users.setForwarding',
    'users.setPresence',
    'users.setVoicemailGreeting'
  ],
  fields: [
    { key: 'name', tier: 'basic' },
    { key: 'email', tier: 'basic' },
    { key: 'extension', tier: 'basic' },
    { key: 'role', tier: 'basic', owner: 'display' },
    { key: 'ringTimeoutS', tier: 'basic', self: true },
    { key: 'notifyMissedCalls', tier: 'basic', self: true },
    { key: 'clir', tier: 'advanced', self: true },
    { key: 'rejectAnonymous', tier: 'advanced', self: true },
    { key: 'findMe', tier: 'advanced', self: true },
    { key: 'callerIdDidId', tier: 'advanced' },
    { key: 'recordCalls', tier: 'advanced' },
    { key: 'mailboxEnabled', tier: 'basic' },
    { key: 'mailboxMaxMessages', tier: 'advanced' },
    { key: 'mailboxAudioId', tier: 'advanced' },
    { key: 'logLevel', tier: 'expert' },
    { key: 'logLevelExpiresAt', tier: 'expert' },
    { key: 'rules', tier: 'basic', self: true },
    { key: 'dnd', tier: 'basic', self: true },
    { key: 'upload', tier: 'basic', self: true }
  ],
  notFields: ['id', 'limit', 'cursor', 'confirm']
});
