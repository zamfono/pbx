import { defineFields } from '../registry';

defineFields({
  entity: 'mailTemplate',
  ops: ['mailTemplates.put', 'mailTemplates.delete'],
  fields: [
    { key: 'subject', tier: 'basic' },
    { key: 'bodyText', tier: 'basic' },
    { key: 'bodyHtml', tier: 'advanced' }
  ],
  notFields: ['kind', 'language', 'confirm']
});
