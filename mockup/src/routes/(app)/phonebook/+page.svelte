<!--
  Phone book: the company-wide contacts (`contacts.list`; admins create, edit and delete them) and
  the internal directory — colleagues with their extension and presence, and the ring groups —
  searchable, each number one click from a call (`calls.originate`).
-->
<script lang="ts">
  import BookUser from '@lucide/svelte/icons/book-user';
  import Building2 from '@lucide/svelte/icons/building-2';
  import Mail from '@lucide/svelte/icons/mail';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Phone from '@lucide/svelte/icons/phone';
  import Plus from '@lucide/svelte/icons/plus';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import SearchX from '@lucide/svelte/icons/search-x';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Users from '@lucide/svelte/icons/users';
  import X from '@lucide/svelte/icons/x';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import { liveRingGroups, liveUsers, presenceOf } from '#lib/api/lookup.js';
  import type { Page } from '#lib/api/ops/areas/calls.js';
  import { ringGroupMembers } from '#lib/api/ops/areas/calls.js';
  import { allowed } from '#lib/api/ops/core.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { Contact, ContactPhone } from '#lib/api/types.js';
  import { partyName } from '#lib/components/calls/labels.js';
  import FormField from '#lib/components/FormField.svelte';
  import { formatPhone, t } from '#lib/i18n/index.svelte.js';
  import { highlight, router } from '#lib/state/router.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DisplayValue from '#lib/ui/DisplayValue.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import Menu from '#lib/ui/Menu.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Presence from '#lib/ui/Presence.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const actor = $derived(currentActor());
  const canEdit = $derived(allowed('contacts.create', {}, actor));
  const contacts = $derived(
    read<Page<Contact>>(
      'contacts.list',
      { limit: 200 },
      { items: [], nextCursor: null }
    ).items
  );

  let query = $state('');
  let section = $state<'all' | 'contacts' | 'team' | 'groups'>('all');

  const needle = $derived(query.trim().toLowerCase());
  const digits = $derived(needle.replace(/[^\d]/gu, ''));
  const hit = (...values: (string | null | undefined)[]): boolean =>
    needle === '' ||
    values.some(
      value =>
        value?.toLowerCase().includes(needle) === true ||
        (digits.length > 1 &&
          (value ?? '').replace(/[^\d]/gu, '').includes(digits))
    );

  const team = $derived(
    liveUsers()
      .filter(
        user =>
          user.extension !== null && hit(user.name, user.extension, user.email)
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  );
  const groups = $derived(
    liveRingGroups().filter(group => hit(group.name, group.ext))
  );
  const shownContacts = $derived(
    contacts.filter(contact =>
      hit(
        contact.displayName,
        contact.company,
        contact.email,
        ...contact.phones.map(phone => phone.number)
      )
    )
  );
  const nothing = $derived(
    (section === 'all' || section === 'contacts' ? shownContacts.length : 0) +
      (section === 'all' || section === 'team' ? team.length : 0) +
      (section === 'all' || section === 'groups' ? groups.length : 0) ===
      0
  );

  async function dial(target: string): Promise<void> {
    await run(
      'calls.originate',
      { target },
      {
        success: 'calls.dial.started',
        successParams: { name: partyName(target) }
      }
    );
  }

  /* ---- contact drawer ---- */

  type Draft = {
    id: string | null;
    displayName: string;
    company: string;
    email: string;
    phones: ContactPhone[];
  };
  const emptyDraft = (): Draft => ({
    id: null,
    displayName: '',
    company: '',
    email: '',
    phones: []
  });
  let draft = $state<Draft>(emptyDraft());
  let editing = $state(false);
  let errors = $state<Record<string, string>>({});
  let saving = $state(false);

  function openNew(): void {
    errors = {};
    draft = {
      ...emptyDraft(),
      phones: [{ label: t('calls.book.defaultLabel'), number: '' }]
    };
    editing = true;
  }

  function openEdit(contact: Contact): void {
    errors = {};
    draft = {
      id: contact.id,
      displayName: contact.displayName,
      company: contact.company ?? '',
      email: contact.email ?? '',
      phones: contact.phones.map(phone => ({ ...phone }))
    };
    editing = true;
  }

  async function save(): Promise<void> {
    saving = true;
    const input = {
      displayName: draft.displayName,
      company: draft.company || null,
      email: draft.email || null,
      phones: draft.phones.filter(
        phone => phone.label.trim() !== '' || phone.number.trim() !== ''
      )
    };
    const result =
      draft.id === null
        ? await run<Contact>('contacts.create', input, {
            success: 'calls.book.created',
            successParams: { name: draft.displayName },
            quietErrors: true
          })
        : await run<Contact>(
            'contacts.update',
            { id: draft.id, ...input },
            {
              success: 'calls.book.updated',
              successParams: { name: draft.displayName },
              quietErrors: true
            }
          );
    saving = false;
    if (result.ok) {
      highlight(result.value.id);
      editing = false;
      errors = {};
    } else {
      errors = { [result.error.field ?? '_']: errorText(result.error) };
    }
  }

  const sectionOptions = $derived([
    { value: 'all' as const, label: t('common.all') },
    { value: 'contacts' as const, label: t('calls.book.contacts') },
    { value: 'team' as const, label: t('calls.book.team') },
    { value: 'groups' as const, label: t('calls.book.groups') }
  ]);
</script>

<PageHeader title={t('nav.phonebook')} subtitle={t('calls.book.subtitle')}>
  {#snippet actions()}
    {#if canEdit}
      <Button
        variant="primary"
        icon={Plus}
        op="contacts.create"
        onclick={openNew}>{t('calls.book.add')}</Button
      >
    {/if}
  {/snippet}
</PageHeader>

<div class="toolbar">
  <div class="search">
    <TextInput
      id="phonebook-search"
      type="search"
      bind:value={query}
      placeholder={t('calls.book.search')}
    />
  </div>
  <Segmented
    bind:value={section}
    options={sectionOptions}
    size="sm"
    ariaLabel={t('calls.book.section')}
  />
</div>

{#if nothing}
  <EmptyState
    icon={SearchX}
    title={t('calls.book.noMatch')}
    body={t('calls.book.noMatchBody')}
  />
{/if}

<div class="stack" style="--gap: var(--space-5)">
  {#if (section === 'all' || section === 'contacts') && shownContacts.length > 0}
    <Card title={t('calls.book.contacts')} icon={BookUser} padded={false}>
      <ul class="entries">
        {#each shownContacts as contact (contact.id)}
          <li class:flash={router.highlight === contact.id}>
            <Avatar name={contact.displayName} size={40} />
            <div class="info">
              <span class="name">{contact.displayName}</span>
              <span class="sub">
                {#if contact.company && contact.company !== contact.displayName}<span
                    class="row"
                    style="--gap: 4px"
                    ><Building2 size={12} />{contact.company}</span
                  >{/if}
                {#if contact.email}<a
                    class="row"
                    style="--gap: 4px"
                    href="mailto:{contact.email}"
                    ><Mail size={12} />{contact.email}</a
                  >{/if}
              </span>
              {#if isExpert()}<code class="xs faint">{contact.id}</code>{/if}
            </div>
            <div class="phones">
              {#each contact.phones as phone (phone.number)}
                <button
                  type="button"
                  class="phone"
                  onclick={() => dial(phone.number)}
                  title={t('calls.book.callNumber', {
                    number: formatPhone(phone.number)
                  })}
                >
                  <Phone size={14} />
                  <span class="xs muted">{phone.label}</span>
                  <span class="mono small">{formatPhone(phone.number)}</span>
                </button>
              {/each}
            </div>
            {#if canEdit}
              <Menu
                label={t('common.actions')}
                items={[
                  {
                    label: t('common.edit'),
                    icon: Pencil,
                    op: 'contacts.update',
                    onclick: () => openEdit(contact)
                  },
                  {
                    label: t('common.delete'),
                    icon: Trash2,
                    danger: true,
                    op: 'contacts.delete',
                    onclick: () =>
                      void run(
                        'contacts.delete',
                        { id: contact.id },
                        { success: 'calls.book.deleted' }
                      )
                  }
                ]}
              />
            {/if}
          </li>
        {/each}
      </ul>
    </Card>
  {/if}

  {#if (section === 'all' || section === 'team') && team.length > 0}
    <Card title={t('calls.book.team')} icon={Users} padded={false}>
      <ul class="entries compact">
        {#each team as user (user.id)}
          <li>
            <Avatar name={user.name} size={36} status={presenceOf(user.id)} />
            <div class="info">
              <span class="name"
                >{user.name}{user.id === actor.id
                  ? ` · ${t('calls.live.you')}`
                  : ''}</span
              >
              <span class="sub"
                ><Presence status={presenceOf(user.id)} label size={7} /></span
              >
            </div>
            <span class="ext nums">{user.extension}</span>
            {#if user.id !== actor.id && user.extension}
              <IconButton
                icon={Phone}
                variant="soft"
                label={t('calls.book.callNumber', { number: user.extension })}
                onclick={() => dial(user.extension ?? '')}
              />
            {:else}
              <span class="spacer"></span>
            {/if}
          </li>
        {/each}
      </ul>
    </Card>
  {/if}

  {#if (section === 'all' || section === 'groups') && groups.length > 0}
    <Card title={t('calls.book.groups')} icon={RadioTower} padded={false}>
      <ul class="entries compact">
        {#each groups as group (group.id)}
          {@const members = ringGroupMembers(store.db, group)}
          <li>
            <span class="glyph"><RadioTower size={18} /></span>
            <div class="info">
              <span class="name">{group.name}</span>
              <span class="sub"
                >{t('calls.book.members', {
                  count: members.length,
                  available: members.filter(
                    id => presenceOf(id) === 'available'
                  ).length
                })}</span
              >
            </div>
            <span class="ext nums">{group.ext}</span>
            <IconButton
              icon={Phone}
              variant="soft"
              label={t('calls.book.callNumber', { number: group.ext })}
              onclick={() => dial(group.ext)}
            />
          </li>
        {/each}
      </ul>
    </Card>
  {/if}
</div>

<Drawer
  open={editing}
  title={draft.id ? t('calls.book.edit') : t('calls.book.add')}
  onclose={() => (editing = false)}
>
  {#if editing}
    <div class="stack">
      <FormField
        entity="contact"
        key="displayName"
        error={errors.displayName ?? null}
        required
      >
        {#snippet children(editable)}
          {#if editable}
            <TextInput
              id="contact-displayName"
              bind:value={draft.displayName}
              invalid={errors.displayName !== undefined}
              placeholder={t('calls.book.namePlaceholder')}
            />
          {:else}
            <DisplayValue>{draft.displayName}</DisplayValue>
          {/if}
        {/snippet}
      </FormField>
      <FormField entity="contact" key="company">
        <TextInput id="contact-company" bind:value={draft.company} />
      </FormField>
      <FormField entity="contact" key="email" error={errors.email ?? null}>
        <TextInput
          id="contact-email"
          type="email"
          bind:value={draft.email}
          invalid={errors.email !== undefined}
        />
      </FormField>
      <FormField
        entity="contact"
        key="phones"
        error={Object.entries(errors).find(([key]) =>
          key.startsWith('phones')
        )?.[1] ?? null}
      >
        <div class="phone-rows">
          {#each draft.phones as phone, index (index)}
            <div class="phone-row">
              <TextInput
                id="contact-phone-label-{index}"
                bind:value={phone.label}
                placeholder={t('calls.book.labelPlaceholder')}
                invalid={errors[`phones.${index}.label`] !== undefined}
              />
              <TextInput
                id="contact-phone-number-{index}"
                type="tel"
                mono
                bind:value={phone.number}
                placeholder="089 1234567"
                invalid={errors[`phones.${index}.number`] !== undefined}
              />
              <IconButton
                icon={X}
                label={t('common.remove')}
                onclick={() => draft.phones.splice(index, 1)}
              />
            </div>
          {/each}
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            onclick={() => draft.phones.push({ label: '', number: '' })}
            >{t('calls.book.addPhone')}</Button
          >
        </div>
      </FormField>
      {#if errors._}<p class="error small">{errors._}</p>{/if}
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editing = false)}
      >{t('common.cancel')}</Button
    >
    <Button
      variant="primary"
      loading={saving}
      op={draft.id ? 'contacts.update' : 'contacts.create'}
      onclick={save}>{draft.id ? t('common.save') : t('common.create')}</Button
    >
  {/snippet}
</Drawer>

<style>
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    margin-bottom: var(--space-4);
  }
  .search {
    flex: 1 1 280px;
    max-width: 440px;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .entries li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--line);
  }
  .entries li:last-child {
    border-bottom: 0;
  }
  .entries.compact li {
    padding: 10px var(--space-5);
  }
  .info {
    flex: 1 1 200px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    font-weight: 700;
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    gap: 2px var(--space-3);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .phones {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: flex-end;
  }
  .phone {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    transition:
      border-color 0.15s var(--ease),
      background 0.15s var(--ease);
  }
  .phone:hover {
    border-color: var(--primary);
    background: var(--primary-soft);
    color: var(--primary);
  }
  .ext {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-lg);
    color: var(--text-muted);
    min-width: 40px;
    text-align: right;
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--primary-soft);
    color: var(--primary);
    flex: none;
  }
  .spacer {
    width: 36px;
    flex: none;
  }
  .phone-rows {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
  }
  .phone-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
    gap: var(--space-2);
    align-items: center;
    width: 100%;
  }
  .error {
    color: var(--danger);
  }
  @media (max-width: 640px) {
    .entries li,
    .entries.compact li {
      flex-wrap: wrap;
      padding: var(--space-3) var(--space-4);
    }
    .phones {
      flex-basis: 100%;
      justify-content: flex-start;
      padding-left: calc(40px + var(--space-3));
    }
    .entries.compact li {
      flex-wrap: nowrap;
    }
  }
</style>
