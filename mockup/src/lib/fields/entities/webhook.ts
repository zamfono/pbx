import { defineFields } from '../registry';

defineFields({
  entity: 'webhook',
  ops: ['webhooks.create', 'webhooks.update'],
  fields: [
    { key: 'url', tier: 'basic' },
    { key: 'secret', tier: 'basic' },
    { key: 'eventTypes', tier: 'basic' },
    { key: 'active', tier: 'basic' }
  ],
  notFields: ['id']
});
