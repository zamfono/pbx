<!--
  User groups (`userGroups.*`, admin): named sets of people, nestable, that ring groups ring and
  outbound routes pick callers by. A group that would contain itself through nesting is refused.
  Deleting never blocks: ring groups and routes skip a deleted group.
-->
<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import Route from '@lucide/svelte/icons/route';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import User from '@lucide/svelte/icons/user';
  import UsersRound from '@lucide/svelte/icons/users-round';
  import { page } from '$app/state';
  import { untrack } from 'svelte';

  import { read, run } from '#lib/actions.svelte.js';
  import { liveRingGroups, userById } from '#lib/api/lookup.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { Member, UserGroup } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import MemberPicker from '#lib/components/MemberPicker.svelte';
  import { fieldErrors } from '#lib/components/people/people.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import { go, highlight, href } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const params = $derived(page.params as Record<string, string>);

  const groups = $derived(
    read<{ items: UserGroup[] }>('userGroups.list', {}, { items: [] }).items
  );
  const byId = $derived(new Map(groups.map(group => [group.id, group])));

  /** Everyone a group reaches, through nested groups too. */
  function people(group: UserGroup, seen = new Set<string>()): Set<string> {
    const out = new Set<string>();
    seen.add(group.id);
    for (const member of group.members) {
      if (member.kind === 'user') {
        out.add(member.id);
      } else if (!seen.has(member.id)) {
        const child = byId.get(member.id);
        if (child !== undefined) {
          for (const id of people(child, seen)) {
            out.add(id);
          }
        }
      }
    }
    return out;
  }

  type Use = {
    kind: 'ringGroup' | 'route' | 'userGroup';
    id: string;
    label: string;
    path: string;
  };

  /** Where a group is named: ring groups, outbound routes' caller lists, parent groups. */
  function usesOf(groupId: string): Use[] {
    return [
      ...liveRingGroups()
        .filter(group =>
          group.members.some(
            member => member.kind === 'userGroup' && member.id === groupId
          )
        )
        .map(group => ({
          kind: 'ringGroup' as const,
          id: group.id,
          label: group.name,
          path: `/ring-groups/${group.id}`
        })),
      ...store.db.outboundRoutes
        .filter(route => route.userGroups.includes(groupId))
        .map((route, index) => ({
          kind: 'route' as const,
          id: route.id,
          label: t('people.groups.route', { n: index + 1 }),
          path: '/outbound-routes'
        })),
      ...groups
        .filter(parent =>
          parent.members.some(
            member => member.kind === 'userGroup' && member.id === groupId
          )
        )
        .map(parent => ({
          kind: 'userGroup' as const,
          id: parent.id,
          label: parent.name,
          path: `/user-groups/${parent.id}`
        }))
    ];
  }
  const USE_ICON = {
    ringGroup: RadioTower,
    route: Route,
    userGroup: UsersRound
  };

  const columns = $derived([
    { key: 'name', label: t('field.userGroup.name'), primary: true },
    { key: 'members', label: t('field.userGroup.members') },
    { key: 'used', label: t('people.groups.usedBy') },
    ...(isExpert()
      ? [{ key: 'id', label: t('common.id'), hideOnMobile: true }]
      : []),
    { key: 'actions', label: '', align: 'right' as const, width: '60px' }
  ]);

  /* ---------------- edit drawer ---------------- */

  const editingId = $derived(params.id ?? null);
  const editingGroup = $derived(
    editingId === null || editingId === 'new' ? undefined : byId.get(editingId)
  );
  let creating = $state(false);
  const open = $derived(creating || editingGroup !== undefined);
  let errors = $state<Record<string, string>>({});

  /** The draft loads when the drawer opens for a group (the route changes), not on every store
   * change while someone edits it. */
  let draft = $derived.by<{ name: string; members: Member[] }>(() => {
    const id = editingId;
    return untrack(() => {
      const target = id === null ? undefined : byId.get(id);
      return {
        name: target?.name ?? '',
        members: (target?.members ?? []).map(member => ({ ...member }))
      };
    });
  });

  function openCreate(): void {
    draft = { name: '', members: [] };
    errors = {};
    creating = true;
  }

  function close(): void {
    creating = false;
    errors = {};
    if (editingId !== null) {
      go('/user-groups');
    }
  }

  async function save(): Promise<void> {
    const result =
      editingGroup === undefined
        ? await run<UserGroup>(
            'userGroups.create',
            { name: draft.name, members: draft.members },
            {
              success: 'people.groups.created',
              successParams: { name: draft.name },
              quietErrors: true
            }
          )
        : await run<UserGroup>(
            'userGroups.update',
            { id: editingGroup.id, name: draft.name, members: draft.members },
            {
              success: 'people.groups.saved',
              successParams: { name: draft.name },
              quietErrors: true
            }
          );
    if (!result.ok) {
      errors = fieldErrors(result.error, '_');
      return;
    }
    highlight(result.value.id);
    close();
  }

  async function remove(group: UserGroup): Promise<void> {
    const result = await run(
      'userGroups.delete',
      { id: group.id },
      { success: 'people.groups.deleted', successParams: { name: group.name } }
    );
    if (result.ok && editingId !== null) {
      close();
    }
  }
</script>

<PageHeader title={t('nav.userGroups')} subtitle={t('people.groups.subtitle')}>
  {#snippet actions()}
    <Button
      variant="primary"
      icon={Plus}
      op="userGroups.create"
      onclick={openCreate}>{t('people.groups.add')}</Button
    >
  {/snippet}
</PageHeader>

<DataTable
  rows={groups}
  {columns}
  rowKey={row => row.id}
  caption={t('nav.userGroups')}
  onRowClick={row => go(`/user-groups/${row.id}`)}
>
  {#snippet cell(row, key)}
    {#if key === 'name'}
      <span class="name">
        <span class="glyph" aria-hidden="true"><UsersRound size={16} /></span>
        <span class="strong">{row.name}</span>
      </span>
    {:else if key === 'members'}
      {@const reach = [...people(row)]}
      {@const nested = row.members.filter(
        member => member.kind === 'userGroup'
      )}
      <span class="members">
        <span class="faces" aria-hidden="true">
          {#each reach.slice(0, 4) as id (id)}
            <Avatar name={userById(id)?.name ?? '?'} size={24} />
          {/each}
        </span>
        <span class="small">
          {t('people.groups.peopleCount', { n: reach.length })}
          {#if nested.length > 0}
            <span class="muted"
              >· {t('people.groups.nestedCount', { n: nested.length })}</span
            >
          {/if}
        </span>
      </span>
    {:else if key === 'used'}
      {@const uses = usesOf(row.id)}
      {#if uses.length === 0}
        <span class="faint small">{t('people.groups.unused')}</span>
      {:else}
        <span class="uses">
          {#each uses as use (`${use.kind}:${use.id}`)}
            {@const Glyph = USE_ICON[use.kind]}
            <a
              class="use"
              href={href(use.path)}
              onclick={event => event.stopPropagation()}
              ><Glyph size={12} /> {use.label}</a
            >
          {/each}
        </span>
      {/if}
    {:else if key === 'id'}
      <code class="xs faint row-id" title={row.id}>{row.id}</code>
    {:else if key === 'actions'}
      <IconButton
        icon={Trash2}
        variant="danger"
        label={t('common.delete')}
        onclick={event => {
          event.stopPropagation();
          void remove(row);
        }}
      />
    {/if}
  {/snippet}
  {#snippet empty()}
    <EmptyState
      icon={UsersRound}
      title={t('people.groups.empty')}
      body={t('people.groups.emptyBody')}
    />
  {/snippet}
</DataTable>

<Drawer
  {open}
  title={editingGroup === undefined
    ? t('people.groups.add')
    : editingGroup.name}
  subtitle={t('people.groups.drawerIntro')}
  onclose={close}
>
  <div class="stack">
    <FormField
      entity="userGroup"
      key="name"
      error={errors.name ?? null}
      required
    >
      {#snippet children()}
        <TextInput
          id="userGroup-name"
          value={draft.name}
          placeholder={t('people.groups.namePlaceholder')}
          oninput={name => (draft = { ...draft, name })}
          invalid={errors.name !== undefined}
        />
      {/snippet}
    </FormField>
    <FormField entity="userGroup" key="members" error={errors.members ?? null}>
      {#snippet children()}
        <MemberPicker
          id="userGroup-members"
          members={draft.members}
          requireExtension={false}
          excludeGroupId={editingGroup?.id}
          onchange={members => (draft = { ...draft, members })}
        />
      {/snippet}
    </FormField>
    {#if editingGroup !== undefined}
      {@const uses = usesOf(editingGroup.id)}
      {#if uses.length > 0}
        <div class="used-box">
          <span class="xs strong muted caps">{t('people.groups.usedBy')}</span>
          <ul>
            {#each uses as use (`${use.kind}:${use.id}`)}
              {@const Glyph = USE_ICON[use.kind]}
              <li>
                <Glyph size={14} /> <a href={href(use.path)}>{use.label}</a>
                <Badge tone="neutral"
                  >{t(`people.groups.use.${use.kind}`)}</Badge
                >
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      <p class="small muted reach">
        <User size={14} />
        {t('people.groups.reach', {
          n: people({ ...editingGroup, members: draft.members }).size
        })}
      </p>
    {/if}
    {#if errors._}<p class="form-error" role="alert">{errors._}</p>{/if}
  </div>
  {#snippet footer()}
    {#if editingGroup !== undefined}
      {@const group = editingGroup}
      <Button
        variant="danger"
        icon={Trash2}
        op="userGroups.delete"
        onclick={() => remove(group)}>{t('common.delete')}</Button
      >
      <span class="grow"></span>
    {/if}
    <Button variant="ghost" onclick={close}>{t('common.cancel')}</Button>
    <Button
      variant="primary"
      op={editingGroup === undefined
        ? 'userGroups.create'
        : 'userGroups.update'}
      onclick={save}
    >
      {editingGroup === undefined ? t('common.create') : t('common.save')}
    </Button>
  {/snippet}
</Drawer>

<style>
  .row-id {
    display: inline-block;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: var(--radius-sm);
    background: var(--primary-soft);
    color: var(--primary);
  }
  .members {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .faces {
    display: inline-flex;
  }
  .faces :global(.avatar:not(:first-child)) {
    margin-left: -8px;
    box-shadow: 0 0 0 2px var(--surface);
  }
  .uses {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .use {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    font-weight: 700;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    background: var(--surface-3);
    color: var(--text);
  }
  .use:hover {
    text-decoration: none;
    background: var(--primary-soft);
    color: var(--primary);
  }
  .used-box {
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--line);
  }
  .used-box ul {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .used-box li {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
  }
  .caps {
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .reach {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .form-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 700;
  }
</style>
