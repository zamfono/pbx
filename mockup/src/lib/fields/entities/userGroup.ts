import { defineFields } from '../registry';

defineFields({
  entity: 'userGroup',
  ops: ['userGroups.create', 'userGroups.update'],
  fields: [
    { key: 'name', tier: 'basic' },
    { key: 'members', tier: 'basic' }
  ],
  notFields: ['id', 'limit', 'cursor', 'confirm']
});
