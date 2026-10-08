<!--
  Users (`users.*`, admin): everyone in the company, with their extension, sign-in and devices.
  `/users` lists them; `/users/:id/:tab?` is one person: profile, devices, forwarding, schedule
  and access tokens. Only owners give a role other than "user", and an owner's account, password,
  second factor and tokens are owner-only.
-->
<script lang="ts">
  import CalendarClock from '@lucide/svelte/icons/calendar-clock';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import KeySquare from '@lucide/svelte/icons/key-square';
  import Link from '@lucide/svelte/icons/link';
  import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
  import PhoneForwarded from '@lucide/svelte/icons/phone-forwarded';
  import Plus from '@lucide/svelte/icons/plus';
  import Search from '@lucide/svelte/icons/search';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import ShieldOff from '@lucide/svelte/icons/shield-off';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import UserRound from '@lucide/svelte/icons/user-round';
  import UserX from '@lucide/svelte/icons/user-x';
  import Users from '@lucide/svelte/icons/users';
  import { page } from '$app/state';

  import { read, run } from '#lib/actions.svelte.js';
  import { presenceOf } from '#lib/api/lookup.js';
  import { allowed } from '#lib/api/ops/core.js';
  import { store } from '#lib/api/store.svelte.js';
  import { ROLES, type Role, type User } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import DeviceList from '#lib/components/people/DeviceList.svelte';
  import ForwardingEditor from '#lib/components/people/ForwardingEditor.svelte';
  import {
    fieldErrors,
    mfaState,
    nextFreeExtension
  } from '#lib/components/people/people.js';
  import TokenList from '#lib/components/people/TokenList.svelte';
  import UserProfileForm from '#lib/components/people/UserProfileForm.svelte';
  import ScopeSchedule from '#lib/components/schedule-scope/ScopeSchedule.svelte';
  import { formatDateTime, t } from '#lib/i18n/index.svelte.js';
  import { go, highlight, href } from '#lib/state/router.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Dialog from '#lib/ui/Dialog.svelte';
  import DisplayValue from '#lib/ui/DisplayValue.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';
  import OneTimeValue from '#lib/ui/OneTimeValue.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Presence from '#lib/ui/Presence.svelte';
  import RoleChip from '#lib/ui/RoleChip.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Tabs from '#lib/ui/Tabs.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const params = $derived(page.params as Record<string, string>);

  const actor = $derived(currentActor());
  const users = $derived(
    read<{ items: User[] }>('users.list', {}, { items: [] }).items
  );
  const deviceCounts = $derived(
    store.db.devices.reduce<Record<string, number>>((counts, device) => {
      if (device.deletedAt === null) {
        counts[device.userId] = (counts[device.userId] ?? 0) + 1;
      }
      return counts;
    }, {})
  );

  /* ---------------- list ---------------- */

  let query = $state('');
  let roleFilter = $state<Role | 'all'>('all');
  const filtered = $derived(
    users.filter(user => {
      const needle = query.trim().toLowerCase();
      const matches =
        needle === '' ||
        [user.name, user.email ?? '', user.extension ?? ''].some(value =>
          value.toLowerCase().includes(needle)
        );
      return matches && (roleFilter === 'all' || user.role === roleFilter);
    })
  );

  const columns = $derived([
    { key: 'name', label: t('common.name'), primary: true },
    { key: 'extension', label: t('field.user.extension') },
    { key: 'role', label: t('field.user.role') },
    {
      key: 'devices',
      label: t('people.tab.devices'),
      align: 'center' as const
    },
    { key: 'mfa', label: t('people.mfa'), align: 'center' as const },
    ...(isExpert()
      ? [{ key: 'id', label: t('common.id'), hideOnMobile: true }]
      : [])
  ]);

  /* ---------------- create ---------------- */

  const canCreateAny = $derived(actor.role === 'owner');
  let creating = $state(false);
  let draft = $state<{
    name: string;
    email: string;
    extension: string;
    role: Role;
  }>({ name: '', email: '', extension: '', role: 'user' });
  let createErrors = $state<Record<string, string>>({});
  let created = $state<{
    user: User;
    setupLink: string | null;
    ringotel: boolean;
  } | null>(null);

  function openCreate(): void {
    draft = {
      name: '',
      email: '',
      extension: nextFreeExtension(),
      role: 'user'
    };
    createErrors = {};
    created = null;
    creating = true;
  }

  async function create(): Promise<void> {
    const input = {
      name: draft.name,
      email: draft.email.trim() === '' ? null : draft.email.trim(),
      extension: draft.extension.trim() === '' ? null : draft.extension.trim(),
      ...(draft.role === 'user' ? {} : { role: draft.role })
    };
    const result = await run<{ user: User; setupLink: string | null }>(
      'users.create',
      input,
      {
        success: 'people.users.created',
        successParams: { name: draft.name },
        quietErrors: true
      }
    );
    if (!result.ok) {
      createErrors = fieldErrors(result.error, '_');
      return;
    }
    highlight(result.value.user.id);
    created = { ...result.value, ringotel: false };
  }

  async function addRingotel(): Promise<void> {
    if (created === null) {
      return;
    }
    const result = await run(
      'devices.create',
      { userId: created.user.id, label: 'Ringotel App', kind: 'ringotel' },
      {
        success: 'people.devices.created',
        successParams: { label: 'Ringotel App' }
      }
    );
    if (result.ok && created !== null) {
      created = { ...created, ringotel: true };
    }
  }

  /* ---------------- detail ---------------- */

  const TABS = [
    'profile',
    'devices',
    'forwarding',
    'schedule',
    'tokens'
  ] as const;
  type Tab = (typeof TABS)[number];
  const user = $derived(
    params.id === undefined
      ? undefined
      : read<User | undefined>('users.get', { id: params.id }, undefined)
  );
  const tokensVisible = $derived(
    user !== undefined &&
      allowed('personalAccessTokens.list', { userId: user.id }, actor)
  );
  const tabs = $derived(
    [
      {
        id: 'profile' as const,
        label: t('people.tab.profile'),
        icon: UserRound
      },
      {
        id: 'devices' as const,
        label: t('people.tab.devices'),
        icon: MonitorSmartphone,
        count: user ? (deviceCounts[user.id] ?? 0) : 0
      },
      {
        id: 'forwarding' as const,
        label: t('people.tab.forwarding'),
        icon: PhoneForwarded
      },
      {
        id: 'schedule' as const,
        label: t('people.tab.schedule'),
        icon: CalendarClock
      },
      ...(tokensVisible
        ? [
            {
              id: 'tokens' as const,
              label: t('people.tab.tokens'),
              icon: KeySquare
            }
          ]
        : [])
    ].filter(tab => TABS.includes(tab.id))
  );
  const activeTab = $derived<Tab>(
    tabs.some(tab => tab.id === params.tab) ? (params.tab as Tab) : 'profile'
  );

  let resetLink = $state<{ name: string; link: string } | null>(null);

  async function resetPassword(target: User): Promise<void> {
    const result = await run<{ link: string }>(
      'users.resetPassword',
      { id: target.id },
      {
        success: 'people.users.resetSent',
        successParams: { name: target.name }
      }
    );
    if (result.ok) {
      resetLink = { name: target.name, link: result.value.link };
    }
  }

  const userActions = $derived.by((): MenuItem[] => {
    if (user === undefined) {
      return [];
    }
    const target = user;
    const items: MenuItem[] = [];
    if (
      target.email !== null &&
      allowed('users.resetPassword', { id: target.id }, actor)
    ) {
      items.push({
        label: t('people.users.resetPassword'),
        icon: Link,
        op: 'users.resetPassword',
        onclick: () => void resetPassword(target)
      });
    }
    if (
      mfaState(target) === 'on' &&
      allowed('users.resetMfa', { id: target.id }, actor)
    ) {
      items.push({
        label: t('people.users.resetMfa'),
        icon: ShieldOff,
        op: 'users.resetMfa',
        onclick: () =>
          void run(
            'users.resetMfa',
            { id: target.id },
            {
              success: 'people.users.mfaReset',
              successParams: { name: target.name }
            }
          )
      });
    }
    if (allowed('users.delete', { id: target.id }, actor)) {
      items.push({
        label: t('people.users.delete'),
        icon: Trash2,
        danger: true,
        op: 'users.delete',
        onclick: async () => {
          const result = await run(
            'users.delete',
            { id: target.id },
            {
              success: 'people.users.deleted',
              successParams: { name: target.name }
            }
          );
          if (result.ok) {
            go('/users');
          }
        }
      });
    }
    if (allowed('users.erase', { id: target.id }, actor)) {
      items.push({
        label: t('people.users.erase'),
        icon: UserX,
        danger: true,
        op: 'users.erase',
        onclick: async () => {
          const result = await run(
            'users.erase',
            { id: target.id },
            { success: 'people.users.erased' }
          );
          if (result.ok) {
            go('/users');
          }
        }
      });
    }
    return items;
  });
</script>

{#if params.id === undefined}
  <PageHeader title={t('nav.users')} subtitle={t('people.users.subtitle')}>
    {#snippet actions()}
      <Button
        variant="primary"
        icon={Plus}
        op="users.create"
        onclick={openCreate}>{t('people.users.add')}</Button
      >
    {/snippet}
  </PageHeader>

  <div class="filters">
    <div class="search">
      <span class="search-icon" aria-hidden="true"><Search size={16} /></span>
      <TextInput
        id="users-search"
        type="search"
        value={query}
        placeholder={t('people.users.search')}
        oninput={value => (query = value)}
      />
    </div>
    <Segmented
      size="sm"
      ariaLabel={t('field.user.role')}
      value={roleFilter}
      options={[
        { value: 'all', label: t('common.all') },
        ...ROLES.map(role => ({ value: role, label: t(`role.${role}`) }))
      ]}
      onchange={value => (roleFilter = value)}
    />
  </div>

  <DataTable
    rows={filtered}
    {columns}
    rowKey={row => row.id}
    caption={t('nav.users')}
    onRowClick={row => go(`/users/${row.id}`)}
  >
    {#snippet cell(row, key)}
      {#if key === 'name'}
        <span class="person">
          <Avatar
            name={row.name}
            size={34}
            status={row.extension === null ? undefined : presenceOf(row.id)}
          />
          <span class="who">
            <span class="strong truncate">{row.name}</span>
            {#if row.email}
              <span class="xs muted truncate" title={row.email}
                >{row.email}</span
              >
            {:else}
              <span class="xs muted">{t('people.phoneOnly')}</span>
            {/if}
          </span>
        </span>
      {:else if key === 'extension'}
        <span class="mono strong">{row.extension ?? '—'}</span>
      {:else if key === 'role'}
        <RoleChip role={row.role} />
      {:else if key === 'devices'}
        <span class="nums" class:faint={(deviceCounts[row.id] ?? 0) === 0}
          >{deviceCounts[row.id] ?? 0}</span
        >
      {:else if key === 'mfa'}
        {#if row.email === null}
          <span class="faint small">—</span>
        {:else if mfaState(row) === 'on'}
          <span class="mfa on" title={t('people.mfa.on')}
            ><ShieldCheck size={17} /><span class="sr-only"
              >{t('people.mfa.on')}</span
            ></span
          >
        {:else}
          <span class="mfa" title={t('people.mfa.off')}
            ><ShieldOff size={17} /><span class="sr-only"
              >{t('people.mfa.off')}</span
            ></span
          >
        {/if}
      {:else if key === 'id'}
        <code class="xs faint row-id" title={row.id}>{row.id}</code>
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        icon={Users}
        title={t('people.users.empty')}
        body={t('people.users.emptyBody')}
      />
    {/snippet}
  </DataTable>
{:else if user === undefined}
  <PageHeader
    title={t('people.users.notFound')}
    back={{ href: href('/users'), label: t('nav.users') }}
  />
  <EmptyState
    icon={UserX}
    title={t('people.users.notFound')}
    body={t('people.users.notFoundBody')}
  />
{:else}
  <PageHeader
    title={user.name}
    back={{ href: href('/users'), label: t('nav.users') }}
  >
    {#snippet meta()}
      <Avatar
        name={user.name}
        size={28}
        status={user.extension === null ? undefined : presenceOf(user.id)}
      />
      <RoleChip role={user.role} />
      {#if user.extension}
        <Badge tone="primary">{t('people.ext', { ext: user.extension })}</Badge>
      {/if}
      {#if user.email}
        <span class="small muted">{user.email}</span>
      {:else}
        <Badge tone="neutral">{t('people.phoneOnly')}</Badge>
      {/if}
      {#if user.extension !== null}
        <Presence status={presenceOf(user.id)} label />
      {/if}
      {#if user.lockedUntil}
        <Badge tone="danger"
          >{t('people.users.locked', {
            until: formatDateTime(user.lockedUntil)
          })}</Badge
        >
      {/if}
      {#if isExpert()}<code class="xs faint">{user.id}</code>{/if}
    {/snippet}
    {#snippet actions()}
      <Menu items={userActions} label={t('common.actions')} />
    {/snippet}
  </PageHeader>

  <Tabs
    {tabs}
    active={activeTab}
    hrefFor={id => href(`/users/${user.id}/${id}`)}
  />

  {#if activeTab === 'profile'}
    <UserProfileForm {user} />
  {:else if activeTab === 'devices'}
    <DeviceList userId={user.id} />
  {:else if activeTab === 'forwarding'}
    <ForwardingEditor userId={user.id} />
  {:else if activeTab === 'schedule'}
    <ScopeSchedule scope={{ kind: 'user', id: user.id }} />
  {:else if activeTab === 'tokens'}
    <TokenList userId={user.id} />
  {/if}
{/if}

<Drawer
  open={creating}
  title={t('people.users.add')}
  subtitle={created === null ? t('people.users.addIntro') : undefined}
  onclose={() => (creating = false)}
>
  {#if created === null}
    <div class="stack">
      <FormField
        entity="user"
        key="name"
        error={createErrors.name ?? null}
        required
      >
        {#snippet children()}
          <TextInput
            id="user-name"
            value={draft.name}
            placeholder={t('people.users.namePlaceholder')}
            oninput={name => (draft = { ...draft, name })}
            invalid={createErrors.name !== undefined}
          />
        {/snippet}
      </FormField>
      <FormField entity="user" key="email" error={createErrors.email ?? null}>
        {#snippet children()}
          <TextInput
            id="user-email"
            type="email"
            value={draft.email}
            placeholder={t('people.users.emailPlaceholder')}
            oninput={email => (draft = { ...draft, email })}
            invalid={createErrors.email !== undefined}
          />
        {/snippet}
      </FormField>
      <FormField
        entity="user"
        key="extension"
        error={createErrors.extension ?? null}
      >
        {#snippet children()}
          <TextInput
            id="user-extension"
            mono
            value={draft.extension}
            oninput={extension => (draft = { ...draft, extension })}
            invalid={createErrors.extension !== undefined}
            onenter={create}
          />
        {/snippet}
      </FormField>
      <FormField entity="user" key="role" error={createErrors.role ?? null}>
        {#snippet children()}
          {#if canCreateAny}
            <Select
              id="user-role"
              value={draft.role}
              options={ROLES.map(role => ({
                value: role,
                label: t(`role.${role}`)
              }))}
              onchange={(role: Role) => (draft = { ...draft, role })}
            />
          {:else}
            <DisplayValue>{t('role.user')}</DisplayValue>
          {/if}
        {/snippet}
      </FormField>
      {#if draft.email.trim() === ''}
        <p class="note small">{t('people.users.phoneOnlyNote')}</p>
      {/if}
      {#if createErrors._}<p class="form-error" role="alert">
          {createErrors._}
        </p>{/if}
    </div>
  {:else}
    {@const done = created}
    <div class="stack done">
      <div class="done-head">
        <Avatar name={done.user.name} size={48} />
        <div>
          <div class="strong">{done.user.name}</div>
          <div class="small muted">
            {done.user.extension
              ? t('people.ext', { ext: done.user.extension })
              : t('people.noExtension')} · {t(`role.${done.user.role}`)}
          </div>
        </div>
      </div>
      {#if done.setupLink}
        <OneTimeValue
          value={done.setupLink}
          label={t('people.users.setupLink')}
          note={t('people.users.setupLinkNote')}
        />
      {:else}
        <p class="small muted">{t('people.users.noSetupLink')}</p>
      {/if}
      {#if done.user.extension !== null}
        <div class="ringotel">
          <span class="glyph" aria-hidden="true"><Smartphone size={20} /></span>
          <div class="grow">
            <div class="strong">{t('people.users.ringotelTitle')}</div>
            <div class="small muted">
              {done.ringotel
                ? t('people.users.ringotelDone')
                : t('people.users.ringotelBody')}
            </div>
          </div>
          {#if !done.ringotel}
            <Button
              variant="soft"
              icon={Plus}
              op="devices.create"
              onclick={addRingotel}>{t('people.devices.addRingotel')}</Button
            >
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  {#snippet footer()}
    {#if created === null}
      <Button variant="ghost" onclick={() => (creating = false)}
        >{t('common.cancel')}</Button
      >
      <Button variant="primary" op="users.create" onclick={create}
        >{t('common.create')}</Button
      >
    {:else}
      {@const id = created.user.id}
      <Button variant="ghost" icon={Plus} onclick={openCreate}
        >{t('people.users.addAnother')}</Button
      >
      <Button
        variant="primary"
        onclick={() => {
          creating = false;
          go(`/users/${id}`);
        }}
      >
        {t('people.users.openProfile')}
      </Button>
    {/if}
  {/snippet}
</Drawer>

<Dialog
  open={resetLink !== null}
  title={t('people.users.resetTitle', { name: resetLink?.name ?? '' })}
  onclose={() => (resetLink = null)}
>
  {#if resetLink !== null}
    <div class="stack">
      <p class="small muted">{t('people.users.resetIntro')}</p>
      <OneTimeValue
        value={resetLink.link}
        label={t('people.users.setupLink')}
        note={t('people.users.setupLinkNote')}
      />
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="primary" icon={KeyRound} onclick={() => (resetLink = null)}
      >{t('people.done')}</Button
    >
  {/snippet}
</Dialog>

<style>
  .row-id {
    display: inline-block;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;
  }
  .filters {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .search {
    position: relative;
    flex: 1 1 260px;
    max-width: 420px;
  }
  .search :global(input) {
    padding-left: 34px;
  }
  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    display: grid;
    z-index: 1;
    pointer-events: none;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 280px;
  }
  .mfa {
    display: inline-grid;
    color: var(--text-faint);
  }
  .mfa.on {
    color: var(--ok);
  }
  .person {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .note {
    margin: 0;
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--info-soft);
    color: var(--info);
    font-weight: 700;
  }
  .form-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 700;
  }
  .done-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .ringotel {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    border: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    background: var(--primary-soft);
    color: var(--primary);
  }
  @media (max-width: 560px) {
    .search {
      max-width: none;
    }
  }
</style>
