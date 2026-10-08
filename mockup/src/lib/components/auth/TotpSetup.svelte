<!--
  An authenticator app's enrolment: the otpauth URI as a QR code, the same secret as text for
  manual entry, then the first code it shows, which confirms it.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';

  import { t } from '#lib/i18n/index.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Button from '#lib/ui/Button.svelte';

  import FakeQr from './FakeQr.svelte';
  import { groupedSecret, otpauthUri } from './mfa';
  import OtpInput from './OtpInput.svelte';

  type Props = {
    companyName: string;
    email: string;
    secret: string;
    code: string;
    error?: string | null;
    busy?: boolean;
    op?: string;
    onconfirm: (code: string) => void;
  };
  let {
    companyName,
    email,
    secret,
    code = $bindable(),
    error = null,
    busy = false,
    op,
    onconfirm
  }: Props = $props();

  let copied = $state(false);
  const uri = $derived(otpauthUri(companyName, email, secret));

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      // Clipboard blocked: the key stays selectable.
    }
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }
</script>

<form
  class="totp"
  onsubmit={event => {
    event.preventDefault();
    onconfirm(code);
  }}
>
  <div class="pair">
    <div class="qr-frame">
      <FakeQr text={uri} label={t('auth.enrol.qrLabel')} />
    </div>
    <ol class="steps">
      <li>{t('auth.enrol.step1')}</li>
      <li>{t('auth.enrol.step2')}</li>
      <li>{t('auth.enrol.step3')}</li>
    </ol>
  </div>
  <div class="secret">
    <span class="secret-label">{t('auth.enrol.secretLabel')}</span>
    <div class="secret-box">
      <code>{groupedSecret(secret)}</code>
      <button
        type="button"
        class="copy"
        onclick={copy}
        aria-label={t('common.copy')}
      >
        {#if copied}<Check size={15} />{:else}<Copy size={15} />{/if}
      </button>
    </div>
    {#if isExpert()}
      <code class="uri">{uri}</code>
    {/if}
  </div>
  <div class="confirm">
    <span class="code-label">{t('auth.enrol.codeLabel')}</span>
    <OtpInput
      bind:value={code}
      label={t('auth.enrol.codeLabel')}
      invalid={error !== null}
      disabled={busy}
      oncomplete={onconfirm}
    />
    {#if error !== null}
      <p class="error" role="alert">{error}</p>
    {/if}
  </div>
  <Button
    type="submit"
    variant="primary"
    size="lg"
    full
    loading={busy}
    disabled={code.length !== 6}
    {op}>{t('auth.enrol.confirm')}</Button
  >
</form>

<style>
  .totp {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .pair {
    display: flex;
    gap: var(--space-4);
    align-items: center;
  }
  .qr-frame {
    padding: 6px;
    border-radius: var(--radius-md);
    background: var(--on-primary);
    box-shadow:
      0 0 0 1px var(--line),
      var(--shadow-md);
    flex: none;
  }
  .steps {
    margin: 0;
    padding-left: 1.2em;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .steps li::marker {
    font-family: var(--font-display);
    font-weight: 800;
    color: var(--primary);
  }
  .secret {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .secret-label,
  .code-label {
    font-size: var(--text-sm);
    font-weight: 700;
  }
  .secret-label {
    font-weight: 500;
    color: var(--text-muted);
  }
  .secret-box {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 8px 8px 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-3);
  }
  .secret-box code {
    flex: 1;
    min-width: 0;
    word-break: break-all;
    letter-spacing: 0.06em;
    font-size: var(--text-sm);
    user-select: all;
  }
  .copy {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    flex: none;
    border: 0;
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--text-muted);
    cursor: pointer;
  }
  .copy:hover {
    color: var(--primary);
  }
  .uri {
    font-size: var(--text-xs);
    color: var(--text-muted);
    word-break: break-all;
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .error {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--danger);
  }
  @media (max-width: 480px) {
    .pair {
      flex-direction: column;
      align-items: center;
    }
  }
</style>
