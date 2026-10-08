<!--
  The person's own second factors on the security page (§5.2 "Two-factor authentication"):
  passkeys added (named) and removed, the authenticator app set up, replaced or removed, new
  recovery codes generated and shown once. Owners and admins — everyone once `mfaRequiredForAll`
  is set — cannot remove their last method. Each method set up or removed is mailed to the person.
-->
<script lang="ts">
  import FingerprintPattern from '@lucide/svelte/icons/fingerprint-pattern';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import LifeBuoy from '@lucide/svelte/icons/life-buoy';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import Trash from '@lucide/svelte/icons/trash';
  import X from '@lucide/svelte/icons/x';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import {
    RECOVERY_CODE_COUNT,
    type MfaChangeResult,
    type MfaStatus
  } from '#lib/api/ops/areas/auth.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { Passkey, User } from '#lib/api/types.js';
  import DemoAuthenticator from '#lib/components/auth/DemoAuthenticator.svelte';
  import { mfaChangedToast, newTotpSecret } from '#lib/components/auth/mfa.js';
  import PasskeyAdd from '#lib/components/auth/PasskeyAdd.svelte';
  import RecoveryCodes from '#lib/components/auth/RecoveryCodes.svelte';
  import TotpSetup from '#lib/components/auth/TotpSetup.svelte';
  import { formatDate, t } from '#lib/i18n/index.svelte.js';
  import { toast } from '#lib/state/ui.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';

  let { user }: { user: User } = $props();

  const fallback: MfaStatus = {
    totp: false,
    passkeys: [],
    recoveryCodesLeft: 0,
    required: false
  };
  const status = $derived(
    read<MfaStatus>('auth.status', { userId: user.id }, fallback)
  );
  const methodCount = $derived(status.passkeys.length + (status.totp ? 1 : 0));
  const lastRequired = $derived(status.required && methodCount === 1);
  const companyName = $derived(store.db.settings.companyName);
  const requiredWhy = $derived(
    user.role === 'owner' || user.role === 'admin'
      ? t(`security.requiredWhy.${user.role}`)
      : t('security.requiredWhy.all')
  );

  let codes = $state<string[] | null>(null);
  let setupSecret = $state<string | null>(null);
  let setupCode = $state('');
  let setupError = $state<string | null>(null);
  let busy = $state<string | null>(null);

  function issued(result: MfaChangeResult): void {
    if (result.codes !== null) {
      codes = result.codes;
    }
  }

  async function confirmTotp(code: string): Promise<void> {
    const replacing = status.totp;
    busy = 'totp';
    const result = await run<MfaChangeResult>(
      'auth.totpConfirm',
      { userId: user.id, secret: setupSecret ?? '', code },
      { quietErrors: true }
    );
    busy = null;
    if (!result.ok) {
      setupError = errorText(result.error);
      setupCode = '';
      return;
    }
    setupSecret = null;
    mfaChangedToast(
      replacing ? t('auth.toast.totpReplaced') : t('auth.toast.totpAdded'),
      user.email,
      'auth.totpConfirm'
    );
    issued(result.value);
  }

  async function removeTotp(): Promise<void> {
    busy = 'totpRemove';
    const result = await run('auth.totpRemove', { userId: user.id });
    busy = null;
    if (result.ok) {
      mfaChangedToast(
        t('auth.toast.totpRemoved'),
        user.email,
        'auth.totpRemove'
      );
    }
  }

  async function addPasskey(name: string): Promise<void> {
    busy = 'passkeyAdd';
    const result = await run<MfaChangeResult & { passkey: Passkey }>(
      'auth.passkeyAdd',
      { userId: user.id, name }
    );
    busy = null;
    if (result.ok) {
      mfaChangedToast(
        t('auth.toast.passkeyAdded', { name: result.value.passkey.name }),
        user.email,
        'auth.passkeyAdd'
      );
      issued(result.value);
    }
  }

  async function removePasskey(passkey: Passkey): Promise<void> {
    busy = passkey.id;
    const result = await run('auth.passkeyRemove', {
      userId: user.id,
      id: passkey.id
    });
    busy = null;
    if (result.ok) {
      mfaChangedToast(
        t('auth.toast.passkeyRemoved', { name: passkey.name }),
        user.email,
        'auth.passkeyRemove'
      );
    }
  }

  async function regenerate(): Promise<void> {
    busy = 'codes';
    const result = await run<{ codes: string[] }>('auth.recoveryCodes', {
      userId: user.id
    });
    busy = null;
    if (result.ok) {
      codes = result.value.codes;
      toast({
        tone: 'success',
        title: t('security.codes.regenerated'),
        operation: 'auth.recoveryCodes'
      });
    }
  }

  function startSetup(): void {
    setupSecret = newTotpSecret();
    setupCode = '';
    setupError = null;
  }
</script>

<div class="manage">
  {#if status.required}
    <div class="required">
      <ShieldAlert size={18} />
      <p><strong>{t('security.required')}</strong> {requiredWhy}</p>
    </div>
  {/if}

  {#if codes !== null}
    <!-- Freshly issued codes are shown once, so they scroll into view wherever the action was. -->
    <div
      class="codes-anchor"
      {@attach node =>
        node.scrollIntoView({ behavior: 'smooth', block: 'start' })}
    ></div>
    <Card tone="lime" title={t('auth.codes.title')} icon={LifeBuoy}>
      {#snippet actions()}
        <IconButton
          icon={X}
          label={t('security.codes.hide')}
          onclick={() => (codes = null)}
        />
      {/snippet}
      <RecoveryCodes
        {codes}
        {companyName}
        continueLabel={t('security.codes.done')}
        oncontinue={() => (codes = null)}
      />
    </Card>
  {/if}

  <Card
    title={t('security.passkeys.title')}
    description={t('security.passkeys.description')}
    icon={FingerprintPattern}
  >
    {#if status.passkeys.length === 0}
      <p class="empty">{t('security.passkeys.empty')}</p>
    {:else}
      <ul class="list">
        {#each status.passkeys as passkey (passkey.id)}
          <li>
            <span class="item-icon"><KeyRound size={17} /></span>
            <div class="item-text">
              <strong class="truncate">{passkey.name}</strong>
              <span>
                {t('security.passkeys.added', {
                  date: formatDate(passkey.createdAt)
                })} ·
                {passkey.lastUsedAt === null
                  ? t('security.neverUsed')
                  : t('security.lastUsed', {
                      date: formatDate(passkey.lastUsedAt)
                    })}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={Trash}
              loading={busy === passkey.id}
              op="auth.passkeyRemove"
              title={lastRequired ? t('security.lastMethodHint') : undefined}
              onclick={() => removePasskey(passkey)}
            >
              {t('common.remove')}
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="add">
      <PasskeyAdd
        account={user.email ?? user.name}
        busy={busy === 'passkeyAdd'}
        onadd={addPasskey}
      />
    </div>
  </Card>

  <Card
    title={t('security.totp.title')}
    description={t('security.totp.description')}
    icon={Smartphone}
  >
    {#snippet actions()}
      {#if status.totp}
        <Badge tone="ok" dot>{t('security.totp.on')}</Badge>
      {:else}
        <Badge>{t('security.totp.off')}</Badge>
      {/if}
    {/snippet}
    {#if setupSecret !== null}
      <div class="setup">
        <div class="setup-main">
          <p class="muted">
            {status.totp
              ? t('security.totp.replaceIntro')
              : t('security.totp.setupIntro')}
          </p>
          <TotpSetup
            {companyName}
            email={user.email ?? ''}
            secret={setupSecret}
            bind:code={setupCode}
            error={setupError}
            busy={busy === 'totp'}
            op="auth.totpConfirm"
            onconfirm={confirmTotp}
          />
          <Button variant="ghost" onclick={() => (setupSecret = null)}
            >{t('common.cancel')}</Button
          >
        </div>
        <div class="setup-demo">
          <DemoAuthenticator
            secret={setupSecret}
            issuer={companyName}
            account={user.email ?? ''}
            onuse={value => (setupCode = value)}
          />
          <p class="xs faint">{t('auth.demo.codeHint')}</p>
        </div>
      </div>
    {:else}
      {#if status.totp && lastRequired}
        <p class="hint">{t('security.lastMethodHint')}</p>
      {/if}
      <div class="row">
        <Button
          variant={status.totp ? 'secondary' : 'primary'}
          icon={status.totp ? RefreshCw : Smartphone}
          onclick={startSetup}
        >
          {status.totp ? t('security.totp.replace') : t('security.totp.start')}
        </Button>
        {#if status.totp}
          <Button
            variant="ghost"
            icon={Trash}
            loading={busy === 'totpRemove'}
            op="auth.totpRemove"
            onclick={removeTotp}>{t('security.totp.remove')}</Button
          >
        {/if}
      </div>
    {/if}
  </Card>

  <Card
    title={t('security.codes.title')}
    description={t('security.codes.description')}
    icon={LifeBuoy}
  >
    {#if methodCount > 0}
      <div
        class="pips"
        role="img"
        aria-label={t('security.codes.left', {
          count: status.recoveryCodesLeft
        })}
      >
        {#each Array.from({ length: RECOVERY_CODE_COUNT }, (_, index) => index) as index (index)}
          <span class="pip" class:used={index >= status.recoveryCodesLeft}
          ></span>
        {/each}
        <span class="pips-text"
          >{t('security.codes.left', { count: status.recoveryCodesLeft })}</span
        >
      </div>
      <div class="row">
        <Button
          icon={RefreshCw}
          loading={busy === 'codes'}
          op="auth.recoveryCodes"
          onclick={regenerate}>{t('security.codes.regenerate')}</Button
        >
      </div>
      <p class="hint">{t('security.codes.regenerateNote')}</p>
    {:else}
      <p class="empty">{t('errors.auth.codesNeedMethod')}</p>
    {/if}
  </Card>
</div>

<style>
  .manage {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .codes-anchor {
    scroll-margin-top: var(--space-4);
    margin-bottom: calc(-1 * var(--space-4));
  }
  .required {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--info-soft);
    color: var(--info);
  }
  .required p {
    color: var(--text);
    font-size: var(--text-sm);
  }
  .empty {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--line);
  }
  .list li:first-child {
    padding-top: 0;
  }
  .item-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: var(--radius-sm);
    background: var(--surface-3);
    color: var(--primary);
  }
  .item-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .item-text span {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .add {
    margin-top: var(--space-4);
  }
  .setup {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    align-items: flex-start;
  }
  .setup-main {
    flex: 1 1 320px;
    max-width: 460px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .setup-demo {
    flex: 0 1 260px;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .hint {
    font-size: var(--text-sm);
    color: var(--text-muted);
    margin-bottom: var(--space-3);
  }
  .pips {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: var(--space-4);
  }
  .pip {
    width: 14px;
    height: 22px;
    border-radius: 4px;
    background: var(--lime);
    box-shadow: inset 0 0 0 1px
      color-mix(in srgb, var(--on-lime) 15%, transparent);
  }
  .pip.used {
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--line-strong);
  }
  .pips-text {
    margin-left: var(--space-2);
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .row + .hint {
    margin: var(--space-3) 0 0;
  }
</style>
