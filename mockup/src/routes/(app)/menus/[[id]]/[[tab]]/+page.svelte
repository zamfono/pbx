<!--
  Phone menus (`menus.*`, admin): the list, a create drawer, and per menu its key map on a phone
  keypad (`menus.setTargets`), its settings (greeting, waiting time, attempts, extension dialling,
  fallback) and its own opening hours and out of office.
-->
<script lang="ts">
  import CalendarClock from '@lucide/svelte/icons/calendar-clock';
  import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import PhoneIncoming from '@lucide/svelte/icons/phone-incoming';
  import Plus from '@lucide/svelte/icons/plus';
  import Repeat from '@lucide/svelte/icons/repeat';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Workflow from '@lucide/svelte/icons/workflow';
  import { page } from '$app/state';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import type { BlockingRef } from '#lib/api/errors.js';
  import { audioById, liveAudio } from '#lib/api/lookup.js';
  import {
    DIGITS,
    menuReferences,
    byDigits as sortByDigits,
    type MenuInput
  } from '#lib/api/ops/areas/menus.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { ForwardTarget, Menu, MenuTarget } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import ForwardTargetLabel from '#lib/components/ForwardTargetLabel.svelte';
  import ForwardTargetPicker from '#lib/components/ForwardTargetPicker.svelte';
  import ScopeSchedule from '#lib/components/schedule-scope/ScopeSchedule.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import { refHref } from '#lib/links.js';
  import { go, href } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import Tabs from '#lib/ui/Tabs.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const params = $derived(page.params as Record<string, string>);

  const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
  const LETTERS: Record<string, string> = {
    '2': 'ABC',
    '3': 'DEF',
    '4': 'GHI',
    '5': 'JKL',
    '6': 'MNO',
    '7': 'PQRS',
    '8': 'TUV',
    '9': 'WXYZ'
  };

  const menus = $derived(
    read<{ items: Menu[] }>('menus.list', {}, { items: [] }).items
  );
  const menuId = $derived(params.id ?? null);
  const menu = $derived(
    menuId === null
      ? null
      : read<Menu | null>('menus.get', { id: menuId }, null)
  );
  const tab = $derived(params.tab ?? 'keys');

  const announcements = $derived(
    liveAudio('announcement').map(asset => ({
      value: asset.id,
      label: asset.label
    }))
  );
  const defaultTarget = (): ForwardTarget | null => {
    const fallback = store.db.settings.fallbackTarget;
    return fallback ?? null;
  };

  /* ---------------- list ---------------- */

  const columns = $derived([
    { key: 'name', label: t('field.menu.name'), primary: true },
    { key: 'audio', label: t('field.menu.audioId') },
    { key: 'keys', label: t('groups.menu.keys') },
    {
      key: 'fallback',
      label: t('field.menu.fallbackTarget'),
      hideOnMobile: true
    },
    ...(isExpert()
      ? [{ key: 'id', label: t('common.id'), hideOnMobile: true }]
      : [])
  ]);

  /* ---------------- create ---------------- */

  let creating = $state(false);
  let createDraft = $state<{
    name: string;
    audioId: string;
    fallbackTarget: ForwardTarget | null;
  }>({ name: '', audioId: '', fallbackTarget: null });
  let createError = $state<{ field: string | null; text: string } | null>(null);

  function openCreate(): void {
    createDraft = {
      name: '',
      audioId: announcements[0]?.value ?? '',
      fallbackTarget: defaultTarget()
    };
    createError = null;
    creating = true;
  }

  async function create(): Promise<void> {
    if (createDraft.fallbackTarget === null) {
      createError = {
        field: 'fallbackTarget',
        text: t('groups.sched.pickTargetError')
      };
      return;
    }
    const result = await run<Menu>(
      'menus.create',
      { ...createDraft },
      {
        success: 'groups.menu.created',
        successParams: { name: createDraft.name },
        quietErrors: true
      }
    );
    if (result.ok) {
      creating = false;
      go(`/menus/${result.value.id}`);
    } else {
      createError = {
        field: result.error.field,
        text: errorText(result.error)
      };
    }
  }

  const createFieldError = (field: string): string | null =>
    createError !== null && createError.field === field
      ? createError.text
      : null;

  /* ---------------- settings ---------------- */

  type Edit = Partial<MenuInput>;
  let edits = $derived.by<Edit>(() => {
    void menuId;
    return {};
  });
  let settingsError = $state<{ field: string | null; text: string } | null>(
    null
  );
  const current = $derived(
    menu === null ? null : ({ ...menu, ...edits } as Menu)
  );
  const dirty = $derived(Object.keys(edits).length > 0);
  const fieldError = (field: string): string | null =>
    settingsError !== null && settingsError.field === field
      ? settingsError.text
      : null;

  function edit(patch: Edit): void {
    edits = { ...edits, ...patch };
    settingsError = null;
  }

  async function saveSettings(): Promise<void> {
    if (menu === null) {
      return;
    }
    const result = await run(
      'menus.update',
      { id: menu.id, ...edits },
      { success: 'groups.menu.saved', quietErrors: true }
    );
    if (result.ok) {
      edits = {};
      settingsError = null;
    } else {
      settingsError = {
        field: result.error.field,
        text: errorText(result.error)
      };
    }
  }

  async function remove(): Promise<void> {
    if (menu === null) {
      return;
    }
    const result = await run(
      'menus.delete',
      { id: menu.id },
      { success: 'groups.menu.deleted', successParams: { name: menu.name } }
    );
    if (result.ok) {
      go('/menus');
    }
  }

  const reachedVia = $derived<BlockingRef[]>(
    menu === null ? [] : menuReferences(store.db, menu.id)
  );

  /* ---------------- key map ---------------- */

  let mapEdits = $derived.by<MenuTarget[] | null>(() => {
    void menuId;
    return null;
  });
  let selected = $derived.by<string>(() => {
    void menuId;
    return '1';
  });
  let sequence = $state('');
  let sequenceError = $state<string | null>(null);
  let mapError = $state<string | null>(null);

  const targets = $derived(
    mapEdits ??
      (menu === null
        ? []
        : read<{ targets: MenuTarget[] }>(
            'menus.getTargets',
            { id: menu.id },
            { targets: [] }
          ).targets)
  );
  const byDigits = $derived(
    new Map(targets.map(option => [option.digits, option.target]))
  );
  const sequences = $derived(
    targets.filter(option => !KEYPAD.includes(option.digits))
  );
  const selectedTarget = $derived(byDigits.get(selected) ?? null);

  function setKey(digits: string, target: ForwardTarget | null): void {
    const others = targets.filter(option => option.digits !== digits);
    mapEdits = sortByDigits(
      target === null ? others : [...others, { digits, target }]
    );
    mapError = null;
  }

  /** Maps `digits` to a first target to refine: the first ring group, else the menu's fallback. */
  function assign(digits: string): void {
    const group = store.db.ringGroups.find(
      candidate => candidate.deletedAt === null
    );
    const first: ForwardTarget | null =
      group === undefined
        ? (current?.fallbackTarget ?? null)
        : { kind: 'ringGroup', ringGroupId: group.id };
    if (first !== null) {
      setKey(digits, first);
    }
  }

  function addSequence(): void {
    const digits = sequence.trim();
    if (!DIGITS.test(digits)) {
      sequenceError = t('errors.groups.digits', { digits });
      return;
    }
    if (byDigits.has(digits)) {
      sequenceError = t('errors.groups.duplicateDigits', { digits });
      return;
    }
    assign(digits);
    selected = digits;
    sequence = '';
    sequenceError = null;
  }

  async function saveMap(): Promise<void> {
    if (menu === null || mapEdits === null) {
      return;
    }
    const result = await run(
      'menus.setTargets',
      { id: menu.id, targets: mapEdits },
      { success: 'groups.menu.keysSaved', quietErrors: true }
    );
    if (result.ok) {
      mapEdits = null;
      mapError = null;
    } else {
      mapError = errorText(result.error);
    }
  }

  /** A target's name alone, for the small label on a key. */
  function shortLabel(target: ForwardTarget): string {
    switch (target.kind) {
      case 'user':
        return (
          store.db.users.find(user => user.id === target.userId)?.name ?? '—'
        );
      case 'ringGroup':
        return (
          store.db.ringGroups.find(group => group.id === target.ringGroupId)
            ?.name ?? '—'
        );
      case 'mailboxUser':
      case 'mailboxRingGroup':
        return t('groups.menu.keyMailbox');
      case 'announcement':
        return t('target.kind.announcement');
      case 'menu':
        return (
          store.db.menus.find(other => other.id === target.menuId)?.name ?? '—'
        );
      case 'external':
        return target.external;
      case 'sip':
        return `SIP ${target.user}`;
    }
  }
</script>

{#if menuId === null}
  <PageHeader title={t('nav.menus')} subtitle={t('groups.menu.subtitle')}>
    {#snippet actions()}
      <Button
        variant="primary"
        icon={Plus}
        op="menus.create"
        onclick={openCreate}>{t('groups.menu.add')}</Button
      >
    {/snippet}
  </PageHeader>

  <DataTable
    rows={menus}
    {columns}
    rowKey={row => row.id}
    caption={t('nav.menus')}
    onRowClick={row => go(`/menus/${row.id}`)}
  >
    {#snippet cell(row, key)}
      {#if key === 'name'}
        <a class="strong" href={href(`/menus/${row.id}`)}>{row.name}</a>
      {:else if key === 'audio'}
        <span class="audio-cell small"
          ><Megaphone size={14} />
          <span class="truncate">{audioById(row.audioId)?.label ?? '—'}</span
          ></span
        >
      {:else if key === 'keys'}
        <span class="digits">
          {#each sortByDigits(row.targets) as option (option.digits)}
            <span class="digit mono">{option.digits}</span>
          {:else}
            <span class="muted small">{t('groups.menu.noKeys')}</span>
          {/each}
        </span>
      {:else if key === 'fallback'}
        <ForwardTargetLabel target={row.fallbackTarget} />
      {:else if key === 'id'}
        <code class="xs faint">{row.id}</code>
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        icon={Workflow}
        title={t('groups.menu.empty')}
        body={t('groups.menu.emptyBody')}
      >
        {#snippet action()}
          <Button
            variant="primary"
            icon={Plus}
            op="menus.create"
            onclick={openCreate}>{t('groups.menu.add')}</Button
          >
        {/snippet}
      </EmptyState>
    {/snippet}
  </DataTable>
{:else if menu === null || current === null}
  <PageHeader
    title={t('nav.menus')}
    back={{ href: href('/menus'), label: t('nav.menus') }}
  />
  <EmptyState
    icon={Workflow}
    title={t('groups.menu.notFound')}
    body={t('groups.menu.notFoundBody')}
  />
{:else}
  <PageHeader
    title={menu.name}
    back={{ href: href('/menus'), label: t('nav.menus') }}
  >
    {#snippet meta()}
      <span class="row" style="--gap: 6px">
        <Badge tone="primary" icon={Grid3x3}
          >{t('groups.menu.keyCount', { count: menu.targets.length })}</Badge
        >
        {#each reachedVia.slice(0, 3) as ref (`${ref.kind}:${ref.id}:${ref.label}`)}
          <a class="chip" href={refHref(ref) ?? undefined}
            ><PhoneIncoming size={12} /> {ref.label}</a
          >
        {/each}
        {#if isExpert()}<code class="xs faint">{menu.id}</code>{/if}
      </span>
    {/snippet}
    {#snippet actions()}
      <Button variant="ghost" icon={Trash2} op="menus.delete" onclick={remove}
        >{t('common.delete')}</Button
      >
    {/snippet}
  </PageHeader>

  <Tabs
    active={tab}
    hrefFor={id => href(`/menus/${menu.id}/${id}`)}
    tabs={[
      {
        id: 'keys',
        label: t('groups.menu.tab.keys'),
        icon: Grid3x3,
        count: targets.length
      },
      {
        id: 'settings',
        label: t('groups.menu.tab.settings'),
        icon: SlidersHorizontal
      },
      {
        id: 'schedule',
        label: t('groups.menu.tab.schedule'),
        icon: CalendarClock
      }
    ]}
  />

  <div class="tab-body">
    {#if tab === 'schedule'}
      <ScopeSchedule scope={{ kind: 'menu', id: menu.id }} />
    {:else if tab === 'settings'}
      <div class="stack">
        <div class="grid-2">
          <Card title={t('groups.menu.cardGreeting')} icon={Megaphone}>
            <div class="stack">
              <FormField
                entity="menu"
                key="name"
                error={fieldError('name')}
                required
              >
                {#snippet children()}
                  <TextInput
                    id="menu-name"
                    value={current.name}
                    invalid={fieldError('name') !== null}
                    oninput={name => edit({ name })}
                  />
                {/snippet}
              </FormField>
              <FormField
                entity="menu"
                key="audioId"
                error={fieldError('audioId')}
                required
              >
                {#snippet children()}
                  <Select
                    id="menu-audioId"
                    value={current.audioId}
                    options={announcements}
                    onchange={audioId => edit({ audioId })}
                  />
                {/snippet}
              </FormField>
              <a class="small" href={href('/audio')}>{t('groups.rg.toAudio')}</a
              >
            </div>
          </Card>
          <Card title={t('groups.menu.cardBehaviour')} icon={Repeat}>
            <div class="stack">
              <FormField
                entity="menu"
                key="timeoutS"
                error={fieldError('timeoutS')}
              >
                {#snippet children()}
                  <NumberInput
                    id="menu-timeoutS"
                    value={current.timeoutS}
                    min={1}
                    max={86400}
                    suffix={t('common.seconds')}
                    onchange={value =>
                      value !== null && edit({ timeoutS: value })}
                  />
                {/snippet}
              </FormField>
              <FormField
                entity="menu"
                key="maxAttempts"
                error={fieldError('maxAttempts')}
              >
                {#snippet children()}
                  <NumberInput
                    id="menu-maxAttempts"
                    value={current.maxAttempts}
                    min={1}
                    onchange={value =>
                      value !== null && edit({ maxAttempts: value })}
                  />
                {/snippet}
              </FormField>
              <FormField entity="menu" key="allowExtensionDialing">
                {#snippet children()}
                  <Switch
                    id="menu-allowExtensionDialing"
                    checked={current.allowExtensionDialing}
                    label={t('groups.menu.extensionDialingLabel')}
                    onchange={allowExtensionDialing =>
                      edit({ allowExtensionDialing })}
                  />
                {/snippet}
              </FormField>
            </div>
          </Card>
        </div>
        <Card
          title={t('field.menu.fallbackTarget')}
          icon={Workflow}
          description={t('groups.menu.fallbackDesc', {
            attempts: current.maxAttempts
          })}
        >
          <FormField
            entity="menu"
            key="fallbackTarget"
            error={fieldError('fallbackTarget')}
          >
            {#snippet children()}
              <ForwardTargetPicker
                id="menu-fallbackTarget"
                value={current.fallbackTarget}
                onchange={target =>
                  target !== null && edit({ fallbackTarget: target })}
              />
            {/snippet}
          </FormField>
        </Card>
        {#if settingsError !== null && settingsError.field === null}<p
            class="form-error"
            role="alert"
          >
            {settingsError.text}
          </p>{/if}
        {#if dirty}
          <div class="save-bar">
            <span class="grow small strong">{t('groups.unsaved')}</span>
            <Button
              variant="ghost"
              onclick={() => ((edits = {}), (settingsError = null))}
              >{t('common.cancel')}</Button
            >
            <Button variant="primary" op="menus.update" onclick={saveSettings}
              >{t('common.save')}</Button
            >
          </div>
        {/if}
      </div>
    {:else}
      <div class="stack">
        <ol class="flow" aria-label={t('groups.menu.flowLabel')}>
          <li>
            <span class="flow-icon"><Megaphone size={16} /></span>
            <span class="flow-text"
              ><span class="xs muted">{t('groups.menu.flowGreeting')}</span
              ><strong class="truncate"
                >{audioById(menu.audioId)?.label ?? '—'}</strong
              ></span
            >
          </li>
          <li>
            <span class="flow-icon"><Grid3x3 size={16} /></span>
            <span class="flow-text"
              ><span class="xs muted">{t('groups.menu.flowWait')}</span><strong
                >{t('groups.menu.flowWaitValue', {
                  seconds: menu.timeoutS
                })}</strong
              ></span
            >
          </li>
          <li>
            <span class="flow-icon"><Repeat size={16} /></span>
            <span class="flow-text"
              ><span class="xs muted"
                >{t('groups.menu.flowFallback', {
                  attempts: menu.maxAttempts
                })}</span
              ><ForwardTargetLabel target={menu.fallbackTarget} /></span
            >
          </li>
        </ol>

        <Card
          title={t('groups.menu.keysTitle')}
          icon={Grid3x3}
          description={t('groups.menu.keysDesc')}
        >
          <div class="keys-layout">
            <div class="pad-column">
              <div
                class="keypad"
                role="group"
                aria-label={t('groups.menu.keypadLabel')}
              >
                {#each KEYPAD as digits (digits)}
                  {@const target = byDigits.get(digits)}
                  <button
                    type="button"
                    class="key"
                    class:mapped={target !== undefined}
                    class:selected={selected === digits}
                    aria-pressed={selected === digits}
                    aria-label={target === undefined
                      ? t('groups.menu.keyFree', { digits })
                      : t('groups.menu.keyMapped', {
                          digits,
                          target: shortLabel(target)
                        })}
                    onclick={() => (selected = digits)}
                  >
                    <span class="key-digit">{digits}</span>
                    {#if target !== undefined}
                      <span class="key-label">{shortLabel(target)}</span>
                    {:else}
                      <span class="key-letters">{LETTERS[digits] ?? ''}</span>
                    {/if}
                  </button>
                {/each}
              </div>

              <div class="sequences">
                <span class="xs muted strong">{t('groups.menu.sequences')}</span
                >
                {#if sequences.length > 0}
                  <div class="row" style="--gap: 6px">
                    {#each sequences as option (option.digits)}
                      <button
                        type="button"
                        class="seq mono"
                        class:selected={selected === option.digits}
                        onclick={() => (selected = option.digits)}
                        >{option.digits}</button
                      >
                    {/each}
                  </div>
                {/if}
                <div class="seq-add">
                  <TextInput
                    id="menu-sequence"
                    mono
                    placeholder="11, *9 …"
                    bind:value={sequence}
                    invalid={sequenceError !== null}
                    onenter={addSequence}
                  />
                  <Button size="sm" icon={Plus} onclick={addSequence}
                    >{t('common.add')}</Button
                  >
                </div>
                {#if sequenceError !== null}<p
                    class="form-error xs"
                    role="alert"
                  >
                    {sequenceError}
                  </p>{/if}
              </div>
            </div>

            <div class="panel">
              <div class="panel-head">
                <span class="panel-digit mono">{selected}</span>
                <div class="grow">
                  <h4>{t('groups.menu.whenPressed', { digits: selected })}</h4>
                  <p class="xs muted">
                    {selectedTarget === null
                      ? t('groups.menu.unmapped')
                      : t('groups.menu.mappedHint')}
                  </p>
                </div>
              </div>
              {#if selectedTarget !== null}
                <ForwardTargetPicker
                  id="menu-key-target"
                  value={selectedTarget}
                  onchange={target => setKey(selected, target)}
                />
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Trash2}
                    onclick={() => setKey(selected, null)}
                    >{t('groups.menu.unassign')}</Button
                  >
                </div>
              {:else}
                <div class="unmapped">
                  <p class="small muted">
                    {current.allowExtensionDialing
                      ? t('groups.menu.unmappedExt')
                      : t('groups.menu.unmappedBody')}
                  </p>
                  <Button
                    variant="soft"
                    icon={Plus}
                    onclick={() => assign(selected)}
                    >{t('groups.menu.assign')}</Button
                  >
                </div>
              {/if}

              <div class="overview">
                <span class="xs muted strong">{t('groups.menu.overview')}</span>
                {#each targets as option (option.digits)}
                  <button
                    type="button"
                    class="overview-row"
                    class:selected={selected === option.digits}
                    onclick={() => (selected = option.digits)}
                  >
                    <span class="digit mono">{option.digits}</span>
                    <ForwardTargetLabel target={option.target} link={false} />
                  </button>
                {:else}
                  <p class="small muted">{t('groups.menu.noKeys')}</p>
                {/each}
              </div>
            </div>
          </div>
        </Card>

        {#if mapError !== null}<p class="form-error" role="alert">
            {mapError}
          </p>{/if}
        {#if mapEdits !== null}
          <div class="save-bar">
            <span class="grow small strong">{t('groups.unsaved')}</span>
            <Button
              variant="ghost"
              onclick={() => ((mapEdits = null), (mapError = null))}
              >{t('common.cancel')}</Button
            >
            <Button variant="primary" op="menus.setTargets" onclick={saveMap}
              >{t('common.save')}</Button
            >
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<Drawer
  open={creating}
  title={t('groups.menu.add')}
  subtitle={t('groups.menu.addSub')}
  onclose={() => (creating = false)}
>
  <div class="stack">
    <FormField
      entity="menu"
      key="name"
      id="menu-new-name"
      error={createFieldError('name')}
      required
    >
      {#snippet children()}
        <TextInput
          id="menu-new-name"
          bind:value={createDraft.name}
          placeholder={t('groups.menu.namePlaceholder')}
          invalid={createFieldError('name') !== null}
        />
      {/snippet}
    </FormField>
    <FormField
      entity="menu"
      key="audioId"
      id="menu-new-audio"
      error={createFieldError('audioId')}
      required
    >
      {#snippet children()}
        {#if announcements.length > 0}
          <Select
            id="menu-new-audio"
            value={createDraft.audioId}
            options={announcements}
            onchange={audioId => (createDraft.audioId = audioId)}
          />
        {:else}
          <p class="small muted">
            {t('groups.menu.noAnnouncements')}
            <a href={href('/audio')}>{t('groups.rg.toAudio')}</a>
          </p>
        {/if}
      {/snippet}
    </FormField>
    <FormField
      entity="menu"
      key="fallbackTarget"
      id="menu-new-fallback"
      error={createFieldError('fallbackTarget')}
      required
    >
      {#snippet children()}
        <ForwardTargetPicker
          id="menu-new-fallback"
          value={createDraft.fallbackTarget}
          nullable={createDraft.fallbackTarget === null}
          nullLabel={t('groups.sched.pickTarget')}
          onchange={target => (createDraft.fallbackTarget = target)}
        />
      {/snippet}
    </FormField>
    <p class="xs muted">{t('groups.menu.addHint')}</p>
    {#if createError !== null && !['name', 'audioId', 'fallbackTarget'].includes(createError.field ?? '')}
      <p class="form-error" role="alert">{createError.text}</p>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (creating = false)}
      >{t('common.cancel')}</Button
    >
    <Button variant="primary" op="menus.create" onclick={create}
      >{t('common.create')}</Button
    >
  {/snippet}
</Drawer>

<style>
  .audio-cell {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: min(100%, 320px);
    min-width: 0;
    vertical-align: middle;
  }
  .audio-cell .truncate {
    min-width: 0;
  }
  .digits {
    display: inline-flex;
    gap: 4px;
    flex-wrap: wrap;
    min-width: 132px;
  }
  .digit {
    display: inline-grid;
    place-items: center;
    min-width: 24px;
    height: 24px;
    padding: 0 6px;
    border-radius: var(--radius-xs);
    background: var(--primary-soft);
    color: var(--primary);
    font-weight: 600;
    font-size: var(--text-sm);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 10px;
    border-radius: var(--radius-pill);
    background: var(--surface-3);
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .chip:hover {
    background: var(--primary-soft);
    color: var(--primary);
    text-decoration: none;
  }
  .tab-body {
    margin-top: var(--space-4);
  }
  .flow {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    counter-reset: step;
  }
  .flow li {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--surface);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-sm);
  }
  .flow li + li::before {
    content: '';
    position: absolute;
    left: calc(-1 * var(--space-3));
    top: 50%;
    width: var(--space-3);
    border-top: 2px dashed var(--line-strong);
  }
  .flow-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--primary-soft);
    color: var(--primary);
    flex: none;
  }
  .flow-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .keys-layout {
    display: grid;
    grid-template-columns: minmax(250px, 300px) 1fr;
    gap: var(--space-5);
    align-items: start;
  }
  .pad-column {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .keypad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
    padding: var(--space-4);
    border-radius: var(--radius-lg);
    background: var(--surface-3);
  }
  .key {
    aspect-ratio: 1 / 0.86;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-width: 0;
    padding: 4px;
    border: 1.5px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    transition:
      transform 0.12s var(--ease),
      border-color 0.12s var(--ease),
      background 0.12s var(--ease);
  }
  .key:hover {
    border-color: var(--line-strong);
    transform: translateY(-1px);
  }
  .key:active {
    transform: translateY(1px);
  }
  .key:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .key.mapped {
    background: var(--primary-soft);
    border-color: color-mix(in srgb, var(--primary) 45%, transparent);
  }
  .key.selected {
    background: var(--primary);
    border-color: var(--primary);
    color: var(--on-primary);
    box-shadow: var(--shadow-primary);
  }
  .key-digit {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 800;
    line-height: 1;
  }
  .key-letters {
    font-size: 9.5px;
    letter-spacing: 0.12em;
    color: var(--text-faint);
    min-height: 12px;
  }
  .key-label {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--primary);
  }
  .key.selected .key-label,
  .key.selected .key-letters {
    color: var(--on-primary);
  }
  .sequences {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .seq {
    padding: 4px 12px;
    border: 1.5px solid color-mix(in srgb, var(--primary) 45%, transparent);
    border-radius: var(--radius-pill);
    background: var(--primary-soft);
    color: var(--primary);
    font-weight: 600;
    cursor: pointer;
  }
  .seq.selected {
    background: var(--primary);
    color: var(--on-primary);
  }
  .seq-add {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--space-2);
    align-items: center;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .panel-digit {
    display: grid;
    place-items: center;
    min-width: 52px;
    height: 52px;
    padding: 0 10px;
    border-radius: var(--radius-md);
    background: var(--primary);
    color: var(--on-primary);
    font-size: 22px;
    font-weight: 600;
    box-shadow: var(--shadow-primary);
  }
  .panel-head h4 {
    font-size: var(--text-lg);
  }
  .unmapped {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .overview {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }
  .overview-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
    font-size: var(--text-sm);
  }
  .overview-row:hover {
    background: var(--surface-2);
  }
  .overview-row.selected {
    border-color: var(--primary);
    background: var(--primary-soft);
  }
  .save-bar {
    position: sticky;
    bottom: var(--space-3);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }
  .form-error {
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  @media (max-width: 860px) {
    .keys-layout {
      grid-template-columns: 1fr;
    }
    .pad-column {
      max-width: 340px;
      width: 100%;
      margin-inline: auto;
    }
  }
  @media (max-width: 767px) {
    .flow {
      grid-template-columns: 1fr;
      gap: var(--space-2);
    }
    .flow li + li::before {
      left: 32px;
      top: calc(-1 * var(--space-2));
      width: 0;
      height: var(--space-2);
      border-top: 0;
      border-left: 2px dashed var(--line-strong);
    }
    .save-bar {
      bottom: calc(var(--tabbar-height) + var(--space-3));
    }
  }
</style>
