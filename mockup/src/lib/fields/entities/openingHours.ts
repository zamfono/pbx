import { defineFields } from '../registry';

/** Opening hours: a `user` sets their own (`self`). */
defineFields({
  entity: 'openingHours',
  ops: ['hours.set'],
  fields: [
    { key: 'active', tier: 'basic', self: true },
    { key: 'intervals', tier: 'basic', self: true },
    { key: 'closedTarget', tier: 'basic', self: true }
  ],
  notFields: ['scope']
});
