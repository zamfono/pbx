import { defineFields } from '../registry';

defineFields({
  entity: 'did',
  ops: ['dids.create', 'dids.update'],
  fields: [
    { key: 'number', tier: 'basic' },
    { key: 'label', tier: 'basic' },
    { key: 'target', tier: 'basic' }
  ],
  notFields: ['id']
});
