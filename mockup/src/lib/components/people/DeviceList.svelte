<!--
  A person's devices (`devices.*`): their Ringotel app (one per person) and phones set up by hand.
  A `user` adds and edits their own `tls` devices; `plain` devices (UDP/TCP from an IP allowlist)
  are an admin's, in Expert mode. Admins reveal and rotate credentials. A new manual device's
  connection settings, revealed and rotated credentials appear once.
-->
<script lang="ts">
  import Eye from '@lucide/svelte/icons/eye';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Phone from '@lucide/svelte/icons/phone';
  import Plus from '@lucide/svelte/icons/plus';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { read, run } from '#lib/actions.svelte.js';
  import { userById } from '#lib/api/lookup.js';
  import type {
    ConnectionSettings,
    DeviceOut,
    SipCredentials
  } from '#lib/api/ops/areas/devices.js';
  import { allowed } from '#lib/api/ops/core.js';
  import { isIpOrCidr } from '#lib/api/ops/validate.js';
  import type { Device } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import { formatDate, formatRelative, t } from '#lib/i18n/index.svelte.js';
  import { highlight, router } from '#lib/state/router.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Dialog from '#lib/ui/Dialog.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import TagInput from '#lib/ui/TagInput.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  import BlfEditor from './BlfEditor.svelte';
  import ConnectionSettingsView from './ConnectionSettingsView.svelte';
  import { fieldErrors } from './people';

  let { userId }: { userId: string } = $props();

  const actor = $derived(currentActor());
  const owner = $derived(userById(userId));
  const devices = $derived(
    read<{ items: DeviceOut[] }>('devices.list', { userId }, { items: [] })
      .items
  );
  const hasRingotel = $derived(
    devices.some(device => device.kind === 'ringotel')
  );
  const canAdd = $derived(
    allowed('devices.create', { userId, kind: 'manual' }, actor)
  );
  const isAdmin = $derived(actor.role !== 'user');

  /* ---- create ---- */
  let creating = $state(false);
  let draft = $state<{
    kind: Device['kind'];
    label: string;
    transport: Device['transport'];
    allowedIps: string[];
  }>({
    kind: 'manual',
    label: '',
    transport: 'tls',
    allowedIps: []
  });
  let createErrors = $state<Record<string, string>>({});

  function openCreate(kind: Device['kind']): void {
    draft = {
      kind,
      label: kind === 'ringotel' ? 'Ringotel App' : '',
      transport: 'tls',
      allowedIps: []
    };
    createErrors = {};
    creating = true;
  }

  /* ---- one-time results ---- */
  let shown = $state<{
    title: string;
    value: ConnectionSettings | SipCredentials;
    intro: string;
  } | null>(null);

  async function create(): Promise<void> {
    const input = {
      userId,
      label: draft.label,
      kind: draft.kind,
      ...(draft.transport === 'plain'
        ? { transport: 'plain', allowedIps: draft.allowedIps }
        : {})
    };
    const result = await run<{
      device: DeviceOut;
      connectionSettings?: ConnectionSettings;
    }>('devices.create', input, {
      success: 'people.devices.created',
      successParams: { label: draft.label },
      quietErrors: true
    });
    if (!result.ok) {
      createErrors = fieldErrors(result.error, '_');
      return;
    }
    creating = false;
    highlight(result.value.device.id);
    if (result.value.connectionSettings !== undefined) {
      shown = {
        title: t('people.devices.settingsTitle', {
          label: result.value.device.label
        }),
        intro: t('people.devices.settingsIntro'),
        value: result.value.connectionSettings
      };
    }
  }

  /* ---- edit ---- */
  let editing = $state<{
    id: string;
    label: string;
    transport: Device['transport'];
    allowedIps: string[];
  } | null>(null);
  let editErrors = $state<Record<string, string>>({});

  async function saveEdit(): Promise<void> {
    if (editing === null) {
      return;
    }
    const target = devices.find(device => device.id === editing?.id);
    const input: Record<string, unknown> = { id: editing.id };
    if (target?.label !== editing.label) {
      input.label = editing.label;
    }
    if (
      editing.transport === 'plain' &&
      JSON.stringify(target?.allowedIps) !== JSON.stringify(editing.allowedIps)
    ) {
      input.allowedIps = editing.allowedIps;
    }
    const result = await run('devices.update', input, {
      success: 'people.devices.updated',
      quietErrors: true
    });
    if (result.ok) {
      editing = null;
    } else {
      editErrors = fieldErrors(result.error, '_');
    }
  }

  /* ---- actions ---- */
  async function reveal(device: DeviceOut): Promise<void> {
    const result = await run<ConnectionSettings | SipCredentials>(
      'devices.revealCredentials',
      { id: device.id }
    );
    if (result.ok) {
      shown = {
        title: t('people.devices.revealTitle', { label: device.label }),
        intro:
          device.kind === 'manual'
            ? t('people.devices.settingsIntro')
            : t('people.devices.ringotelIntro'),
        value: result.value
      };
    }
  }

  async function rotate(device: DeviceOut): Promise<void> {
    const result = await run<SipCredentials>(
      'devices.rotate',
      { id: device.id },
      { success: 'people.devices.rotated' }
    );
    if (result.ok) {
      shown = {
        title: t('people.devices.rotatedTitle', { label: device.label }),
        intro:
          device.kind === 'ringotel'
            ? t('people.devices.rotatedRingotel')
            : t('people.devices.rotatedManual'),
        value: result.value
      };
    }
  }

  let blfOpen = $state<string | null>(null);

  function menuFor(device: DeviceOut): MenuItem[] {
    const items: MenuItem[] = [];
    if (allowed('devices.revealCredentials', { id: device.id }, actor)) {
      items.push({
        label: t('people.devices.reveal'),
        icon: Eye,
        op: 'devices.revealCredentials',
        onclick: () => void reveal(device)
      });
    }
    if (allowed('devices.rotate', { id: device.id }, actor)) {
      items.push({
        label: t('people.devices.rotate'),
        icon: KeyRound,
        op: 'devices.rotate',
        onclick: () => void rotate(device)
      });
    }
    if (allowed('devices.delete', { id: device.id }, actor)) {
      items.push({
        label: t('people.devices.delete'),
        icon: Trash2,
        danger: true,
        op: 'devices.delete',
        onclick: () =>
          void run(
            'devices.delete',
            { id: device.id },
            {
              success: 'people.devices.deleted',
              successParams: { label: device.label }
            }
          )
      });
    }
    return items;
  }

  const plainVisible = $derived(isAdmin && isExpert());
  const validateIp = (value: string): string | null =>
    isIpOrCidr(value) ? null : t('errors.people.invalidIp', { value });
</script>

<div class="devices">
  {#if canAdd}
    <div class="row add">
      <Button
        variant="primary"
        icon={Plus}
        op="devices.create"
        onclick={() => openCreate('manual')}
        >{t('people.devices.addPhone')}</Button
      >
      {#if !hasRingotel}
        <Button
          variant="soft"
          icon={Smartphone}
          op="devices.create"
          onclick={() => openCreate('ringotel')}
          >{t('people.devices.addRingotel')}</Button
        >
      {/if}
    </div>
  {/if}

  {#if owner?.extension === null}
    <p class="hint small">{t('people.devices.needsExtension')}</p>
  {/if}

  {#if devices.length === 0}
    <EmptyState
      icon={MonitorSmartphone}
      title={t('people.devices.empty')}
      body={t('people.devices.emptyBody')}
    />
  {:else}
    <ul class="list">
      {#each devices as device (device.id)}
        {@const Glyph = device.kind === 'ringotel' ? Smartphone : Phone}
        {@const editable = allowed('devices.update', { id: device.id }, actor)}
        {@const items = menuFor(device)}
        <li class="device" class:flash={router.highlight === device.id}>
          <div class="head">
            <span
              class="glyph"
              class:ringotel={device.kind === 'ringotel'}
              aria-hidden="true"><Glyph size={20} /></span
            >
            <div class="titles">
              <div class="row" style="--gap: 6px">
                <span class="strong">{device.label}</span>
                <Badge tone={device.kind === 'ringotel' ? 'primary' : 'neutral'}
                  >{t(`people.devices.kind.${device.kind}`)}</Badge
                >
                {#if device.transport === 'plain'}
                  <Badge tone="warn" title={t('people.devices.plainHelp')}
                    >{t(
                      isExpert()
                        ? 'people.devices.plain'
                        : 'people.devices.unencrypted'
                    )}</Badge
                  >
                {/if}
              </div>
              <div class="meta small muted">
                {#if device.lastRegisteredAt}
                  <span class="reg ok"></span>{t('people.devices.registered', {
                    when: formatRelative(device.lastRegisteredAt)
                  })}
                {:else}
                  <span class="reg"></span>{t('people.devices.neverRegistered')}
                {/if}
              </div>
            </div>
            <div class="row nowrap" style="--gap: 2px">
              {#if editable}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Pencil}
                  op="devices.update"
                  ariaLabel={t('common.edit')}
                  onclick={() => {
                    editErrors = {};
                    editing = {
                      id: device.id,
                      label: device.label,
                      transport: device.transport,
                      allowedIps: [...(device.allowedIps ?? [])]
                    };
                  }}
                >
                  <span class="hide-sm">{t('common.edit')}</span>
                </Button>
              {/if}
              <Menu {items} label={t('common.more')} />
            </div>
          </div>
          {#if isExpert()}
            <dl class="expert xs">
              <div>
                <dt>{t('people.conn.username')}</dt>
                <dd class="mono">{device.sipUsername}</dd>
              </div>
              {#if device.allowedIps}
                <div>
                  <dt>{t('field.device.allowedIps')}</dt>
                  <dd class="mono">{device.allowedIps.join(', ')}</dd>
                </div>
              {/if}
              <div>
                <dt>{t('common.createdAt')}</dt>
                <dd>{formatDate(device.createdAt)}</dd>
              </div>
              <div>
                <dt>{t('common.id')}</dt>
                <dd class="mono faint">{device.id}</dd>
              </div>
            </dl>
          {/if}
          {#if device.kind === 'ringotel' && allowed('devices.getBlf', { id: device.id }, actor)}
            <div class="blf-toggle">
              <Button
                size="sm"
                variant="ghost"
                icon={LayoutGrid}
                onclick={() =>
                  (blfOpen = blfOpen === device.id ? null : device.id)}
              >
                {blfOpen === device.id
                  ? t('people.blf.hide')
                  : t('people.blf.show')}
              </Button>
            </div>
            {#if blfOpen === device.id}
              <div class="blf-panel">
                <p class="small muted">{t('field.device.keys.help')}</p>
                <BlfEditor deviceId={device.id} ownerId={userId} />
              </div>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<Drawer
  open={creating}
  title={draft.kind === 'ringotel'
    ? t('people.devices.addRingotel')
    : t('people.devices.addPhone')}
  subtitle={draft.kind === 'ringotel'
    ? t('people.devices.ringotelIntroCreate')
    : t('people.devices.manualIntroCreate')}
  onclose={() => (creating = false)}
>
  <div class="stack">
    {#if !hasRingotel}
      <FormField entity="device" key="kind" own>
        {#snippet children()}
          <Segmented
            value={draft.kind}
            options={[
              { value: 'manual', label: t('people.devices.kind.manual') },
              { value: 'ringotel', label: t('people.devices.kind.ringotel') }
            ]}
            onchange={kind => {
              draft = {
                ...draft,
                kind,
                transport: 'tls',
                label:
                  kind === 'ringotel' && draft.label === ''
                    ? 'Ringotel App'
                    : draft.label
              };
            }}
          />
        {/snippet}
      </FormField>
    {/if}
    <FormField
      entity="device"
      key="label"
      own
      error={createErrors.label ?? null}
      required
    >
      {#snippet children()}
        <TextInput
          id="device-label"
          value={draft.label}
          placeholder={t('people.devices.labelPlaceholder')}
          oninput={label => (draft = { ...draft, label })}
          invalid={createErrors.label !== undefined}
          onenter={create}
        />
      {/snippet}
    </FormField>
    {#if plainVisible && draft.kind === 'manual'}
      <FormField
        entity="device"
        key="transport"
        error={createErrors.transport ?? null}
      >
        {#snippet children()}
          <Segmented
            value={draft.transport}
            options={[
              { value: 'tls', label: t('people.devices.tls') },
              { value: 'plain', label: t('people.devices.plain') }
            ]}
            onchange={transport => (draft = { ...draft, transport })}
          />
        {/snippet}
      </FormField>
      {#if draft.transport === 'plain'}
        <FormField
          entity="device"
          key="allowedIps"
          error={createErrors.allowedIps ?? null}
          required
        >
          {#snippet children()}
            <TagInput
              id="device-allowedIps"
              values={draft.allowedIps}
              placeholder="198.51.100.17 / 10.20.0.0/24"
              validate={validateIp}
              onchange={allowedIps => (draft = { ...draft, allowedIps })}
            />
          {/snippet}
        </FormField>
      {/if}
    {/if}
    {#if createErrors._}<p class="form-error" role="alert">
        {createErrors._}
      </p>{/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (creating = false)}
      >{t('common.cancel')}</Button
    >
    <Button variant="primary" op="devices.create" onclick={create}
      >{t('common.add')}</Button
    >
  {/snippet}
</Drawer>

<Drawer
  open={editing !== null}
  title={t('people.devices.edit')}
  onclose={() => (editing = null)}
>
  {#if editing !== null}
    <div class="stack">
      <FormField
        entity="device"
        key="label"
        own
        error={editErrors.label ?? null}
        required
      >
        {#snippet children()}
          <TextInput
            id="device-edit-label"
            value={editing?.label ?? ''}
            oninput={label => editing && (editing = { ...editing, label })}
            invalid={editErrors.label !== undefined}
            onenter={saveEdit}
          />
        {/snippet}
      </FormField>
      {#if editing.transport === 'plain'}
        <FormField
          entity="device"
          key="allowedIps"
          error={editErrors.allowedIps ?? null}
          required
        >
          {#snippet children(fieldEditable)}
            <TagInput
              id="device-edit-allowedIps"
              values={editing?.allowedIps ?? []}
              disabled={!fieldEditable}
              validate={validateIp}
              onchange={allowedIps =>
                editing && (editing = { ...editing, allowedIps })}
            />
          {/snippet}
        </FormField>
      {/if}
      {#if editErrors._}<p class="form-error" role="alert">
          {editErrors._}
        </p>{/if}
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editing = null)}
      >{t('common.cancel')}</Button
    >
    <Button variant="primary" op="devices.update" onclick={saveEdit}
      >{t('common.save')}</Button
    >
  {/snippet}
</Drawer>

<Dialog
  open={shown !== null}
  title={shown?.title ?? ''}
  onclose={() => (shown = null)}
>
  {#if shown !== null}
    <div class="stack">
      <p class="small muted">{shown.intro}</p>
      <ConnectionSettingsView value={shown.value} />
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="primary" onclick={() => (shown = null)}
      >{t('people.done')}</Button
    >
  {/snippet}
</Dialog>

<style>
  .devices {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .hint {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    background: var(--warn-soft);
    color: var(--warn);
    border-radius: var(--radius-sm);
    font-weight: 700;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .device {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--radius-sm);
    background: var(--surface-3);
    color: var(--text-muted);
    flex: none;
  }
  .glyph.ringotel {
    background: var(--primary-soft);
    color: var(--primary);
  }
  .titles {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .reg {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--presence-offline);
    flex: none;
  }
  .reg.ok {
    background: var(--presence-available);
  }
  .expert {
    margin: 0;
    display: grid;
    gap: 4px;
    padding: var(--space-3);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .expert div {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: var(--space-2);
  }
  .expert dt {
    color: var(--text-muted);
  }
  .expert dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .blf-toggle {
    border-top: 1px solid var(--line);
    padding-top: var(--space-2);
  }
  .blf-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .blf-panel p {
    margin: 0;
  }
  .form-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 700;
  }
  @media (max-width: 560px) {
    .hide-sm {
      display: none;
    }
    .add :global(.btn) {
      flex: 1 1 100%;
      justify-content: center;
    }
  }
</style>
