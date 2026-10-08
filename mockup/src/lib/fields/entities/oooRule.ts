import { defineFields } from '../registry';

/** Out-of-office rules: a `user` sets their own (`self`). */
defineFields({
  entity: 'oooRule',
  ops: ['ooo.create', 'ooo.update'],
  fields: [
    { key: 'startsAt', tier: 'basic', self: true },
    { key: 'expiresAt', tier: 'basic', self: true },
    { key: 'target', tier: 'basic', self: true },
    { key: 'active', tier: 'basic', self: true }
  ],
  notFields: ['id', 'scope']
});
