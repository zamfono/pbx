---
name: zamfono
description: Administers a Zamfono phone system (PBX) stack over its MCP interface — users, devices, trunks, ring groups, menus, call routing, backups. Use when connecting Claude Code or Codex to a Zamfono stack, or when asked to configure, diagnose or query one.
---

# Zamfono admin skill

Zamfono exposes its full v1 operations layer as an MCP server at `/mcp` on the stack's own
domain (§10.5). Connect once per stack:

```
claude mcp add --transport http zamfono https://<fqdn>/mcp
```

```
codex mcp add zamfono --url https://<fqdn>/mcp
```

Replace `<fqdn>` with the stack's public hostname. The endpoint publishes OAuth 2.1
protected-resource metadata, so the client's own connect flow handles sign-in; no token is
copied by hand.

## Before the first change

Read `reference/mental-model.md`, `reference/routing-order.md` and `reference/guardrails.md`
before configuring anything: they cover the entities, the forward-target vocabulary and what the
operations layer refuses outright. `reference/glossary.md` and the recipe files
(`reference/onboard-employee.md`, `reference/vacation-rule.md`, `reference/diagnose-bad-call.md`,
`reference/undo.md`) cover the rest of the guide. `reference/tools.md` lists every operation this
skill can call, generated from the stack's own operation registry so it never drifts from it. The
`zamfono.help` tool itself is not an operation and so is not in that list; see below for it.

## Working with the stack

- Every write runs through the same operations layer as the REST API and the admin UI: it is
  validated, checked against the caller's role, recorded in the audit log, and undoable unless
  the tool description says otherwise.
- A tool that changes something destructive asks for confirmation before it runs; answer the
  question it raises, do not retry blindly with different arguments.
- Call `zamfono.help(topic)` for anything not already read from `reference/` — it serves the same
  guide sections live from the connected stack.
