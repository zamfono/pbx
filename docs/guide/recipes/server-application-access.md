---
title: Give a server application access
arguments:
  - name: application
    description: The application's name, e.g. crm-sync; it names its user and its token
    required: true
  - name: role
    description: The role the application needs, user or admin; user unless it configures the stack
    required: false
---

# Give a server application access

A server application, a CRM sync or a reporting job, that cannot do an interactive login uses a
personal access token. Interactive and MCP clients, and scripts a person can log in for once, use
OAuth instead: they are told where to log in and continue on their own.

1. Create a dedicated user for the application: `users.create` (`POST /users`) with its name, an
   e-mail address someone reads, and the lowest `role` that does the job. The token acts exactly as
   this user, with the role the user holds at each request, so the role is the application's whole
   permission: no scopes, no read-only token. Every change the application makes is audited under
   this user's name.
2. Create the token: `personalAccessTokens.create` (`POST /users/{id}/personalAccessTokens`) with
   a `name` saying where it is used and, if wanted, `expiresAt`; left out, it never expires. The
   response's `token`, `zpat_…`, is shown this once: hand it to the application's secret store
   straight away. A user may create tokens for themselves; an admin or owner creates them for any
   user, and only an owner for an owner.
3. The application sends it as `Authorization: Bearer zpat_…` on `/api/v1/*` and `/mcp`, and in
   the `/events` auth frame as `token`.
4. Check it is in use: `personalAccessTokens.list` (`GET /users/{id}/personalAccessTokens`) shows
   each token's `lastUsedAt`, updated at most once a minute, never the token itself.
5. Replace or withdraw it: create a new token under another name, switch the application over,
   then `personalAccessTokens.revoke` (`POST /personalAccessTokens/{id}/revoke`) the old one. It
   stops working at once and cannot be undone. Deleting the user revokes all of their tokens.
