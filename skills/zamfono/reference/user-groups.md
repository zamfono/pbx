# User groups

A user group is a named set of users, and of other user groups, that stands for "these people"
wherever the configuration lists people. It has no extension and is never called itself: it is
not a forward target, and nobody dials it.

## Where they are used

- **Ring-group members.** A ring group's `members`, set with `ringGroups.update`
  (`PATCH /ringGroups/{id}`), take `{ "kind": "userGroup", "id": "…" }` next to
  `{ "kind": "user", … }`. The group then rings whoever is in the user group when the call arrives.
- **Outbound-route callers.** A route's `userGroups` list, set with `outboundRoutes.replace`
  (`PUT /outboundRoutes`), lets every member call over that route, next to its `users` list.

Wherever a user group is used it is **flattened**: nested groups are expanded to their users and
duplicates are dropped, so a user in two nested groups is rung once. A ring group's strategy then
treats them like members listed one by one (`routing-order`). Through a ring group, a user group's
members also share that group's mailbox: each may read its voicemails, and its voicemail mail goes
to all of them (`call-data`). A membership change applies from the next call.

## Managing user groups

All user-group operations are `admin`.

- `userGroups.create` (`POST /userGroups`) takes `name`, unique among the live groups (409
  otherwise), and optionally `members`, a list of `{ "kind": "user" | "userGroup", "id": "…" }`.
- `userGroups.update` (`PATCH /userGroups/{id}`) changes `name`, or `members`, which replaces the
  list as a whole: send every member, not only the new one.
- `userGroups.list` (`GET /userGroups`) and `userGroups.get` (`GET /userGroups/{id}`) return each
  group with its direct members, users and groups, not the flattened list.
- `userGroups.delete` (`DELETE /userGroups/{id}`) soft-deletes it (`guardrails`).

```json
{
  "name": "Support",
  "members": [
    { "kind": "user", "id": "…" },
    { "kind": "userGroup", "id": "<Support night shift>" }
  ]
}
```

A member listed twice is refused with 422, and a user or group that does not exist or is deleted
with 404.

## Nesting

Groups nest to any depth: "Support" can hold "Support day" and "Support night", and an "All staff"
group can hold "Support". A nesting that would close a loop, a group inside itself directly or
through others, is refused with 409, and the error's `path` lists the chain that would loop.

## Deleting

A user group is deleted even while ring groups and outbound routes still name it; nothing blocks
it. While deleted it counts as empty: a ring group skips it, and an outbound route matches none
of its members through it. A route whose only caller is that group then matches nobody, not
everybody, so check `outboundRoutes.list` (`GET /outboundRoutes`) first. `audit.undo` brings it
back, members and references included, since those were kept.

A user who is deleted drops out of every group's member list in reads and at call time; the
membership itself is kept, so undoing the user's delete puts them back in their groups.
