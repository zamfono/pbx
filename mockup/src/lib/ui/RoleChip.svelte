<!--
  A person's role.
-->
<script lang="ts">
  import type { Role } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';

  let { role }: { role: Role } = $props();
</script>

<span class="chip {role}">{t(`role.${role}`)}</span>

<style>
  .chip {
    font-size: var(--text-xs);
    font-weight: 700;
    padding: 3px 10px;
    border-radius: var(--radius-pill);
    white-space: nowrap;
  }
  .owner {
    background: var(--role-owner-soft);
    color: var(--role-owner);
  }
  .admin {
    background: var(--role-admin-soft);
    color: var(--role-admin);
  }
  .user {
    background: var(--role-user-soft);
    color: var(--role-user);
  }
</style>
