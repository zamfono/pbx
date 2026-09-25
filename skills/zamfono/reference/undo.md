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

1. If the entry's id is not already known, find it: `GET /audit?entityKind=&entityId=` (add
   `actorUserId`, `channel` or a time range to narrow further). Entries are newest first; `state`
   defaults to `live` (undone entries are hidden).
2. Revert it: `POST /audit/{id}/undo`. This writes the entry's recorded `from` values back
   through the entity's own operation, stamps the reverted entry `undoneAt`, and appends a new
   `audit.undo` entry with the reverse diff — history stays one chronological, append-only
   sequence; an undo is a revert, never a branch.
3. A 409 names why it was refused:
   - a later live change exists for the same entity — undo that one first, then this one;
   - the reverted state would recreate a duplicate (a reused extension, e-mail or DID number) —
     the conflict names the newer row; change that row first;
   - a reverted deletion's row has already been hard-purged past the retention window;
   - the entry is not undoable at all: a secret-bearing change (passwords, API tokens, `*_enc`
     settings are masked, so there is no `from` to restore), a one-shot action (a manual backup
     run, a sent e-mail), or a hard delete of a voicemail or recording whose file is gone.

Several consecutive changes to one entity are peeled back by repeated calls to `POST
/audit/{id}/undo`, oldest surviving change last.
