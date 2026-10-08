import { defineFields } from '../registry';

defineFields({
  entity: 'didBlock',
  ops: ['didBlocks.create', 'didBlocks.update'],
  fields: [
    { key: 'base', tier: 'basic' },
    { key: 'label', tier: 'basic' },
    { key: 'digits', tier: 'basic' },
    { key: 'fallbackTarget', tier: 'basic' }
  ],
  notFields: ['id']
});
