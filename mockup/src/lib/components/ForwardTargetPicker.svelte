<!--
  Picks a forward target (§9.4): one of eight kinds and what it points at. `sip` and the `record`
  option are admin-only (`forwardTargets.ts`), and `sip` is edited in Expert mode only; outside it
  a `sip` target already set stays, shown as a label. A `sip` target's header templates use the 13
  template variables, at most 2048 bytes, with a warning past 150 bytes over a UDP trunk.
-->
<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import {
    liveAudio,
    liveMenus,
    liveRingGroups,
    liveTrunks,
    liveUsers,
    trunkById
  } from '#lib/api/lookup.js';
  import {
    FORWARD_TARGET_KINDS,
    SIP_HEADER_VARIABLES,
    type ForwardTarget,
    type ForwardTargetKind,
    type SipHeader
  } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import IconButton from '#lib/ui/IconButton.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  import ForwardTargetLabel from './ForwardTargetLabel.svelte';

  type Props = {
    value: ForwardTarget | null;
    onchange: (value: ForwardTarget | null) => void;
    id?: string;
    /** Offer "none" (e.g. a fallback that may be unset). */
    nullable?: boolean;
    nullLabel?: string;
    /** Restrict the kinds offered. */
    kinds?: ForwardTargetKind[];
    disabled?: boolean;
  };

  let {
    value,
    onchange,
    id = 'target',
    nullable = false,
    nullLabel,
    kinds,
    disabled = false
  }: Props = $props();

  const isAdmin = $derived(currentActor().role !== 'user');
  const sipEditable = $derived(isAdmin && isExpert());
  const SIP_MAX_BYTES = 2048;
  const UDP_WARN_BYTES = 150;
  const DEFAULT_HEADERS: SipHeader[] = [
    { name: 'X-Zamfono-Caller', value: '{{callerNumber}}' },
    { name: 'X-Zamfono-Did', value: '{{did}}' }
  ];

  const offered = $derived(
    (kinds ?? FORWARD_TARGET_KINDS).filter(
      kind => kind !== 'sip' || sipEditable || value?.kind === 'sip'
    )
  );
  const kindOptions = $derived([
    ...(nullable
      ? [{ value: 'none' as const, label: nullLabel ?? t('target.none') }]
      : []),
    ...offered.map(kind => ({
      value: kind,
      label: t(`target.kind.${kind}`),
      disabled: kind === 'sip' && !sipEditable
    }))
  ]);

  const users = $derived(liveUsers().filter(user => user.extension !== null));
  const mailboxUsers = $derived(
    liveUsers().filter(user => user.extension !== null && user.mailboxEnabled)
  );
  const groups = $derived(liveRingGroups());
  const mailboxGroups = $derived(
    liveRingGroups().filter(group => group.mailboxEnabled)
  );

  function defaultFor(kind: ForwardTargetKind): ForwardTarget {
    switch (kind) {
      case 'user':
        return { kind, userId: users[0]?.id ?? '' };
      case 'ringGroup':
        return { kind, ringGroupId: groups[0]?.id ?? '' };
      case 'external':
        return { kind, external: '', record: false };
      case 'sip':
        return {
          kind,
          trunkId: liveTrunks()[0]?.id ?? '',
          user: '',
          headers: DEFAULT_HEADERS.map(header => ({ ...header })),
          record: false
        };
      case 'mailboxUser':
        return { kind, userId: mailboxUsers[0]?.id ?? '' };
      case 'mailboxRingGroup':
        return { kind, ringGroupId: mailboxGroups[0]?.id ?? '' };
      case 'announcement':
        return { kind, audioId: liveAudio('announcement')[0]?.id ?? '' };
      case 'menu':
        return { kind, menuId: liveMenus()[0]?.id ?? '' };
    }
  }

  const encoder = new TextEncoder();
  const headerBytes = $derived(
    value?.kind === 'sip'
      ? value.headers.reduce(
          (sum, header) =>
            sum + encoder.encode(`${header.name}: ${header.value}\r\n`).length,
          0
        )
      : 0
  );
  const udpTrunk = $derived(
    value?.kind === 'sip' && trunkById(value.trunkId)?.transport === 'udp'
  );
  const sipLocked = $derived(value?.kind === 'sip' && !sipEditable);

  function patch(next: Partial<ForwardTarget>): void {
    if (value !== null) {
      onchange({ ...value, ...next } as ForwardTarget);
    }
  }

  function setHeader(index: number, next: Partial<SipHeader>): void {
    if (value?.kind === 'sip') {
      patch({
        headers: value.headers.map((header, position) =>
          position === index ? { ...header, ...next } : header
        )
      });
    }
  }
</script>

{#if sipLocked || disabled}
  <div class="locked"><ForwardTargetLabel target={value} {nullLabel} /></div>
{:else}
  <div class="picker">
    <div class="row-controls">
      <div class="kind">
        <Select
          id={`${id}-kind`}
          value={value?.kind ?? 'none'}
          options={kindOptions}
          onchange={kind => onchange(kind === 'none' ? null : defaultFor(kind))}
        />
      </div>
      <div class="what">
        {#if value?.kind === 'user' || value?.kind === 'mailboxUser'}
          {@const pool = value.kind === 'user' ? users : mailboxUsers}
          <Select
            id={`${id}-user`}
            value={value.userId}
            options={pool.map(user => ({
              value: user.id,
              label: `${user.name} (${user.extension})`
            }))}
            onchange={userId => patch({ userId })}
          />
        {:else if value?.kind === 'ringGroup' || value?.kind === 'mailboxRingGroup'}
          {@const pool = value.kind === 'ringGroup' ? groups : mailboxGroups}
          <Select
            id={`${id}-group`}
            value={value.ringGroupId}
            options={pool.map(group => ({
              value: group.id,
              label: `${group.name} (${group.ext})`
            }))}
            onchange={ringGroupId => patch({ ringGroupId })}
          />
        {:else if value?.kind === 'external'}
          <TextInput
            id={`${id}-external`}
            mono
            type="tel"
            placeholder="+4917155501234"
            value={value.external}
            oninput={external => patch({ external })}
          />
        {:else if value?.kind === 'announcement'}
          <Select
            id={`${id}-audio`}
            value={value.audioId}
            options={liveAudio('announcement').map(asset => ({
              value: asset.id,
              label: asset.label
            }))}
            onchange={audioId => patch({ audioId })}
          />
        {:else if value?.kind === 'menu'}
          <Select
            id={`${id}-menu`}
            value={value.menuId}
            options={liveMenus().map(menu => ({
              value: menu.id,
              label: menu.name
            }))}
            onchange={menuId => patch({ menuId })}
          />
        {:else if value?.kind === 'sip'}
          <Select
            id={`${id}-trunk`}
            value={value.trunkId}
            options={liveTrunks().map(trunk => ({
              value: trunk.id,
              label: trunk.name
            }))}
            onchange={trunkId => patch({ trunkId })}
          />
        {/if}
      </div>
    </div>

    {#if value?.kind === 'sip'}
      <div class="sip">
        <label class="sub" for={`${id}-sip-user`}>{t('target.sip.user')}</label>
        <TextInput
          id={`${id}-sip-user`}
          mono
          placeholder="ai-agent"
          value={value.user}
          oninput={user => patch({ user })}
        />
        <div class="sub row spread">
          <span>{t('target.sip.headers')}</span>
          <span
            class="bytes nums"
            class:warn={udpTrunk && headerBytes > UDP_WARN_BYTES}
            class:over={headerBytes > SIP_MAX_BYTES}
          >
            {headerBytes} / {SIP_MAX_BYTES} B
          </span>
        </div>
        {#each value.headers as header, index (index)}
          <div class="header-row">
            <TextInput
              mono
              value={header.name}
              placeholder="X-Header"
              oninput={name => setHeader(index, { name })}
            />
            <TextInput
              mono
              value={header.value}
              placeholder={'{{callerNumber}}'}
              oninput={next => setHeader(index, { value: next })}
            />
            <IconButton
              icon={Trash2}
              label={t('common.remove')}
              variant="danger"
              size="sm"
              onclick={() =>
                value?.kind === 'sip' &&
                patch({
                  headers: value.headers.filter(
                    (_, position) => position !== index
                  )
                })}
            />
          </div>
        {/each}
        <button
          type="button"
          class="add"
          onclick={() =>
            value?.kind === 'sip' &&
            patch({ headers: [...value.headers, { name: 'X-', value: '' }] })}
        >
          <Plus size={14} />
          {t('target.sip.addHeader')}
        </button>
        <div class="vars">
          {#each SIP_HEADER_VARIABLES as variable (variable)}
            <code>{`{{${variable}}}`}</code>
          {/each}
        </div>
        {#if udpTrunk && headerBytes > UDP_WARN_BYTES}
          <p class="warning">
            {t('target.sip.udpWarning', { bytes: headerBytes })}
          </p>
        {/if}
      </div>
    {/if}

    {#if (value?.kind === 'external' || value?.kind === 'sip') && isAdmin}
      <Switch
        id={`${id}-record`}
        size="sm"
        checked={value.record}
        label={t('target.record')}
        onchange={record => patch({ record })}
      />
    {/if}
  </div>
{/if}

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .row-controls {
    display: grid;
    grid-template-columns: minmax(170px, 0.8fr) 1.2fr;
    gap: var(--space-2);
  }
  .locked {
    padding: 8px 0;
  }
  .sip {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--line);
  }
  .sub {
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-muted);
  }
  .header-row {
    display: grid;
    grid-template-columns: 1fr 1.3fr auto;
    gap: var(--space-2);
    align-items: center;
  }
  .add {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 0;
    background: transparent;
    color: var(--primary);
    font-weight: 700;
    cursor: pointer;
    font-size: var(--text-sm);
  }
  .vars {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .vars code {
    font-size: 10.5px;
    background: var(--surface-3);
    padding: 2px 6px;
    border-radius: var(--radius-xs);
    color: var(--text-muted);
  }
  .bytes {
    font-family: var(--font-mono);
  }
  .bytes.warn {
    color: var(--warn);
  }
  .bytes.over {
    color: var(--danger);
  }
  .warning {
    font-size: var(--text-xs);
    color: var(--warn);
    font-weight: 700;
  }
  @media (max-width: 560px) {
    .row-controls,
    .header-row {
      grid-template-columns: 1fr;
    }
  }
</style>
