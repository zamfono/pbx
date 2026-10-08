<!--
  A device's revealed credentials: a `manual` device's full connection settings, what a phone set
  up by hand asks for, or a `ringotel` device's SIP username and password. Shown once.
-->
<script lang="ts">
  import type {
    ConnectionSettings,
    SipCredentials
  } from '#lib/api/ops/areas/devices.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import OneTimeValue from '#lib/ui/OneTimeValue.svelte';

  let { value }: { value: ConnectionSettings | SipCredentials } = $props();

  const rows = $derived(
    'server' in value
      ? [
          { key: 'server', text: value.server },
          { key: 'domain', text: value.domain },
          {
            key: 'transport',
            text: value.transport.map(item => item.toUpperCase()).join(' / ')
          },
          { key: 'port', text: String(value.port) },
          { key: 'username', text: value.username },
          { key: 'extension', text: value.extension },
          { key: 'displayName', text: value.displayName },
          {
            key: 'mediaEncryption',
            text:
              value.mediaEncryption === 'srtp'
                ? 'SRTP (SDES)'
                : t('common.none')
          },
          { key: 'codecs', text: value.codecs.join(', ') },
          { key: 'voicemailCode', text: value.voicemailCode }
        ]
      : [{ key: 'username', text: value.sipUsername }]
  );
  const password = $derived(
    'server' in value ? value.password : value.sipPassword
  );
</script>

<div class="settings">
  <dl>
    {#each rows as row (row.key)}
      <div class="pair">
        <dt>{t(`people.conn.${row.key}`)}</dt>
        <dd class:mono={row.key !== 'displayName'}>{row.text}</dd>
      </div>
    {/each}
  </dl>
  <OneTimeValue
    value={password}
    label={t('people.conn.password')}
    secret
    note={t('people.conn.once')}
  />
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  dl {
    margin: 0;
    display: grid;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .pair {
    display: grid;
    grid-template-columns: minmax(110px, 40%) 1fr;
    gap: var(--space-3);
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: var(--text-sm);
  }
  .pair:last-child {
    border-bottom: 0;
  }
  .pair:nth-child(odd) {
    background: var(--surface-2);
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
    user-select: all;
  }
</style>
