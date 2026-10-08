<!--
  A registry-driven form field: label, help and Expert tag from the field registry, hidden when
  the person may not see it or Expert mode is off. The child snippet receives whether the field is
  editable, so a display-only value renders as plain text. A search result for it highlights it
  (`field:<entity>.<key>`).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  import { fieldAccess } from '#lib/fields/registry.js';
  import { has, t } from '#lib/i18n/index.svelte.js';
  import { router } from '#lib/state/router.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Field from '#lib/ui/Field.svelte';

  type Props = {
    entity: string;
    key: string;
    id?: string;
    error?: string | null;
    own?: boolean;
    inline?: boolean;
    required?: boolean;
    /** Overrides the registry label key. */
    label?: string;
    children: Snippet<[boolean]>;
  };

  let {
    entity,
    key,
    id,
    error = null,
    own = false,
    inline = false,
    required = false,
    label,
    children
  }: Props = $props();
  const access = $derived(
    fieldAccess(entity, key, currentActor().role, isExpert(), own)
  );
  const helpKey = $derived(`field.${entity}.${key}.help`);
</script>

{#if access.visible}
  <Field
    label={label ?? t(`field.${entity}.${key}`)}
    id={id ?? `${entity}-${key}`}
    help={has(helpKey) ? t(helpKey) : undefined}
    {error}
    expert={access.expert}
    {inline}
    {required}
    flash={router.highlight === `field:${entity}.${key}`}
  >
    {@render children(access.editable)}
  </Field>
{/if}
