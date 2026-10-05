---
title: Undo a change
arguments:
  - name: entityKind
    description: The kind of entity the change was made to, e.g. user, ringGroup, did
    required: false
  - name: entityId
    description: The id of the changed entity, to narrow the search
    required: false
  - name: auditEntryId
    description: The audit_log entry id to revert, if already known
    required: false
---

# Undo a change

1. If the entry's id is not already known, find it: `audit.list`
   (`GET /api/v1/audit?entityKind=&entityId=`) (add `actorUserId`, `channel` or a time range to
   narrow further). Entries are newest first; `state` defaults to `live` (undone entries are
   hidden).
2. Revert it: `audit.undo` (`POST /api/v1/audit/{id}/undo`). This writes the entry's recorded `from`
   values back through the entity's own operation, stamps the reverted entry `undoneAt`, and appends
   a new `audit.undo` entry with the reverse diff — history stays one chronological, append-only
   sequence; an undo is a revert, never a branch.
3. A 409 names why it was refused:
   - a later live change exists for the same entity — undo that one first, then this one;
   - the reverted state would recreate a duplicate (a reused extension, e-mail or DID number) —
     the conflict names the newer row; change that row first;
   - a reverted deletion's row has already been hard-purged past the retention window;
   - a reverted deletion's row points at a row deleted since, itself or through its forward
     targets (a menu's greeting, a DID's target user, a forwarding rule's ring group) — the
     conflict names each such row; undo that deletion first;
   - the entry is not undoable at all: a secret-bearing change (passwords, API tokens, `*_enc`
     settings are masked, so there is no `from` to restore), a one-shot action (a manual backup
     run, a sent e-mail), creating or revoking a personal access token (a credential is revoked,
     never revived), or a hard delete of a voicemail or recording whose file is gone.
4. A 403 means the undo is above your role: only an owner undoes the deletion of an admin or an
   owner.

Six operations record what an effect outside Zamfono answered rather than a change:
`ringotel.push`, `ringotel.profile`, `ringotel.roster`, `ringotel.rereg`, `system.autoUpdate` and
`system.maintenanceGate`. Their entries are never undoable, and never count as a later change that
blocks undoing an entity's earlier entries.

Several consecutive changes to one entity are peeled back by repeated calls to `audit.undo`
(`POST /api/v1/audit/{id}/undo`), oldest surviving change last.
