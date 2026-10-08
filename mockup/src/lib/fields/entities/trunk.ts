import { defineFields } from '../registry';

defineFields({
  entity: 'trunk',
  ops: ['trunks.create', 'trunks.update'],
  fields: [
    { key: 'name', tier: 'basic' },
    { key: 'emergency', tier: 'basic' },
    { key: 'authMode', tier: 'basic' },
    { key: 'username', tier: 'basic' },
    { key: 'password', tier: 'basic' },
    { key: 'hosts', tier: 'basic' },
    { key: 'transport', tier: 'basic' },
    { key: 'inboundNumberFormat', tier: 'advanced' },
    { key: 'callerIdFormat', tier: 'advanced' },
    { key: 'callerIdHeader', tier: 'advanced' },
    { key: 'clir', tier: 'advanced' },
    { key: 'diversion', tier: 'advanced' },
    { key: 'forwardedCallerId', tier: 'advanced' },
    { key: 'maxChannels', tier: 'advanced' },
    { key: 'inboundAuth', tier: 'expert' },
    { key: 'srtp', tier: 'expert' },
    { key: 'tlsVerify', tier: 'expert' },
    { key: 'qualify', tier: 'expert' },
    { key: 'outboundProxy', tier: 'expert' },
    { key: 'registerExpiryS', tier: 'expert' },
    { key: 'registerRetryS', tier: 'expert' },
    { key: 'codecs', tier: 'expert' },
    { key: 'logLevel', tier: 'expert' },
    { key: 'logLevelExpiresAt', tier: 'expert' }
  ],
  notFields: ['id']
});

/** The trunk order (`trunks.setOrder`): the order emergency calls try the emergency trunks in. */
defineFields({
  entity: 'trunkOrder',
  ops: ['trunks.setOrder'],
  fields: [{ key: 'trunkIds', tier: 'basic' }]
});
