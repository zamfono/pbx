import { defineFields } from '../registry';

defineFields({
  entity: 'sipAllowlistEntry',
  ops: ['sipAllowlist.create'],
  fields: [
    { key: 'address', tier: 'expert' },
    { key: 'label', tier: 'expert' }
  ]
});
