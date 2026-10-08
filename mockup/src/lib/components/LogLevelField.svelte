<!--
  A diagnostics override (§7) on a user, trunk or ring group: level `events`, `qos` or `sip` (only
  while HEP is enabled), or none, with its expiry (7 days out when left empty). Expert mode only.
-->
<script lang="ts">
  import {
    LOG_LEVEL_OVERRIDES,
    type LogLevelOverride
  } from '#lib/api/types.js';
  import { now as demoNow } from '#lib/clock.svelte.js';
  import { formatDateTime, t } from '#lib/i18n/index.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Field from '#lib/ui/Field.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';

  type Props = {
    level: LogLevelOverride | null;
    expiresAt: string | null;
    onchange: (
      level: LogLevelOverride | null,
      expiresAt: string | null
    ) => void;
    id?: string;
    disabled?: boolean;
  };

  let {
    level,
    expiresAt,
    onchange,
    id = 'log-level',
    disabled = false
  }: Props = $props();
  const SEVEN_DAYS_MS = 7 * 86_400_000;
</script>

{#if isExpert()}
  <Field label={t('logLevel.label')} {id} expert help={t('logLevel.help')}>
    <div class="stack" style="--gap: 8px">
      <Segmented
        size="sm"
        value={level}
        {disabled}
        options={[
          { value: null, label: t('logLevel.none') },
          ...LOG_LEVEL_OVERRIDES.map(value => ({
            value,
            label: t(`settings.callLogLevel.${value}`)
          }))
        ]}
        onchange={next =>
          onchange(
            next,
            next === null
              ? null
              : (expiresAt ?? new Date(demoNow() + SEVEN_DAYS_MS).toISOString())
          )}
      />
      {#if level !== null}
        <span class="small muted"
          >{t('logLevel.expires', { at: formatDateTime(expiresAt) })}</span
        >
      {/if}
    </div>
  </Field>
{/if}
