<!--
  Moves a live call on (`calls.transfer`): blind to an extension or number, straight into a
  mailbox (`voicemail`), or attended — first a consultation (`calls.consult`), then the transfer
  to it. Also adds a third party (`calls.addParty`). `legId` names the leg when an admin acts on
  someone else's call.
-->
<script lang="ts">
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import PhoneForwarded from '@lucide/svelte/icons/phone-forwarded';
  import UserPlus from '@lucide/svelte/icons/user-plus';
  import Voicemail from '@lucide/svelte/icons/voicemail';

  import { run } from '#lib/actions.svelte.js';
  import type { LiveCall } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Dialog from '#lib/ui/Dialog.svelte';
  import Icon from '#lib/ui/Icon.svelte';

  import { legParty, partyName } from './labels';
  import TargetInput from './TargetInput.svelte';

  type Mode = 'blind' | 'attended' | 'voicemail';
  type Props = {
    open: boolean;
    call: LiveCall | null;
    purpose: 'transfer' | 'addParty';
    legId?: string;
    onclose: () => void;
  };

  let { open, call, purpose, legId, onclose }: Props = $props();

  let mode = $state<Mode>('blind');
  let target = $state('');
  let busy = $state(false);

  const moving = $derived(call?.legs.find(leg => leg.id === legId) ?? null);
  const MODES: { id: Mode; icon: typeof PhoneForwarded }[] = [
    { id: 'blind', icon: PhoneForwarded },
    { id: 'attended', icon: MessagesSquare },
    { id: 'voicemail', icon: Voicemail }
  ];

  function close(): void {
    target = '';
    mode = 'blind';
    onclose();
  }

  async function submit(): Promise<void> {
    if (call === null || target.trim() === '' || busy) {
      return;
    }
    busy = true;
    const leg = legId === undefined ? {} : { legId };
    const name = partyName(target.trim());
    if (purpose === 'addParty') {
      const result = await run(
        'calls.addParty',
        { id: call.callId, target: target.trim() },
        { success: 'calls.addParty.done', successParams: { name } }
      );
      busy = false;
      if (result.ok) {
        close();
      }
      return;
    }
    if (mode === 'attended') {
      const result = await run<{ id: string; callId: string }>(
        'calls.consult',
        { id: call.callId, target: target.trim(), ...leg },
        { success: 'calls.consult.started', successParams: { name } }
      );
      busy = false;
      if (result.ok) {
        close();
      }
      return;
    }
    const result = await run(
      'calls.transfer',
      {
        id: call.callId,
        target: target.trim(),
        ...(mode === 'voicemail' ? { voicemail: true } : {}),
        ...leg
      },
      {
        success:
          mode === 'voicemail'
            ? 'calls.transfer.doneVoicemail'
            : 'calls.transfer.done',
        successParams: { name }
      }
    );
    busy = false;
    if (result.ok) {
      close();
    }
  }

  const op = $derived(
    purpose === 'addParty'
      ? 'calls.addParty'
      : mode === 'attended'
        ? 'calls.consult'
        : 'calls.transfer'
  );
</script>

<Dialog
  {open}
  title={purpose === 'addParty'
    ? t('calls.addParty.title')
    : t('calls.transfer.title')}
  onclose={close}
>
  <div class="stack body">
    {#if moving}
      <p class="muted small">
        {t('calls.transfer.leg', {
          name: legParty(moving).name ?? legParty(moving).number
        })}
      </p>
    {/if}
    {#if purpose === 'transfer'}
      <div
        class="modes"
        role="radiogroup"
        aria-label={t('calls.transfer.mode')}
      >
        {#each MODES as item (item.id)}
          <button
            type="button"
            role="radio"
            aria-checked={mode === item.id}
            class:on={mode === item.id}
            onclick={() => (mode = item.id)}
          >
            <Icon icon={item.icon} size={18} />
            <span class="strong">{t(`calls.transfer.${item.id}`)}</span>
            <span class="xs muted">{t(`calls.transfer.${item.id}Help`)}</span>
          </button>
        {/each}
      </div>
    {:else}
      <p class="muted small row">
        <UserPlus size={16} />
        {t('calls.addParty.help')}
      </p>
    {/if}
    <label class="field" for="transfer-target">
      <span class="small strong"
        >{mode === 'voicemail' && purpose === 'transfer'
          ? t('calls.transfer.mailboxOf')
          : t('calls.transfer.target')}</span
      >
      <TargetInput
        id="transfer-target"
        bind:value={target}
        placeholder={t('calls.dial.placeholder')}
        ringGroups={purpose === 'transfer'}
        onenter={submit}
      />
    </label>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={close}>{t('common.cancel')}</Button>
    <Button
      variant="primary"
      {op}
      loading={busy}
      disabled={target.trim() === ''}
      onclick={submit}
    >
      {purpose === 'addParty'
        ? t('calls.addParty.action')
        : t(`calls.transfer.${mode}Action`)}
    </Button>
  {/snippet}
</Dialog>

<style>
  .body {
    min-height: 380px;
  }
  .modes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
  }
  .modes button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: var(--space-3);
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .modes button.on {
    border-color: var(--primary);
    background: var(--primary-soft);
    color: var(--primary);
  }
  .field {
    display: grid;
    gap: 6px;
  }
  @media (max-width: 520px) {
    .modes {
      grid-template-columns: 1fr;
    }
  }
</style>
