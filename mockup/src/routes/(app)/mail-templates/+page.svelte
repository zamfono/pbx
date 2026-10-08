<!--
  Mail templates (`mailTemplates.*`, §10.2 "Templates"): every kind in every language, the
  tenant's override or the shipped text. The editor offers the kind's placeholders, previews the
  mail with example values, saves an override, reverts to the shipped text and sends a test mail.
-->
<script lang="ts">
  import Code from '@lucide/svelte/icons/code';
  import Eye from '@lucide/svelte/icons/eye';
  import Mail from '@lucide/svelte/icons/mail';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Send from '@lucide/svelte/icons/send';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { tick } from 'svelte';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import { userById } from '#lib/api/lookup.js';
  import type { MailTemplateWire } from '#lib/api/ops/areas/mailTemplates.js';
  import {
    LANGUAGES,
    MAIL_KINDS,
    type Language,
    type MailKind,
    type Settings,
    type SystemInfo
  } from '#lib/api/types.js';
  import { nowDate as demoNowDate } from '#lib/clock.svelte.js';
  import FormField from '#lib/components/FormField.svelte';
  import {
    PLACEHOLDERS,
    renderTemplate,
    sampleValues,
    unknownPlaceholders,
    usedPlaceholders
  } from '#lib/components/system/mailTemplate.js';
  import { formatDateTime, t } from '#lib/i18n/index.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import { toast } from '#lib/state/ui.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import Textarea from '#lib/ui/Textarea.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  type Draft = { subject: string; bodyText: string; bodyHtml: string | null };
  type FieldId = 'subject' | 'bodyText' | 'bodyHtml';

  const settings = $derived(read<Settings | null>('settings.get', {}, null));
  const system = $derived(read<SystemInfo | null>('system.info', {}, null));
  const me = $derived(userById(currentActor().id));

  let kind = $state<MailKind>('voicemail');
  let chosenLanguage = $state<Language | null>(null);
  const language = $derived(chosenLanguage ?? settings?.language ?? 'de');
  const key = $derived(`${kind}:${language}`);

  const empty: MailTemplateWire = {
    kind: 'voicemail',
    language: 'de',
    subject: '',
    bodyText: '',
    bodyHtml: null,
    source: 'builtin',
    updatedAt: null
  };
  const template = $derived(
    read<MailTemplateWire>('mailTemplates.get', { kind, language }, empty)
  );
  const overrides = $derived.by(() => {
    const out: Record<string, Language[]> = {};
    for (const each of MAIL_KINDS) {
      out[each] = LANGUAGES.filter(
        lang =>
          read<MailTemplateWire>(
            'mailTemplates.get',
            { kind: each, language: lang },
            empty
          ).source === 'tenant'
      );
    }
    return out;
  });

  let edits = $state<Record<string, Partial<Draft>>>({});
  const draft = $derived<Draft>({
    subject: edits[key]?.subject ?? template.subject,
    bodyText: edits[key]?.bodyText ?? template.bodyText,
    bodyHtml:
      edits[key] !== undefined && 'bodyHtml' in edits[key]
        ? (edits[key].bodyHtml ?? null)
        : template.bodyHtml
  });
  const dirty = $derived(
    draft.subject !== template.subject ||
      draft.bodyText !== template.bodyText ||
      draft.bodyHtml !== template.bodyHtml
  );
  let error = $state<{ field: string; text: string } | null>(null);
  let saving = $state(false);
  let previewMode = $state<'text' | 'html'>('text');

  function edit(field: FieldId, value: string | null): void {
    edits = { ...edits, [key]: { ...edits[key], [field]: value } };
    error = null;
  }

  function discard(): void {
    const { [key]: _dropped, ...rest } = edits;
    edits = rest;
    error = null;
  }

  const offered = $derived(PLACEHOLDERS[kind].offered);
  const required = $derived(PLACEHOLDERS[kind].required);
  const usedNames = $derived.by(() => {
    const names = new Set<string>();
    for (const source of [
      draft.subject,
      draft.bodyText,
      draft.bodyHtml ?? ''
    ]) {
      try {
        for (const name of usedPlaceholders(source)) {
          names.add(name);
        }
      } catch {
        // A template mid-edit may not parse yet; the save reports it.
      }
    }
    return names;
  });
  const unknown = $derived([
    ...new Set(
      [draft.subject, draft.bodyText, draft.bodyHtml ?? ''].flatMap(source =>
        unknownPlaceholders(kind, source)
      )
    )
  ]);
  const missing = $derived(required.filter(name => !usedNames.has(name)));

  /* Placeholder insertion at the caret of the field last focused. */
  let focused = $state<{ field: FieldId; start: number; end: number }>({
    field: 'bodyText',
    start: -1,
    end: -1
  });
  function track(event: Event): void {
    const target = event.target;
    if (!(
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    )) {
      return;
    }
    const field = target.id.replace('mt-', '') as FieldId;
    if (field === 'subject' || field === 'bodyText' || field === 'bodyHtml') {
      focused = {
        field,
        start: target.selectionStart ?? target.value.length,
        end: target.selectionEnd ?? target.value.length
      };
    }
  }

  async function insert(name: string): Promise<void> {
    const field =
      focused.field === 'bodyHtml' && draft.bodyHtml === null
        ? 'bodyText'
        : focused.field;
    const current = draft[field] ?? '';
    const token = `{{${name}}}`;
    const start =
      focused.start < 0 || focused.field !== field
        ? current.length
        : focused.start;
    const end =
      focused.end < 0 || focused.field !== field ? current.length : focused.end;
    edit(field, current.slice(0, start) + token + current.slice(end));
    const caret = start + token.length;
    focused = { field, start: caret, end: caret };
    await tick();
    const element = document.getElementById(`mt-${field}`);
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      element.focus();
      element.setSelectionRange(caret, caret);
    }
  }

  /* Preview with example values. */
  const values = $derived(
    sampleValues(
      kind,
      {
        companyName: settings?.companyName ?? '',
        recipientName: me?.name ?? '',
        fqdn: system?.stack.domain ?? ''
      },
      demoNowDate().toISOString()
    )
  );
  const renderOptions = $derived({
    language,
    timezone: settings?.timezone ?? null
  });
  const previewSubject = $derived(
    renderTemplate(draft.subject, values, { ...renderOptions, escape: false })
  );
  const previewText = $derived(
    renderTemplate(draft.bodyText, values, { ...renderOptions, escape: false })
  );
  const previewHtml = $derived(
    draft.bodyHtml === null
      ? ''
      : `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px/1.55 -apple-system,'Segoe UI',sans-serif;color:#222;margin:16px;background:#fff}a{color:#4b2ee8}</style></head><body>${renderTemplate(draft.bodyHtml, values, { ...renderOptions, escape: true })}</body></html>`
  );
  const mode = $derived(draft.bodyHtml === null ? 'text' : previewMode);

  const kindOptions = $derived(
    MAIL_KINDS.map(each => ({
      value: each,
      label: t(`mailTemplates.kind.${each}`)
    }))
  );
  const languageOptions = $derived(
    LANGUAGES.map(lang => ({
      value: lang,
      label: `${lang.toUpperCase()}${overrides[kind]?.includes(lang) ? ' •' : ''}`
    }))
  );

  async function save(): Promise<void> {
    saving = true;
    const result = await run<MailTemplateWire>(
      'mailTemplates.put',
      {
        kind,
        language,
        subject: draft.subject,
        bodyText: draft.bodyText,
        bodyHtml: draft.bodyHtml
      },
      {
        success: 'mailTemplates.saved',
        successParams: {
          kind: t(`mailTemplates.kind.${kind}`),
          language: language.toUpperCase()
        }
      }
    );
    saving = false;
    if (result.ok) {
      discard();
    } else if (result.error.field !== null) {
      error = {
        field: result.error.field,
        text: errorText(result.error)
      };
    }
  }

  async function revert(): Promise<void> {
    const result = await run(
      'mailTemplates.delete',
      { kind, language },
      { success: 'mailTemplates.reverted' }
    );
    if (result.ok) {
      discard();
    }
  }

  async function sendTest(): Promise<void> {
    const result = await run<{
      status: 'sent' | 'skipped' | 'failed';
      language: Language;
    }>('mailTemplates.test', { kind });
    if (result.ok) {
      toast({
        tone: result.value.status === 'sent' ? 'success' : 'info',
        title: t(`mailTemplates.test.${result.value.status}`, {
          email: me?.email ?? '',
          language: result.value.language.toUpperCase()
        }),
        operation: 'mailTemplates.test'
      });
    }
  }
</script>

<PageHeader
  title={t('nav.mailTemplates')}
  subtitle={t('mailTemplates.subtitle')}
/>

<div class="layout">
  <nav class="kinds" aria-label={t('mailTemplates.kinds')}>
    {#each MAIL_KINDS as each (each)}
      <button
        type="button"
        class="kind"
        class:on={each === kind}
        onclick={() => (kind = each)}
      >
        <span class="kind-name">{t(`mailTemplates.kind.${each}`)}</span>
        <span class="kind-desc">{t(`mailTemplates.kind.${each}.help`)}</span>
        {#if (overrides[each]?.length ?? 0) > 0}
          <span class="kind-badges">
            <Badge tone="primary"
              >{t('mailTemplates.customised', {
                languages: (overrides[each] ?? [])
                  .map(lang => lang.toUpperCase())
                  .join(', ')
              })}</Badge
            >
          </span>
        {/if}
      </button>
    {/each}
  </nav>
  <div class="kind-select">
    <Select
      id="mt-kind"
      value={kind}
      options={kindOptions}
      onchange={value => (kind = value)}
    />
  </div>

  <div class="stack main">
    <Card padded>
      <div class="editor-head">
        <div class="titles">
          <h2>{t(`mailTemplates.kind.${kind}`)}</h2>
          <div class="row" style="--gap: 6px">
            {#if template.source === 'tenant'}
              <Badge tone="primary">{t('mailTemplates.override')}</Badge>
              {#if template.updatedAt}<span class="xs muted"
                  >{t('mailTemplates.updatedAt', {
                    at: formatDateTime(template.updatedAt)
                  })}</span
                >{/if}
            {:else}
              <Badge tone="neutral">{t('mailTemplates.shipped')}</Badge>
            {/if}
            {#if language === settings?.language}<Badge tone="ok"
                >{t('mailTemplates.tenantLanguage')}</Badge
              >{/if}
            {#if isExpert()}<code class="xs faint">{kind}:{language}</code>{/if}
          </div>
        </div>
        <Segmented
          value={language}
          options={languageOptions}
          size="sm"
          ariaLabel={t('mailTemplates.language')}
          onchange={value => (chosenLanguage = value)}
        />
      </div>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="stack fields"
        onfocusin={track}
        onkeyup={track}
        onclick={track}
        onselect={track}
      >
        <FormField
          entity="mailTemplate"
          key="subject"
          id="mt-subject"
          error={error?.field === 'subject' ? error.text : null}
          required
        >
          {#snippet children()}
            <TextInput
              id="mt-subject"
              mono
              value={draft.subject}
              oninput={value => edit('subject', value)}
            />
          {/snippet}
        </FormField>
        <FormField
          entity="mailTemplate"
          key="bodyText"
          id="mt-bodyText"
          error={error?.field === 'bodyText' ? error.text : null}
          required
        >
          {#snippet children()}
            <Textarea
              id="mt-bodyText"
              mono
              rows={9}
              value={draft.bodyText}
              oninput={value => edit('bodyText', value)}
            />
          {/snippet}
        </FormField>
        <FormField entity="mailTemplate" key="bodyHtml" id="mt-bodyHtml">
          {#snippet children()}
            <div class="stack" style="--gap: 8px">
              <Switch
                id="mt-html-on"
                size="sm"
                checked={draft.bodyHtml !== null}
                label={t('mailTemplates.htmlSwitch')}
                onchange={on =>
                  edit(
                    'bodyHtml',
                    on
                      ? (template.bodyHtml ??
                          draft.bodyText
                            .split(/\n{2,}/u)
                            .map(
                              paragraph =>
                                `<p>${paragraph.replaceAll('\n', '<br>')}</p>`
                            )
                            .join(''))
                      : null
                  )}
              />
              {#if draft.bodyHtml !== null}
                <Textarea
                  id="mt-bodyHtml"
                  mono
                  rows={7}
                  value={draft.bodyHtml}
                  oninput={value => edit('bodyHtml', value)}
                />
              {/if}
            </div>
          {/snippet}
        </FormField>
      </div>

      <div class="placeholders">
        <span class="xs muted strong">{t('mailTemplates.placeholders')}</span>
        <div class="chips">
          {#each offered as name (name)}
            <button
              type="button"
              class="chip"
              class:used={usedNames.has(name)}
              class:required={required.includes(name)}
              title={t('mailTemplates.insert')}
              onclick={() => insert(name)}
            >
              {`{{${name}}}`}
              {#if required.includes(name)}<span class="req"
                  >{t('mailTemplates.required')}</span
                >{/if}
            </button>
          {/each}
        </div>
        <p class="xs muted">{t('mailTemplates.syntaxHint')}</p>
        {#if unknown.length > 0}
          <p class="problem xs">
            <TriangleAlert size={14} />{t('mailTemplates.unknown', {
              names: unknown.map(name => `{{${name}}}`).join(', ')
            })}
          </p>
        {/if}
        {#if missing.length > 0}
          <p class="problem xs">
            <TriangleAlert size={14} />{t('mailTemplates.missing', {
              names: missing.map(name => `{{${name}}}`).join(', ')
            })}
          </p>
        {/if}
      </div>

      <div class="actions">
        <div class="row">
          {#if template.source === 'tenant' && !dirty}
            <Button
              variant="ghost"
              icon={RotateCcw}
              op="mailTemplates.delete"
              onclick={revert}>{t('mailTemplates.revert')}</Button
            >
          {/if}
          {#if language === settings?.language}
            <Button
              variant="ghost"
              icon={Send}
              op="mailTemplates.test"
              disabled={dirty}
              title={dirty ? t('mailTemplates.testSaveFirst') : undefined}
              onclick={sendTest}>{t('mailTemplates.test')}</Button
            >
          {/if}
        </div>
        {#if dirty}
          <div class="row">
            <Button variant="ghost" onclick={discard}
              >{t('settings.discard')}</Button
            >
            <Button
              variant="primary"
              op="mailTemplates.put"
              loading={saving}
              onclick={save}>{t('common.save')}</Button
            >
          </div>
        {/if}
      </div>
      {#if language !== settings?.language}
        <p class="xs muted note">
          {t('mailTemplates.otherLanguage', {
            language: t(`settings.language.${settings?.language ?? 'de'}`)
          })}
        </p>
      {/if}
    </Card>

    <Card
      title={t('mailTemplates.preview')}
      description={t('mailTemplates.previewBody')}
      icon={Eye}
    >
      {#snippet actions()}
        {#if draft.bodyHtml !== null}
          <Segmented
            size="sm"
            bind:value={previewMode}
            options={[
              { value: 'text', label: t('mailTemplates.previewText') },
              { value: 'html', label: t('mailTemplates.previewHtml') }
            ]}
            ariaLabel={t('mailTemplates.preview')}
          />
        {/if}
      {/snippet}
      <div class="mail">
        <div class="mail-head">
          <div>
            <span class="muted">{t('mailTemplates.from')}</span>
            {settings?.mailFrom ?? '—'}
          </div>
          <div>
            <span class="muted">{t('mailTemplates.to')}</span>
            {me?.name ?? ''}{me?.email ? ` <${me.email}>` : ''}
          </div>
          <div class="subject">{previewSubject}</div>
        </div>
        {#if mode === 'html'}
          <iframe
            title={t('mailTemplates.previewHtml')}
            sandbox=""
            srcdoc={previewHtml}
          ></iframe>
        {:else}
          <pre class="mail-body">{previewText}</pre>
        {/if}
      </div>
      {#if isExpert()}
        <p class="xs muted note">
          <Code size={12} />
          {t('mailTemplates.sampleNote')}
        </p>
      {/if}
    </Card>
  </div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap: var(--space-5);
    align-items: start;
  }
  .kinds {
    display: flex;
    flex-direction: column;
    gap: 6px;
    position: sticky;
    top: var(--space-4);
  }
  .kind {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
  }
  .kind:hover {
    background: var(--surface);
    border-color: var(--line);
  }
  .kind.on {
    background: var(--surface);
    border-color: var(--primary);
    box-shadow: var(--shadow-sm);
  }
  .kind-name {
    font-weight: 700;
  }
  .kind-desc {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.4;
  }
  .kind-badges {
    margin-top: 4px;
  }
  .kind-select {
    display: none;
  }
  .editor-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .titles {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .placeholders {
    margin-top: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 4px 10px;
    border-radius: var(--radius-pill);
    border: 1px dashed var(--line-strong);
    background: var(--surface-2);
    color: var(--text-muted);
    cursor: pointer;
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .chip:hover {
    border-color: var(--primary);
    color: var(--primary);
  }
  .chip.used {
    border-style: solid;
    background: var(--primary-soft);
    color: var(--primary);
    border-color: transparent;
  }
  .req {
    font-family: var(--font-body);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--warn);
  }
  .problem {
    display: flex;
    gap: 6px;
    align-items: center;
    color: var(--danger);
    font-weight: 700;
  }
  .actions {
    margin-top: var(--space-5);
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .note {
    margin-top: var(--space-3);
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .mail {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--surface-2);
  }
  .mail-head {
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
    font-size: var(--text-sm);
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-wrap: anywhere;
  }
  .subject {
    margin-top: 6px;
    font-weight: 700;
    font-size: var(--text-lg);
    font-family: var(--font-display);
  }
  .mail-body {
    margin: 0;
    padding: 14px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-body);
    font-size: var(--text-md);
    line-height: 1.6;
  }
  iframe {
    width: 100%;
    min-height: 280px;
    border: 0;
    display: block;
  }
  .main {
    min-width: 0;
  }
  @media (max-width: 900px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .kinds {
      display: none;
    }
    .kind-select {
      display: block;
    }
  }
</style>
