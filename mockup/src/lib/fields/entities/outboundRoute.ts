import { defineFields } from '../registry';

/** `outboundRoutes.replace` takes the whole ordered list; each route's fields are edited in place. */
defineFields({
  entity: 'outboundRoute',
  ops: ['outboundRoutes.replace'],
  fields: [{ key: 'routes', tier: 'basic' }]
});
