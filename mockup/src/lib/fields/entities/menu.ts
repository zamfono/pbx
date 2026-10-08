import { defineFields } from '../registry';

defineFields({
  entity: 'menu',
  ops: ['menus.create', 'menus.update', 'menus.setTargets'],
  fields: [
    { key: 'name', tier: 'basic' },
    { key: 'audioId', tier: 'basic' },
    { key: 'timeoutS', tier: 'advanced' },
    { key: 'maxAttempts', tier: 'advanced' },
    { key: 'allowExtensionDialing', tier: 'basic' },
    { key: 'fallbackTarget', tier: 'basic' },
    { key: 'targets', tier: 'basic' }
  ],
  notFields: ['id']
});
