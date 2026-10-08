import { defineFields } from '../registry';

defineFields({
  entity: 'blockedNumber',
  ops: ['blockedNumbers.create'],
  fields: [
    { key: 'number', tier: 'basic' },
    { key: 'isPrefix', tier: 'basic' },
    { key: 'label', tier: 'basic' }
  ]
});
