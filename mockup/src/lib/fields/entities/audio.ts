import { defineFields } from '../registry';

defineFields({
  entity: 'audio',
  ops: ['audio.create', 'audio.update'],
  fields: [
    { key: 'upload', tier: 'basic' },
    { key: 'kind', tier: 'basic' },
    { key: 'label', tier: 'basic' }
  ],
  notFields: ['id']
});
