<!--
  An ordered list of members, each a user or a user group (`members.ts`): add, remove, reorder.
  Order matters for sequential ring groups.
-->
<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import User from '@lucide/svelte/icons/user';
  import UsersRound from '@lucide/svelte/icons/users-round';
  import X from '@lucide/svelte/icons/x';

  import {
    liveUserGroups,
    liveUsers,
    userById,
    userGroupById
  } from '#lib/api/lookup.js';
  import type { Member } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import IconButton from '#lib/ui/IconButton.svelte';
  import Select from '#lib/ui/Select.svelte';

  type Props = {
    members: Member[];
    onchange: (members: Member[]) => void;
    id?: string;
    ordered?: boolean;
    /** Only users with an extension can ring (ring groups); route callers may be any user. */
    requireExtension?: boolean;
    /** A user group that must not be offered (itself, to avoid a cycle). */
    excludeGroupId?: string;
    disabled?: boolean;
  };

  let {
    members,
    onchange,
    id = 'members',
    ordered = false,
    requireExtension = true,
    excludeGroupId,
    disabled = false
  }: Props = $props();

  const key = (member: Member): string => `${member.kind}:${member.id}`;
  const taken = $derived(new Set(members.map(key)));
  const candidates = $derived([
    ...liveUsers()
      .filter(user => !requireExtension || user.extension !== null)
      .filter(user => !taken.has(`user:${user.id}`))
      .map(user => ({
        value: `user:${user.id}`,
        label: `${user.name}${user.extension ? ` (${user.extension})` : ''}`
      })),
    ...liveUserGroups()
      .filter(
        group =>
          group.id !== excludeGroupId && !taken.has(`userGroup:${group.id}`)
      )
      .map(group => ({
        value: `userGroup:${group.id}`,
        label: `${t('members.group')}: ${group.name}`
      }))
  ]);
  let adding = $state<string>('');

  function move(index: number, delta: number): void {
    const next = [...members];
    const [item] = next.splice(index, 1);
    if (item !== undefined) {
      next.splice(index + delta, 0, item);
      onchange(next);
    }
  }
</script>

<div class="members">
  {#if members.length === 0}
    <p class="empty">{t('members.empty')}</p>
  {/if}
  <ol class:ordered>
    {#each members as member, index (key(member))}
      <li>
        {#if ordered}<span class="pos nums">{index + 1}</span>{/if}
        <span class="icon"
          >{#if member.kind === 'user'}<User size={14} />{:else}<UsersRound
              size={14}
            />{/if}</span
        >
        <span class="name grow truncate">
          {#if member.kind === 'user'}
            {userById(member.id)?.name ?? '—'}
            <span class="faint">{userById(member.id)?.extension ?? ''}</span>
          {:else}
            {userGroupById(member.id)?.name ?? '—'}
            <span class="faint">{t('members.group')}</span>
          {/if}
        </span>
        {#if !disabled}
          {#if ordered}
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
              disabled={index === members.length - 1}
              onclick={() => move(index, 1)}
            />
          {/if}
          <IconButton
            icon={X}
            size="sm"
            variant="danger"
            label={t('common.remove')}
            onclick={() =>
              onchange(members.filter(other => key(other) !== key(member)))}
          />
        {/if}
      </li>
    {/each}
  </ol>
  {#if !disabled && candidates.length > 0}
    <Select
      id={`${id}-add`}
      value={adding}
      options={[{ value: '', label: t('members.add') }, ...candidates]}
      onchange={value => {
        if (value !== '') {
          const [kind, memberId] = value.split(':') as [
            'user' | 'userGroup',
            string
          ];
          onchange([...members, { kind, id: memberId }]);
          adding = '';
        }
      }}
    />
  {/if}
</div>

<style>
  .members {
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
    gap: 4px;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px 6px 6px 10px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .pos {
    font-size: var(--text-xs);
    font-weight: 800;
    color: var(--primary);
    width: 16px;
  }
  .icon {
    color: var(--text-muted);
    display: grid;
  }
  .name {
    font-weight: 500;
  }
  .empty {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
</style>
