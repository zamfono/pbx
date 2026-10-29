import { defineFields } from '../registry';

defineFields({
  entity: 'personalAccessToken',
  ops: ['personalAccessTokens.create'],
  fields: [
    { key: 'name', tier: 'basic', self: true },
    { key: 'expiresAt', tier: 'basic', self: true }
  ],
  notFields: ['id', 'userId', 'pageSize', 'pageToken', 'skip', 'confirm']
});
