---
title: Set a vacation (out-of-office) rule
arguments:
  - name: scope
    description: What the rule applies to, one of user, ringGroup, menu or tenant
    required: true
  - name: scopeId
    description: The id of the user, ring group or menu; omit for the tenant scope
    required: false
  - name: startsAt
    description: When the rule becomes active, ISO 8601; omit to activate it immediately
    required: false
  - name: expiresAt
    description: When the rule ends, ISO 8601; omit for a rule active until deactivated by hand
    required: false
  - name: target
    description: The forward target callers get while the rule is active (mental-model)
    required: true
---

# Set a vacation (out-of-office) rule

`ooo` rules take priority over opening hours and over the normal routing pipeline, for internal
calls too — a colleague dialling an absent person's extension reaches the same target an outside
caller would.

1. Check for an overlapping active period first with `ooo.list` (`GET /users/{id}/ooo`) (or the
   `ringGroups`, `menus` or `tenant` equivalent) — active periods in one scope must not overlap, and
   the write is refused if they do.
2. Create the rule: `ooo.create` (`POST /users/{id}/ooo`) (or the matching scoped path) with
   `active: true`, optional `startsAt`/`expiresAt`, and `target`. Most often that is a mailbox,
   `{ "kind": "mailboxUser", "userId": "…" }`, or a colleague covering the desk,
   `{ "kind": "external", "external": "+49…" }`.
3. To end the vacation early, `ooo.update` (`PATCH /ooo/{id}`) with `active: false`, or `ooo.delete`
   (`DELETE /ooo/{id}`).

Every write is undoable (`guardrails`): reactivating an ended rule, or restoring the previous
target, is `audit.undo` (`POST /audit/{id}/undo`) on the corresponding entry rather than a fresh
write.
