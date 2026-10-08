<!--
  One outbound route being edited (§9.4 "Outbound routing"): the trunk that carries the call, the
  number it presents, who may use it and which numbers it carries. An empty caller list means
  everyone, an empty number list every number.
-->
<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import X from '@lucide/svelte/icons/x';

  import {
    liveDids,
    liveTrunks,
    userById,
    userGroupById
  } from '#lib/api/lookup.js';
  import { typedToE164 } from '#lib/api/ops/areas/dids.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { Member } from '#lib/api/types.js';
  import MemberPicker from '#lib/components/MemberPicker.svelte';
  import { formatPhone, t } from '#lib/i18n/index.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  import { isNumeric, type DraftRoute } from './format';
  import TrunkStatus from './TrunkStatus.svelte';

  type Props = {
    route: DraftRoute;
    position: number;
    count: number;
    onchange: (route: DraftRoute) => void;
    onmove: (delta: number) => void;
    onremove: () => void;
  };

  let { route, position, count, onchange, onmove, onremove }: Props = $props();

  let typed = $state('');
  let prefix = $state(true);

  const trunk = $derived(liveTrunks().find(row => row.id === route.trunkId));
  const trunkOptions = $derived([
    ...(trunk === undefined
      ? [{ value: route.trunkId, label: t('outboundRoutes.trunkGone') }]
      : []),
    ...liveTrunks().map(row => ({ value: row.id, label: row.name }))
  ]);
  const didOptions = $derived([
    { value: '', label: t('outboundRoutes.callerIdOwn') },
    ...liveDids()
      .filter(did => isNumeric(did.number))
      .map(did => ({
        value: did.id,
        label: `${formatPhone(did.number)}${did.label ? ` · ${did.label}` : ''}`
      }))
  ]);
  const catchAll = $derived(
    route.members.length === 0 && route.numbers.length === 0
  );

  const memberName = (member: Member): string =>
    member.kind === 'user'
      ? (userById(member.id)?.name ?? '—')
      : (userGroupById(member.id)?.name ?? '—');

  const summary = $derived.by(() => {
    const who =
      route.members.length === 0
        ? t('outboundRoutes.everyone')
        : route.members.map(memberName).join(', ');
    const what =
      route.numbers.length === 0
        ? t('outboundRoutes.anyNumber')
        : route.numbers
            .map(
              entry =>
                `${formatPhone(entry.number)}${entry.isPrefix ? '…' : ''}`
            )
            .join(', ');
    const callerDid = store.db.dids.find(did => did.id === route.callerIdDidId);
    return t('outboundRoutes.summary', {
      who,
      what,
      trunk: trunk?.name ?? '—',
      shows: callerDid
        ? formatPhone(callerDid.number)
        : t('outboundRoutes.theirOwnNumber')
    });
  });

  function addNumber(): void {
    const number = typedToE164(store.db, typed.trim());
    if (number === '' || route.numbers.some(entry => entry.number === number)) {
      typed = '';
      return;
    }
    onchange({
      ...route,
      numbers: [...route.numbers, { number, isPrefix: prefix }]
    });
    typed = '';
  }
</script>

<article class="route" class:catch-all={catchAll}>
  <header>
    <span
      class="pos nums"
      aria-label={t('outboundRoutes.position', { position })}>{position}</span
    >
    <div class="titles">
      <p class="summary">{summary}</p>
      <div class="badges">
        {#if catchAll}<Badge tone="primary"
            >{t('outboundRoutes.catchAll')}</Badge
          >{/if}
        {#if route.id === undefined}<Badge tone="lime"
            >{t('outboundRoutes.new')}</Badge
          >{/if}
        {#if trunk}<TrunkStatus {trunk} since={false} />{/if}
        {#if isExpert() && route.id}<code class="xs faint">{route.id}</code
          >{/if}
      </div>
    </div>
    <div class="tools">
      <IconButton
        icon={ArrowUp}
        size="sm"
        label={t('common.moveUp')}
        disabled={position === 1}
        onclick={() => onmove(-1)}
      />
      <IconButton
        icon={ArrowDown}
        size="sm"
        label={t('common.moveDown')}
        disabled={position === count}
        onclick={() => onmove(1)}
      />
      <IconButton
        icon={Trash2}
        size="sm"
        variant="danger"
        label={t('outboundRoutes.remove')}
        onclick={onremove}
      />
    </div>
  </header>

  <div class="grid">
    <div class="cell">
      <label class="label" for={`route-${route.key}-trunk`}
        >{t('field.outboundRoute.trunkId')}</label
      >
      <Select
        id={`route-${route.key}-trunk`}
        value={route.trunkId}
        options={trunkOptions}
        onchange={trunkId => onchange({ ...route, trunkId })}
      />
      <p class="help">{t('field.outboundRoute.trunkId.help')}</p>
    </div>
    <div class="cell">
      <label class="label" for={`route-${route.key}-callerId`}
        >{t('field.outboundRoute.callerIdDidId')}</label
      >
      <Select
        id={`route-${route.key}-callerId`}
        value={route.callerIdDidId ?? ''}
        options={didOptions}
        onchange={value =>
          onchange({ ...route, callerIdDidId: value === '' ? null : value })}
      />
      <p class="help">{t('field.outboundRoute.callerIdDidId.help')}</p>
    </div>
    <div class="cell">
      <label class="label" for={`route-${route.key}-members-add`}
        >{t('field.outboundRoute.users')}</label
      >
      {#if route.members.length === 0}<p class="everyone">
          {t('outboundRoutes.everyoneLong')}
        </p>{/if}
      <MemberPicker
        id={`route-${route.key}-members`}
        members={route.members}
        requireExtension={false}
        onchange={members => onchange({ ...route, members })}
      />
    </div>
    <div class="cell">
      <label class="label" for={`route-${route.key}-number`}
        >{t('field.outboundRoute.numbers')}</label
      >
      {#if route.numbers.length === 0}
        <p class="everyone">{t('outboundRoutes.anyNumberLong')}</p>
      {:else}
        <ul class="numbers">
          {#each route.numbers as entry (entry.number)}
            <li>
              <span class="mono"
                >{formatPhone(entry.number)}{entry.isPrefix ? '…' : ''}</span
              >
              <span class="xs muted"
                >{entry.isPrefix
                  ? t('outboundRoutes.startsWith')
                  : t('outboundRoutes.exactly')}</span
              >
              <IconButton
                icon={X}
                size="sm"
                variant="danger"
                label={t('common.remove')}
                onclick={() =>
                  onchange({
                    ...route,
                    numbers: route.numbers.filter(
                      other => other.number !== entry.number
                    )
                  })}
              />
            </li>
          {/each}
        </ul>
      {/if}
      <div class="add">
        <TextInput
          id={`route-${route.key}-number`}
          mono
          type="tel"
          placeholder="+43"
          bind:value={typed}
          onenter={addNumber}
        />
        <Button
          size="sm"
          variant="soft"
          icon={Plus}
          disabled={typed.trim() === ''}
          onclick={addNumber}>{t('common.add')}</Button
        >
      </div>
      <Switch
        size="sm"
        checked={prefix}
        label={t('outboundRoutes.prefixSwitch')}
        onchange={value => (prefix = value)}
      />
    </div>
  </div>
</article>

<style>
  .route {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
  }
  .route.catch-all {
    border-style: dashed;
    border-color: var(--line-strong);
  }
  header {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: var(--space-3);
    align-items: start;
  }
  .pos {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--primary);
    color: var(--on-primary);
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-lg);
  }
  .titles {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .summary {
    font-weight: 700;
    line-height: 1.4;
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .tools {
    display: flex;
    gap: 2px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4) var(--space-5);
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .label {
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .help {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  /* The empty caller list reads "everyone" here, not "no members". */
  .cell :global(.members > .empty) {
    display: none;
  }
  .everyone {
    font-size: var(--text-sm);
    color: var(--text-muted);
    padding: 6px 10px;
    background: var(--surface-2);
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-sm);
  }
  .numbers {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .numbers li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px 6px 4px 10px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .numbers li .mono {
    flex: 1;
    min-width: 0;
  }
  .add {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }
  .add :global(.input) {
    flex: 1;
  }
  @media (max-width: 760px) {
    .grid {
      grid-template-columns: 1fr;
    }
    .route {
      padding: var(--space-4);
    }
    header {
      grid-template-columns: auto 1fr;
    }
    .tools {
      grid-column: 1 / -1;
      justify-content: flex-end;
    }
  }
</style>
