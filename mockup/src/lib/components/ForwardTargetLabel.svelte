<!--
  A forward target in words, with an icon and a link to what it points at.
-->
<script lang="ts">
  import Bot from '@lucide/svelte/icons/bot';
  import CircleDot from '@lucide/svelte/icons/circle-dot';
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import PhoneForwarded from '@lucide/svelte/icons/phone-forwarded';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import User from '@lucide/svelte/icons/user';
  import Voicemail from '@lucide/svelte/icons/voicemail';
  import Workflow from '@lucide/svelte/icons/workflow';

  import {
    audioById,
    menuById,
    ringGroupById,
    trunkById,
    userById
  } from '#lib/api/lookup.js';
  import type { ForwardTarget } from '#lib/api/types.js';
  import { formatPhone, t } from '#lib/i18n/index.svelte.js';
  import { href } from '#lib/state/router.svelte.js';

  let {
    target,
    link = true,
    nullLabel
  }: {
    target: ForwardTarget | null;
    link?: boolean;
    nullLabel?: string;
  } = $props();

  const view = $derived.by(() => {
    if (target === null) {
      return {
        icon: CircleDot,
        text: nullLabel ?? t('target.none'),
        path: null as string | null,
        recorded: false
      };
    }
    switch (target.kind) {
      case 'user': {
        const user = userById(target.userId);
        return {
          icon: User,
          text: user
            ? `${user.name}${user.extension ? ` (${user.extension})` : ''}`
            : '—',
          path: `/users/${target.userId}`,
          recorded: false
        };
      }
      case 'ringGroup': {
        const group = ringGroupById(target.ringGroupId);
        return {
          icon: RadioTower,
          text: group ? `${group.name} (${group.ext})` : '—',
          path: `/ring-groups/${target.ringGroupId}`,
          recorded: false
        };
      }
      case 'external':
        return {
          icon: PhoneForwarded,
          text: formatPhone(target.external),
          path: null,
          recorded: target.record
        };
      case 'sip': {
        const trunk = trunkById(target.trunkId);
        return {
          icon: Bot,
          text: `SIP ${target.user} @ ${trunk?.name ?? '—'}`,
          path: `/trunks/${target.trunkId}`,
          recorded: target.record
        };
      }
      case 'mailboxUser':
        return {
          icon: Voicemail,
          text: t('target.mailboxOf', {
            name: userById(target.userId)?.name ?? '—'
          }),
          path: `/users/${target.userId}`,
          recorded: false
        };
      case 'mailboxRingGroup':
        return {
          icon: Voicemail,
          text: t('target.mailboxOf', {
            name: ringGroupById(target.ringGroupId)?.name ?? '—'
          }),
          path: `/ring-groups/${target.ringGroupId}`,
          recorded: false
        };
      case 'announcement':
        return {
          icon: Megaphone,
          text: audioById(target.audioId)?.label ?? '—',
          path: '/audio',
          recorded: false
        };
      case 'menu':
        return {
          icon: Workflow,
          text: menuById(target.menuId)?.name ?? '—',
          path: `/menus/${target.menuId}`,
          recorded: false
        };
    }
  });
  const Glyph = $derived(view.icon);
</script>

<span class="target">
  <span class="icon"><Glyph size={14} /></span>
  {#if link && view.path}
    <a href={href(view.path)} onclick={event => event.stopPropagation()}
      >{view.text}</a
    >
  {:else}
    <span>{view.text}</span>
  {/if}
  {#if target}<span class="kind">{t(`target.kind.${target.kind}`)}</span>{/if}
  {#if view.recorded}<span class="rec" title={t('target.recorded')}>REC</span
    >{/if}
</span>

<style>
  .target {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text-muted);
    flex: none;
  }
  .kind {
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  .rec {
    font-size: 9.5px;
    font-weight: 800;
    color: #fff;
    background: var(--danger);
    border-radius: 4px;
    padding: 1px 4px;
  }
</style>
