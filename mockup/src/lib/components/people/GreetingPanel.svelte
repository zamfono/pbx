<!--
  A person's own voicemail greeting (`users.setVoicemailGreeting`, `users.clearVoicemailGreeting`,
  outside the audit log): upload a WAV or MP3, or record it on the phone with the own-voicemail
  code; without one, callers hear the default prompt in the tenant language. Mailbox facts beside.
-->
<script lang="ts">
  import FileAudio from '@lucide/svelte/icons/file-audio';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Upload from '@lucide/svelte/icons/upload';
  import Voicemail from '@lucide/svelte/icons/voicemail';

  import { errorText, run } from '#lib/actions.svelte.js';
  import { audioById } from '#lib/api/lookup.js';
  import { GREETING_LABEL } from '#lib/api/ops/areas/users.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { User } from '#lib/api/types.js';
  import { formatDate, formatDuration, t } from '#lib/i18n/index.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';

  let { user }: { user: User } = $props();

  const greeting = $derived(audioById(user.mailboxAudioId));
  const ownCode = $derived(store.db.settings.featureCodes.ownVoicemail);
  const messages = $derived(
    store.db.voicemails.filter(vm => vm.mailboxUserId === user.id)
  );
  const unread = $derived(messages.filter(vm => !vm.read).length);
  let input = $state<HTMLInputElement>();
  let error = $state<string | null>(null);
  let busy = $state(false);

  /** The picked file's length, read by the browser where it can decode it. */
  function durationOf(file: File): Promise<number | undefined> {
    return new Promise(resolve => {
      try {
        const url = URL.createObjectURL(file);
        const audio = new Audio();
        const done = (value: number | undefined): void => {
          URL.revokeObjectURL(url);
          resolve(value);
        };
        audio.onloadedmetadata = () =>
          done(Number.isFinite(audio.duration) ? audio.duration : undefined);
        audio.onerror = () => done(undefined);
        audio.src = url;
        setTimeout(() => done(undefined), 1500);
      } catch {
        resolve(undefined);
      }
    });
  }

  async function upload(file: File): Promise<void> {
    busy = true;
    const durationS = await durationOf(file);
    const result = await run(
      'users.setVoicemailGreeting',
      {
        id: user.id,
        upload: {
          filename: file.name,
          ...(durationS === undefined ? {} : { durationS })
        }
      },
      { success: 'people.greeting.uploaded', quietErrors: true }
    );
    busy = false;
    error = result.ok ? null : errorText(result.error);
  }
</script>

<div class="grid-2 greeting">
  <Card
    title={t('people.greeting.title')}
    description={t('people.greeting.intro')}
    icon={FileAudio}
  >
    <div class="stack">
      <div class="current" class:none={greeting === undefined}>
        <span class="glyph" aria-hidden="true"><Voicemail size={22} /></span>
        <div class="grow">
          {#if greeting}
            <div class="strong">
              {greeting.label === GREETING_LABEL
                ? t('people.greeting.own')
                : greeting.label}
            </div>
            <div class="small muted">
              {formatDuration(greeting.durationS)} · {t(
                'people.greeting.since',
                { date: formatDate(greeting.createdAt) }
              )}
            </div>
          {:else}
            <div class="strong">{t('people.greeting.default')}</div>
            <div class="small muted">{t('people.greeting.defaultHelp')}</div>
          {/if}
        </div>
      </div>

      <input
        bind:this={input}
        class="sr-only"
        type="file"
        accept=".wav,.mp3,audio/wav,audio/mpeg"
        aria-label={t('people.greeting.upload')}
        onchange={event => {
          const file = event.currentTarget.files?.[0];
          if (file) {
            void upload(file);
          }
          event.currentTarget.value = '';
        }}
      />
      <div class="row buttons">
        <Button
          variant="primary"
          size="lg"
          icon={Upload}
          op="users.setVoicemailGreeting"
          loading={busy}
          onclick={() => input?.click()}
        >
          {greeting
            ? t('people.greeting.replace')
            : t('people.greeting.upload')}
        </Button>
        {#if greeting}
          <Button
            variant="danger"
            size="lg"
            icon={Trash2}
            op="users.clearVoicemailGreeting"
            onclick={() =>
              run(
                'users.clearVoicemailGreeting',
                { id: user.id },
                { success: 'people.greeting.cleared' }
              )}
          >
            {t('people.greeting.clear')}
          </Button>
        {/if}
      </div>
      {#if error}<p class="form-error" role="alert">{error}</p>{/if}
      <p class="small muted phone">
        {t('people.greeting.byPhone', { code: ownCode })}
      </p>
    </div>
  </Card>

  <Card title={t('people.greeting.mailbox')} icon={Voicemail}>
    <dl class="facts">
      <div>
        <dt>{t('field.user.mailboxEnabled')}</dt>
        <dd>
          <Badge tone={user.mailboxEnabled ? 'ok' : 'neutral'} dot
            >{user.mailboxEnabled ? t('common.on') : t('common.off')}</Badge
          >
        </dd>
      </div>
      <div>
        <dt>{t('people.greeting.messages')}</dt>
        <dd>
          {t('people.greeting.messageCount', {
            count: messages.length,
            unread
          })}
        </dd>
      </div>
      <div>
        <dt>{t('field.user.mailboxMaxMessages')}</dt>
        <dd>{user.mailboxMaxMessages ?? t('common.unlimited')}</dd>
      </div>
      <div>
        <dt>{t('field.user.notifyMissedCalls')}</dt>
        <dd>{user.notifyMissedCalls ? t('common.on') : t('common.off')}</dd>
      </div>
      <div>
        <dt>{t('people.greeting.listen')}</dt>
        <dd class="mono">{ownCode}</dd>
      </div>
    </dl>
    {#if !user.mailboxEnabled}
      <p class="small muted off">{t('people.greeting.mailboxOff')}</p>
    {/if}
  </Card>
</div>

<style>
  .current {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius-md);
    background: var(--primary-soft);
  }
  .current.none {
    background: var(--surface-3);
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--surface);
    color: var(--primary);
    flex: none;
  }
  .none .glyph {
    color: var(--text-muted);
  }
  .buttons :global(.btn) {
    flex: 1 1 auto;
    justify-content: center;
  }
  .phone,
  .off {
    margin: 0;
  }
  .off {
    margin-top: var(--space-3);
  }
  .facts {
    margin: 0;
    display: grid;
    gap: var(--space-3);
  }
  .facts div {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    font-size: var(--text-sm);
    align-items: center;
  }
  .facts dt {
    color: var(--text-muted);
  }
  .facts dd {
    margin: 0;
    text-align: right;
    font-weight: 700;
  }
  .form-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 700;
  }
</style>
