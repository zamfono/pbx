import { defineFields } from '../registry';

defineFields({
  entity: 'contact',
  ops: ['contacts.create', 'contacts.update'],
  fields: [
    { key: 'displayName', tier: 'basic' },
    { key: 'company', tier: 'basic' },
    { key: 'email', tier: 'basic' },
    { key: 'phones', tier: 'basic' }
  ],
  notFields: ['id']
});
