<!--
  The consent step an MCP client's sign-in reaches after the person authenticated: it names the
  client and where it returns to. The client then acts as this person with the role they hold at
  each request (§5.3) — OAuth scopes do not narrow it — and every change it makes carries its name
  in the audit log. Demo: both answers return to the app with a toast.
-->
<script lang="ts">
  import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
  import Bot from '@lucide/svelte/icons/bot';
  import Repeat from '@lucide/svelte/icons/repeat';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import UserCheck from '@lucide/svelte/icons/user-check';

  import { userById } from '#lib/api/lookup.js';
  import { store } from '#lib/api/store.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Logo from '#lib/shell/Logo.svelte';
  import { go } from '#lib/state/router.svelte.js';
  import { personaUserId, session, signIn } from '#lib/state/session.svelte.js';
  import { toast } from '#lib/state/ui.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Button from '#lib/ui/Button.svelte';
  import RoleChip from '#lib/ui/RoleChip.svelte';

  const CLIENT = 'Claude Code';
  const REDIRECT_URI = 'http://127.0.0.1:53682/callback';

  const me = $derived(userById(personaUserId(session.persona)));
  const company = $derived(store.db.settings.companyName);
  const shortCompany = $derived(
    company.split(/\s+(?=Steuerberatung|GmbH|AG|KG)/u)[0] ?? company
  );

  function answer(approved: boolean): void {
    if (!session.signedIn) {
      signIn(session.persona);
    }
    toast({
      tone: approved ? 'success' : 'info',
      title: approved
        ? t('auth.consent.approved', { client: CLIENT })
        : t('auth.consent.denied', { client: CLIENT })
    });
    go('/overview');
  }
</script>

<div class="link-art" aria-hidden="true">
  <span class="tile client"><Bot size={26} /></span>
  <span class="arrows"><ArrowLeftRight size={18} /></span>
  <span class="tile zamfono"><Logo size={30} color="var(--lime)" /></span>
</div>

<header class="head">
  <h1>{t('auth.consent.title', { client: CLIENT, company: shortCompany })}</h1>
</header>

{#if me !== undefined}
  <div class="actor">
    <Avatar name={me.name} size={36} />
    <div class="actor-text">
      <span class="label">{t('auth.consent.actsAs')}</span>
      <span class="name"
        ><strong>{me.name}</strong> <RoleChip role={me.role} /></span
      >
    </div>
  </div>
{/if}

<div class="can">
  <h2>{t('auth.consent.canTitle', { client: CLIENT })}</h2>
  <ul>
    <li>
      <span class="dot"><UserCheck size={16} /></span><span
        >{t(`auth.consent.can.${me?.role ?? 'user'}`)}</span
      >
    </li>
    <li>
      <span class="dot"><Repeat size={16} /></span><span
        >{t('auth.consent.can.role', { client: CLIENT })}</span
      >
    </li>
    <li>
      <span class="dot"><ScrollText size={16} /></span><span
        >{t('auth.consent.can.audit', { client: CLIENT })}</span
      >
    </li>
  </ul>
</div>

<p class="redirect">{t('auth.consent.redirect')} <code>{REDIRECT_URI}</code></p>

<div class="buttons">
  <Button variant="secondary" size="lg" onclick={() => answer(false)}
    >{t('auth.consent.deny')}</Button
  >
  <Button variant="primary" size="lg" onclick={() => answer(true)}
    >{t('auth.consent.approve')}</Button
  >
</div>

<style>
  .link-art {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .tile {
    display: grid;
    place-items: center;
    width: 54px;
    height: 54px;
    border-radius: 16px;
  }
  .client {
    background: var(--mucki-soft);
    color: var(--mucki-text);
    transform: rotate(-5deg);
  }
  .zamfono {
    background: var(--on-lime);
    transform: rotate(4deg);
  }
  .arrows {
    color: var(--text-faint);
  }
  .head h1 {
    font-size: var(--text-2xl);
    text-wrap: balance;
  }
  .actor {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--surface-3);
  }
  .actor-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .label {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .name {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .can {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .can h2 {
    font-size: var(--text-md);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  li {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    font-size: var(--text-sm);
  }
  .dot {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: 50%;
    background: var(--primary-soft);
    color: var(--primary);
  }
  .redirect {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .redirect code {
    word-break: break-all;
  }
  .buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }
</style>
