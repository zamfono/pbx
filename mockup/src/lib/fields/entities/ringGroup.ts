import { defineFields } from '../registry';

defineFields({
  entity: 'ringGroup',
  ops: ['ringGroups.create', 'ringGroups.update', 'ringGroups.setForwarding'],
  fields: [
    { key: 'name', tier: 'basic' },
    { key: 'ext', tier: 'basic', readOnly: true },
    { key: 'strategy', tier: 'basic' },
    { key: 'members', tier: 'basic' },
    { key: 'ringTimeoutS', tier: 'advanced' },
    { key: 'ringTotalS', tier: 'advanced' },
    { key: 'skipBusy', tier: 'advanced' },
    { key: 'allowReject', tier: 'advanced' },
    { key: 'greetingAudioId', tier: 'basic' },
    { key: 'mohAudioId', tier: 'basic' },
    { key: 'recordCalls', tier: 'basic' },
    { key: 'mailboxEnabled', tier: 'basic' },
    { key: 'mailboxAudioId', tier: 'basic' },
    { key: 'mailboxMaxMessages', tier: 'advanced' },
    { key: 'logLevel', tier: 'expert' },
    { key: 'logLevelExpiresAt', tier: 'expert' },
    { key: 'rules', tier: 'basic' }
  ],
  notFields: ['id']
});
