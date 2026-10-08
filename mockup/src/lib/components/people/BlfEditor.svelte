<!--
  A Ringotel app's BLF panel (`devices.getBlf`, `devices.setBlf`): the extensions whose lamps it
  shows, in panel order — colleagues, ring groups, parking slots. Empty shows every user and group.
-->
<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import SquareParking from '@lucide/svelte/icons/square-parking';
  import User from '@lucide/svelte/icons/user';
  import X from '@lucide/svelte/icons/x';

  import { read, run } from '#lib/actions.svelte.js';
  import {
    extensionOwner,
    liveRingGroups,
    liveUsers
  } from '#lib/api/lookup.js';
  import { store } from '#lib/api/store.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import Select from '#lib/ui/Select.svelte';

  import { fieldErrors } from './people';

  let { deviceId, ownerId }: { deviceId: string; ownerId: string } = $props();

  // Compared as text: a read returns a fresh array on every store change, which must not reset an
  // edit in progress.
  const baseJson = $derived(
    JSON.stringify(
      read<{ keys: string[] }>('devices.getBlf', { id: deviceId }, { keys: [] })
        .keys
    )
  );
  const base = $derived(JSON.parse(baseJson) as string[]);
  let keys = $derived(JSON.parse(baseJson) as string[]);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let adding = $state('');
  const dirty = $derived(JSON.stringify(base) !== JSON.stringify(keys));

  const candidates = $derived(
    [
      ...liveUsers()
        .filter(user => user.extension !== null && user.id !== ownerId)
        .map(user => ({
          value: user.extension as string,
          label: `${user.extension} · ${user.name}`
        })),
      ...liveRingGroups().map(group => ({
        value: group.ext,
        label: `${group.ext} · ${group.name}`
      })),
      ...store.db.parkingSlots.map(slot => ({
        value: slot,
        label: `${slot} · ${t('people.blf.parking')}`
      }))
    ].filter(option => !keys.includes(option.value))
  );

  function describe(key: string): { icon: typeof User; name: string } {
    const owner = extensionOwner(key);
    if (owner?.kind === 'user') {
      return { icon: User, name: owner.user.name };
    }
    if (owner?.kind === 'ringGroup') {
      return { icon: RadioTower, name: owner.group.name };
    }
    return { icon: SquareParking, name: t('people.blf.parking') };
  }

  function move(index: number, delta: number): void {
    const next = [...keys];
    const [item] = next.splice(index, 1);
    if (item !== undefined) {
      next.splice(index + delta, 0, item);
      keys = next;
    }
  }

  async function save(): Promise<void> {
    saving = true;
    const result = await run(
      'devices.setBlf',
      { id: deviceId, keys },
      { success: 'people.blf.saved', quietErrors: true }
    );
    saving = false;
    error = result.ok
      ? null
      : (Object.values(fieldErrors(result.error, '_'))[0] ?? null);
  }
</script>

<div class="blf">
  {#if keys.length === 0}
    <p class="all small">{t('people.blf.all')}</p>
  {:else}
    <ol>
      {#each keys as key, index (key)}
        {@const info = describe(key)}
        {@const Glyph = info.icon}
        <li>
          <span class="pos nums">{index + 1}</span>
          <span class="lamp" aria-hidden="true"><Glyph size={14} /></span>
          <span class="mono strong">{key}</span>
          <span class="grow truncate">{info.name}</span>
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
            disabled={index === keys.length - 1}
            onclick={() => move(index, 1)}
          />
          <IconButton
            icon={X}
            size="sm"
            variant="danger"
            label={t('common.remove')}
            onclick={() => (keys = keys.filter(other => other !== key))}
          />
        </li>
      {/each}
    </ol>
  {/if}
  {#if candidates.length > 0}
    <Select
      id={`blf-${deviceId}-add`}
      value={adding}
      options={[{ value: '', label: t('people.blf.add') }, ...candidates]}
      onchange={value => {
        if (value !== '') {
          keys = [...keys, value];
          adding = '';
        }
      }}
    />
  {/if}
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  <div class="row actions">
    {#if keys.length > 0}
      <Button size="sm" variant="ghost" onclick={() => (keys = [])}
        >{t('people.blf.reset')}</Button
      >
    {/if}
    <span class="grow"></span>
    {#if dirty}
      <Button
        size="sm"
        variant="ghost"
        onclick={() => ((keys = [...base]), (error = null))}
        >{t('people.discard')}</Button
      >
    {/if}
    <Button
      size="sm"
      variant="primary"
      op="devices.setBlf"
      loading={saving}
      disabled={!dirty}
      onclick={save}>{t('common.save')}</Button
    >
  </div>
</div>

<style>
  .blf {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .all {
    margin: 0;
    padding: var(--space-3);
    border: 1.5px dashed var(--line-strong);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px 6px 4px 10px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
  }
  .pos {
    font-size: var(--text-xs);
    font-weight: 800;
    color: var(--primary);
    width: 16px;
  }
  .lamp {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--ok-soft);
    color: var(--ok);
  }
  .actions {
    margin-top: var(--space-1);
  }
  .form-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 700;
  }
</style>
