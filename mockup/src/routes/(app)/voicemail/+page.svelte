<!--
  Voicemail: the messages of the person's own mailbox and of the ring groups they belong to
  (admins: every mailbox) — `voicemails.list`, played through `voicemails.audio`, marked read or
  unread (`voicemails.markRead`, not audited), deleted for good (`voicemails.delete`).
-->
<script lang="ts">
  import Inbox from '@lucide/svelte/icons/inbox';
  import MailCheck from '@lucide/svelte/icons/mail-check';
  import MailOpen from '@lucide/svelte/icons/mail-open';
  import Phone from '@lucide/svelte/icons/phone';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import User from '@lucide/svelte/icons/user';
  import VoicemailIcon from '@lucide/svelte/icons/voicemail';

  import { read, run } from '#lib/actions.svelte.js';
  import { ringGroupsOf } from '#lib/api/events.svelte.js';
  import { liveRingGroups, ringGroupById, userById } from '#lib/api/lookup.js';
  import type { Page } from '#lib/api/ops/areas/calls.js';
  import type {
    AudioOut,
    VoicemailOut
  } from '#lib/api/ops/areas/voicemails.js';
  import { store } from '#lib/api/store.svelte.js';
  import { partyName } from '#lib/components/calls/labels.js';
  import PartyLabel from '#lib/components/calls/PartyLabel.svelte';
  import {
    formatDateTime,
    formatDuration,
    formatRelative,
    t
  } from '#lib/i18n/index.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import AudioPlayer from '#lib/ui/AudioPlayer.svelte';
  import Button from '#lib/ui/Button.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Tabs from '#lib/ui/Tabs.svelte';

  const actor = $derived(currentActor());
  const items = $derived(
    read<Page<VoicemailOut>>(
      'voicemails.list',
      { limit: 200 },
      { items: [], nextCursor: null }
    ).items
  );

  const mailboxKey = (vm: VoicemailOut): string =>
    vm.mailboxUserId !== null
      ? `u:${vm.mailboxUserId}`
      : `g:${vm.mailboxRingGroupId ?? ''}`;

  const mailboxes = $derived.by(() => {
    const keys: string[] = [`u:${actor.id}`];
    const groups =
      actor.role === 'user'
        ? ringGroupsOf(store.db, actor.id)
        : liveRingGroups().map(group => group.id);
    for (const id of groups) {
      if (
        ringGroupById(id)?.mailboxEnabled === true ||
        items.some(vm => vm.mailboxRingGroupId === id)
      ) {
        keys.push(`g:${id}`);
      }
    }
    for (const vm of items) {
      const key = mailboxKey(vm);
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
    return keys.map(key => {
      const [kind, id = ''] = key.split(':');
      const own = key === `u:${actor.id}`;
      const label = own
        ? t('calls.vm.own')
        : kind === 'u'
          ? (userById(id)?.name ?? '—')
          : (ringGroupById(id)?.name ?? '—');
      return {
        key,
        label,
        kind,
        unread: items.filter(vm => mailboxKey(vm) === key && !vm.read).length
      };
    });
  });

  let tab = $state('all');
  const tabs = $derived([
    {
      id: 'all',
      label: t('calls.vm.all'),
      icon: Inbox,
      count: items.filter(vm => !vm.read).length || undefined
    },
    ...mailboxes.map(box => ({
      id: box.key,
      label: box.label,
      icon: box.kind === 'g' ? RadioTower : User,
      count: box.unread || undefined
    }))
  ]);
  const shown = $derived(
    tab === 'all' ? items : items.filter(vm => mailboxKey(vm) === tab)
  );
  const unreadShown = $derived(shown.filter(vm => !vm.read).length);

  let openId = $state<string | null>(null);
  const audio = $derived(
    openId === null
      ? null
      : read<AudioOut | null>('voicemails.audio', { id: openId }, null)
  );

  function mailboxLabel(vm: VoicemailOut): string {
    return mailboxes.find(box => box.key === mailboxKey(vm))?.label ?? '—';
  }

  function markRead(vm: VoicemailOut, value: boolean): void {
    void run('voicemails.markRead', { id: vm.id, read: value });
  }

  async function remove(vm: VoicemailOut): Promise<void> {
    const result = await run(
      'voicemails.delete',
      { id: vm.id },
      { success: 'calls.vm.deleted' }
    );
    if (result.ok && openId === vm.id) {
      openId = null;
    }
  }

  async function markAllRead(): Promise<void> {
    for (const vm of shown.filter(candidate => !candidate.read)) {
      await run('voicemails.markRead', { id: vm.id, read: true });
    }
  }
</script>

<PageHeader
  title={t('nav.voicemail')}
  subtitle={t(
    actor.role === 'user' ? 'calls.vm.subtitleUser' : 'calls.vm.subtitleAdmin'
  )}
>
  {#snippet actions()}
    {#if unreadShown > 0}
      <Button icon={MailCheck} op="voicemails.markRead" onclick={markAllRead}
        >{t('calls.vm.markAllRead')}</Button
      >
    {/if}
  {/snippet}
</PageHeader>

<Tabs {tabs} active={tab} onSelect={id => (tab = id)} />

<div class="list">
  {#each shown as vm (vm.id)}
    {@const open = openId === vm.id}
    <article class="vm" class:unread={!vm.read} class:open>
      <button
        type="button"
        class="head"
        aria-expanded={open}
        onclick={() => (openId = open ? null : vm.id)}
      >
        <span
          class="dot"
          aria-label={vm.read ? undefined : t('calls.vm.unread')}
        ></span>
        <span class="who"
          ><PartyLabel value={vm.caller} size={38} secondary="detail" /></span
        >
        <span class="meta">
          <span class="time" title={formatDateTime(vm.createdAt)}
            >{formatRelative(vm.createdAt)}</span
          >
          <span class="length nums"
            ><VoicemailIcon size={13} /> {formatDuration(vm.durationS)}</span
          >
        </span>
      </button>
      {#if tab === 'all' && mailboxKey(vm) !== `u:${actor.id}`}
        <span class="box"
          >{t('calls.vm.inMailbox', { name: mailboxLabel(vm) })}</span
        >
      {/if}
      {#if open}
        <div class="body">
          <AudioPlayer
            clip={audio?.clip ?? null}
            durationS={vm.durationS}
            filename={audio?.filename}
            onplay={() => {
              if (!vm.read) {
                markRead(vm, true);
              }
            }}
          />
          <div class="actions">
            {#if vm.caller !== 'anonymous'}
              <Button
                size="sm"
                variant="primary"
                icon={Phone}
                op="calls.originate"
                onclick={() =>
                  run(
                    'calls.originate',
                    { target: vm.caller },
                    {
                      success: 'calls.dial.started',
                      successParams: { name: partyName(vm.caller) }
                    }
                  )}>{t('calls.callBack')}</Button
              >
            {/if}
            <Button
              size="sm"
              icon={vm.read ? MailOpen : MailCheck}
              op="voicemails.markRead"
              onclick={() => markRead(vm, !vm.read)}
              >{vm.read
                ? t('calls.vm.markUnread')
                : t('calls.vm.markRead')}</Button
            >
            <span class="grow"></span>
            <span class="xs faint"
              >{formatDateTime(vm.createdAt)}{isExpert()
                ? ` · ${vm.filename}`
                : ''}</span
            >
            <IconButton
              icon={Trash2}
              variant="danger"
              label={t('common.delete')}
              onclick={() => remove(vm)}
            />
          </div>
        </div>
      {/if}
    </article>
  {:else}
    <EmptyState
      icon={VoicemailIcon}
      title={t('calls.vm.empty')}
      body={t('calls.vm.emptyBody')}
    />
  {/each}
</div>

<style>
  .list {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-4);
    max-width: 860px;
  }
  .vm {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    transition: border-color 0.15s var(--ease);
  }
  .vm.open {
    border-color: var(--primary);
    box-shadow: var(--shadow-md);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
    background: transparent;
  }
  .unread .dot {
    background: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  .who {
    flex: 1;
    min-width: 0;
  }
  .unread .who :global(.name) {
    font-weight: 800;
  }
  .meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    flex: none;
  }
  .time {
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .unread .time {
    color: var(--primary);
  }
  .length {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .box {
    display: inline-block;
    margin: -6px 0 var(--space-3)
      calc(var(--space-4) + 9px + var(--space-3) + 38px + var(--space-3));
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--surface-3);
    border-radius: var(--radius-pill);
    padding: 2px 8px;
  }
  .body {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4) var(--space-4);
    border-top: 1px solid var(--line);
    background: var(--surface-2);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  @media (max-width: 520px) {
    .head {
      padding: var(--space-3);
    }
    .box {
      margin-left: calc(var(--space-3) * 3 + 9px + 38px);
    }
    .actions .grow {
      flex-basis: 100%;
      height: 0;
    }
  }
</style>
