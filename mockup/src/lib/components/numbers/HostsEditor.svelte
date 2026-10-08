<!--
  A trunk's ordered host list (§9.4 "Hosts"): each host an FQDN or IPv4 address (an inbound host
  also an IPv6 address or CIDR range), an optional port and a direction. Order is priority; a
  registration trunk registers with its first outbound or both host.
-->
<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';

  import type { Trunk, TrunkHost } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import Select from '#lib/ui/Select.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  type Props = {
    hosts: TrunkHost[];
    authMode: Trunk['authMode'];
    onchange: (hosts: TrunkHost[]) => void;
    id?: string;
    invalid?: boolean;
  };

  let {
    hosts,
    authMode,
    onchange,
    id = 'trunk-hosts',
    invalid = false
  }: Props = $props();

  const registrarIndex = $derived(
    authMode === 'registration'
      ? hosts.findIndex(host => host.direction !== 'inbound')
      : -1
  );
  const directions = $derived(
    (['both', 'outbound', 'inbound'] as const).map(value => ({
      value,
      label: t(`trunks.direction.${value}`)
    }))
  );

  function patch(index: number, next: Partial<TrunkHost>): void {
    onchange(
      hosts.map((host, position) =>
        position === index ? { ...host, ...next } : host
      )
    );
  }

  function move(index: number, delta: number): void {
    const next = [...hosts];
    const [item] = next.splice(index, 1);
    if (item !== undefined) {
      next.splice(index + delta, 0, item);
      onchange(next);
    }
  }
</script>

<div class="hosts">
  <ol>
    {#each hosts as host, index (index)}
      <li class:invalid>
        <span class="pos nums" aria-hidden="true">{index + 1}</span>
        <div class="fields">
          <div class="host">
            <TextInput
              id={index === 0 ? id : `${id}-${index}`}
              mono
              value={host.host}
              placeholder="sip.provider.example"
              oninput={value => patch(index, { host: value })}
            />
          </div>
          <div class="port">
            <NumberInput
              value={host.port}
              nullable
              min={1}
              max={65535}
              placeholder={t('trunks.portAuto')}
              onchange={port => patch(index, { port })}
            />
          </div>
          <div class="direction">
            <Select
              value={host.direction}
              options={directions}
              onchange={direction => patch(index, { direction })}
            />
          </div>
        </div>
        <div class="tools">
          <IconButton
            icon={ArrowUp}
            size="sm"
            label={t('common.moveUp')}
            disabled={index === 0}
            onclick={() => move(index, -1)}
          />
          <IconButton
            icon={ArrowDown}
            size="sm"
            label={t('common.moveDown')}
            disabled={index === hosts.length - 1}
            onclick={() => move(index, 1)}
          />
          <IconButton
            icon={X}
            size="sm"
            variant="danger"
            label={t('common.remove')}
            disabled={hosts.length === 1}
            onclick={() =>
              onchange(hosts.filter((_, position) => position !== index))}
          />
        </div>
        {#if index === registrarIndex || host.port !== null}
          <div class="notes">
            {#if index === registrarIndex}<Badge tone="primary"
                >{t('trunks.registrar')}</Badge
              >{/if}
            {#if host.port !== null}<span class="warn"
                >{t('trunks.portWarning')}</span
              >{/if}
          </div>
        {/if}
      </li>
    {/each}
  </ol>
  <div>
    <Button
      size="sm"
      variant="soft"
      icon={Plus}
      onclick={() =>
        onchange([...hosts, { host: '', port: null, direction: 'both' }])}
    >
      {t('trunks.addHost')}
    </Button>
  </div>
</div>

<style>
  .hosts {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: var(--space-2);
    padding: 8px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  li.invalid {
    border-color: var(--danger);
  }
  .pos {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--primary-soft);
    color: var(--primary);
    font-size: var(--text-xs);
    font-weight: 800;
  }
  .fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 104px 168px;
    gap: var(--space-2);
    min-width: 0;
  }
  .tools {
    display: flex;
    gap: 2px;
  }
  .notes {
    grid-column: 2 / -1;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .warn {
    font-size: var(--text-xs);
    color: var(--warn);
    font-weight: 700;
  }
  @media (max-width: 720px) {
    li {
      grid-template-columns: auto 1fr;
    }
    .fields {
      grid-template-columns: 1fr 1fr;
    }
    .host {
      grid-column: 1 / -1;
    }
    .tools {
      grid-column: 2;
      justify-content: flex-end;
    }
  }
</style>
