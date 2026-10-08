<!--
  My settings (`/me/:tab?`, every role): the signed-in person's own record. A `user` changes the
  self-service fields (`users/_updateAccess.ts`), their forwarding, presence, greeting, schedule,
  own `tls` devices and tokens; everything else of theirs shows as plain text.
-->
<script lang="ts">
  import CalendarClock from '@lucide/svelte/icons/calendar-clock';
  import FileAudio from '@lucide/svelte/icons/file-audio';
  import KeySquare from '@lucide/svelte/icons/key-square';
  import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
  import PhoneForwarded from '@lucide/svelte/icons/phone-forwarded';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import UserRound from '@lucide/svelte/icons/user-round';
  import { page } from '$app/state';

  import { read } from '#lib/actions.svelte.js';
  import { presenceOf } from '#lib/api/lookup.js';
  import type { User } from '#lib/api/types.js';
  import DeviceList from '#lib/components/people/DeviceList.svelte';
  import ForwardingEditor from '#lib/components/people/ForwardingEditor.svelte';
  import GreetingPanel from '#lib/components/people/GreetingPanel.svelte';
  import PresenceCard from '#lib/components/people/PresenceCard.svelte';
  import TokenList from '#lib/components/people/TokenList.svelte';
  import UserProfileForm from '#lib/components/people/UserProfileForm.svelte';
  import ScopeSchedule from '#lib/components/schedule-scope/ScopeSchedule.svelte';
  import SecurityPanel from '#lib/components/security/SecurityPanel.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import { href } from '#lib/state/router.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Badge from '#lib/ui/Badge.svelte';
  import RoleChip from '#lib/ui/RoleChip.svelte';
  import Tabs from '#lib/ui/Tabs.svelte';

  const params = $derived(page.params as Record<string, string>);

  const actor = $derived(currentActor());
  const me = $derived(
    read<User | undefined>('users.get', { id: actor.id }, undefined)
  );

  const tabs = $derived([
    { id: 'profile', label: t('people.tab.profile'), icon: UserRound },
    {
      id: 'forwarding',
      label: t('people.tab.forwarding'),
      icon: PhoneForwarded
    },
    { id: 'greeting', label: t('people.tab.greeting'), icon: FileAudio },
    { id: 'schedule', label: t('people.tab.schedule'), icon: CalendarClock },
    { id: 'devices', label: t('people.tab.devices'), icon: MonitorSmartphone },
    { id: 'tokens', label: t('people.tab.tokens'), icon: KeySquare },
    { id: 'security', label: t('people.tab.security'), icon: ShieldCheck }
  ]);
  const active = $derived(
    tabs.some(tab => tab.id === params.tab) ? (params.tab as string) : 'profile'
  );
</script>

{#if me !== undefined}
  <header class="hero">
    <Avatar
      name={me.name}
      size={56}
      status={me.extension === null ? undefined : presenceOf(me.id)}
    />
    <div class="who">
      <h1>{me.name}</h1>
      <div class="row" style="--gap: 6px">
        <RoleChip role={me.role} />
        {#if me.extension}<Badge tone="primary"
            >{t('people.ext', { ext: me.extension })}</Badge
          >{/if}
        {#if me.email}<span class="small muted truncate">{me.email}</span>{/if}
        {#if isExpert()}<code class="xs faint">{me.id}</code>{/if}
      </div>
    </div>
  </header>

  <Tabs {tabs} {active} hrefFor={id => href(`/me/${id}`)} />

  {#if active === 'profile'}
    <div class="profile">
      {#if me.extension !== null}
        <PresenceCard user={me} />
      {/if}
      <UserProfileForm user={me} />
    </div>
  {:else if active === 'forwarding'}
    <p class="intro small muted">{t('people.me.forwardingIntro')}</p>
    <ForwardingEditor userId={me.id} />
  {:else if active === 'greeting'}
    <GreetingPanel user={me} />
  {:else if active === 'schedule'}
    <ScopeSchedule scope={{ kind: 'user', id: me.id }} />
  {:else if active === 'devices'}
    <p class="intro small muted">{t('people.me.devicesIntro')}</p>
    <DeviceList userId={me.id} />
  {:else if active === 'tokens'}
    <TokenList userId={me.id} />
  {:else if active === 'security'}
    <SecurityPanel />
  {/if}
{/if}

<style>
  .hero {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  .who {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h1 {
    margin: 0;
  }
  .profile {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .intro {
    margin: 0 0 var(--space-4);
    max-width: 70ch;
  }
  @media (max-width: 560px) {
    .hero {
      gap: var(--space-3);
    }
    h1 {
      font-size: var(--text-2xl);
    }
  }
</style>
