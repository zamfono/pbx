import { defineFields } from '../registry';

defineFields({
  entity: 'parking',
  ops: ['parking.set'],
  fields: [{ key: 'slots', tier: 'basic' }]
});
