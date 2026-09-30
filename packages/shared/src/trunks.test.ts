import { describe, expect, test } from 'vitest';

import { registrationUris, sipHostUri } from './trunks.js';

describe('sipHostUri', () => {
  test('host without and with port', () => {
    expect(sipHostUri({ host: 'sip.example.net', port: null })).toBe(
      'sip:sip.example.net'
    );
    expect(sipHostUri({ host: '192.0.2.1', port: 5080 })).toBe(
      'sip:192.0.2.1:5080'
    );
  });
});

describe('registrationUris', () => {
  test('host without port', () => {
    expect(
      registrationUris({
        username: 'u',
        hosts: [{ priority: 1, host: 'sip.example.net', port: null }]
      })
    ).toEqual({
      clientUri: 'sip:u@sip.example.net',
      serverUri: 'sip:sip.example.net'
    });
  });

  test('host with port', () => {
    const registrationPort = 5061;
    expect(
      registrationUris({
        username: 'u',
        hosts: [
          { priority: 1, host: 'sip.example.net', port: registrationPort }
        ]
      })
    ).toEqual({
      clientUri: 'sip:u@sip.example.net',
      serverUri: 'sip:sip.example.net:5061'
    });
  });

  test('the lowest-priority host is the registrar', () => {
    expect(
      registrationUris({
        username: 'u',
        hosts: [
          { priority: 2, host: 'backup.example.net', port: null },
          { priority: 1, host: 'sip.example.net', port: null }
        ]
      })
    ).toEqual({
      clientUri: 'sip:u@sip.example.net',
      serverUri: 'sip:sip.example.net'
    });
  });
});
