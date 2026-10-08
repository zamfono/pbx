import { defineFields } from '../registry';

/** `params` is edited per kind (location and forget policy), `secret` per kind's credentials. */
defineFields({
  entity: 'backupTarget',
  ops: ['backups.targets.create', 'backups.targets.update'],
  fields: [
    { key: 'kind', tier: 'basic' },
    { key: 'params', tier: 'basic' },
    { key: 'secret', tier: 'basic' },
    { key: 'enabled', tier: 'basic' }
  ],
  notFields: ['id']
});
