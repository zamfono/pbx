# Zamfono UI mockup

A clickable, self-contained mockup of the Zamfono tenant UI for internal testing and customer demos
(design: `docs/superpowers/specs/2026-10-08-ui-mockup-design.md`). SvelteKit with the hash router,
Svelte 5 and TypeScript, built by adapter-static into one HTML file, `docs/mockup/index.html`
(`output.bundleStrategy: 'inline'`; fonts and audio inlined), which opens from disk.

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # → ../docs/mockup/index.html (one file)
npm run check        # svelte-kit sync + svelte-check, warnings fail
npm test             # vitest
npm run snapshot:api # refresh src/lib/fields/apiOperations.json from packages/api
```

Presenting it? See [DEMO-GUIDE.md](DEMO-GUIDE.md): preparation, the cast, story lines, every Mucki
prompt and recovery tips.

Demo links take a persona and Expert mode: `#/users?as=lea&expert=1` (`lea` owner, `jonas` admin,
`mira` user).

## Fidelity rule

The mockup shows nothing the API cannot do and hides nothing it can configure. Every action is an
operation of the API registry (`packages/api/src/lib/server/ops/`), named exactly as there
(`users.create`), with its role gates, confirmation, validation and refusals. In Expert mode every
configurable field is reachable; `completeness.test.ts` enforces that against
`src/lib/fields/apiOperations.json` (every operation's input fields and the API's own field
descriptions, generated from the registry).

Sources of truth, in order: the operation's source in `packages/api/src/lib/server/ops/<area>/`,
`apiOperations.json`, `docs/spec.md` (§5.3 roles, §10.3 REST, §11.2 schema, §11.4 settings),
`skills/zamfono/reference/tools.md`.

## Architecture

| Path                              | What                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/api/types.ts`            | The tenant in the API's wire format (`Db`)                                                                                |
| `src/lib/api/seed/`               | Brandt & Partner Steuerberatung, built relative to now; `ids.ts` names the seed rows (`U.lea`, `RG.support`, …)           |
| `src/lib/api/store.svelte.ts`     | The reactive `store.db`, persisted in localStorage                                                                        |
| `src/lib/api/ops/core.ts`         | `defineOp`, `call`, gates, confirmation, audit entries, undo                                                              |
| `src/lib/api/ops/areas/*.ts`      | The operations, one module per API area (auto-registered)                                                                 |
| `src/lib/api/ops/validate.ts`     | Shared input checks (E.164, extensions, IP/CIDR, timeouts)                                                                |
| `src/lib/api/events.svelte.ts`    | `emit`, `subscribe`, per-role delivery (`visibleTo`)                                                                      |
| `src/lib/api/lookup.ts`           | Reads by id, live rows, target references                                                                                 |
| `src/lib/fields/entities/*.ts`    | Field registry per entity (auto-registered)                                                                               |
| `src/lib/actions.svelte.ts`       | `run` (write: confirm, toast, Undo) and `read` (reactive read) for screens                                                |
| `src/lib/state/`                  | Session (persona, Expert, theme, locale), router, dialogs/toasts, demo reset hooks                                        |
| `src/lib/nav.ts`                  | Every page: route patterns, sidebar section, minimum role, Expert/owner flags                                             |
| `src/lib/ui/`                     | Generic UI kit                                                                                                            |
| `src/lib/components/`             | Domain components (`ForwardTargetPicker`, `MemberPicker`, `FormField`, `LogLevelField`, `schedule/`)                      |
| `src/lib/i18n/messages/*.ts`      | DE/EN text per area (auto-merged)                                                                                         |
| `src/routes/(app)/…/+page.svelte` | One route per page in `nav.ts`; optional params as `[[id]]`, `[[tab]]`; the `(app)` layout is the shell and the role gate |
| `src/routes/auth/[...path]`       | The sign-in flow (`/auth/signin`, `/auth/forgot`, …)                                                                      |

## Writing an operation

See `src/lib/api/ops/areas/blockedNumbers.ts`.

- `defineOp({ name, minRole, scope?, ownerOnly?, confirm?, readOnly?, run })` — the same gates as
  the API's `defineOperation`. `scope` applies to `user` callers only: `'any'` or a predicate
  "what the input names is the caller's own".
- Writes go through `ctx.insert / put / softDelete / remove / setKey / setRoot`, then one
  `ctx.audit({ entityKind, entityId, before, after, undoable? })`. Entity kinds as the API names
  them: `user`, `device`, `ringGroup`, `menu`, `did`, `didBlock`, `trunk`, `webhook`, `contact`,
  `audio`, `userGroup`, `oooRule`, `backupTarget`, `blockedNumber`, `sipAllowlistEntry`,
  `openingHours`, `settings`, `outboundRoute`, `parking`, `personalAccessToken`, `mailTemplate`.
- `undoable: false` for what the API cannot undo (§5.8): secrets, token create/revoke,
  voicemail/recording deletes, erase, pure actions (`pure: true`: re-register, manual backup run,
  revealing credentials).
- Not audited (no `ctx.audit`): `users.setPresence`, `voicemails.markRead`, live-call actions,
  the personal voicemail greeting.
- Refusals: `invalid(field, code, message, params)` (422), `conflict(code, message, refs)` (409,
  `refs` link the blocking rows), `notFound`, `forbidden`. `code` is an i18n key under `errors.`.
- `confirm` returns `{ key, params, destructive?, irreversible? }`; the dialog reads
  `confirm.<key>.title|body|action`.
- Emit the events the API emits (`ctx.emit`): `ooo`, `hours`, `trunk.status`, `voicemail.new`,
  `call.state`, `history.appended`, `presence`, `sipBan.added`, `backup.*`. For per-user delivery pass
  `audience` (user ids).

## Writing a page

See `src/routes/(app)/blocklist/+page.svelte`.

- Route params come from `page.params` (`$app/state`); app links are `#/…` (`href()`), navigation
  is `go()` from `#lib/state/router.svelte.js`.
- Read with `read(op, input, fallback)` inside `$derived` (re-runs on every store change); write
  with `await run(op, input, { success: 'i18n.key' })`. Never mutate `store.db` from a page.
- Fields: wrap each in `<FormField entity key>`; it applies tier (Expert), owner-only visibility
  (display-only / hidden for admins) and self-service, and passes `editable` to its snippet. Render
  a display-only value as plain text (`DisplayValue`), never a disabled input.
- `op="…"` on `Button` (or `Menu` items) documents the operation an action runs; it is not
  displayed.
- Expert mode shows every configuration field plus raw technical detail where it is data (ids,
  audit channel and client, call logs and SIP traces); check with `isExpert()`.
- Hide actions an operation would refuse for this person (`allowed(op, input, actor)` from
  `#lib/api/ops/core.js`).
- Layout: `PageHeader`, `Card`, `DataTable` (becomes cards on phones), `Drawer` for create/edit,
  `Tabs` for sub-pages (`hrefFor` with `#/…/:tab`), `.stack`, `.row`, `.grid-2`, `.grid-3`.
  Every page works at 375 px wide.
- Colours, radii and spacing only from `src/styles/tokens.css`; no hard-coded colours. Light and
  dark both.
- Icons: `import Name from '@lucide/svelte/icons/<kebab-name>'`; Lucide Labs icon nodes via
  `#lib/ui/Icon.svelte` (`<Icon icon={mailboxFlag} />`, `import { mailboxFlag } from '@lucide/lab'`).
- Text: every visible string through `t()`, both languages, keys prefixed by the area; field labels
  `field.<entity>.<key>` (+ `.help`). Tone: plain words for an office manager; API terms only in
  Expert mode.

## Svelte

Imports inside the app use the package's subpath imports with the file's extension, as in
`packages/api`: `#lib/api/types.js`, `#lib/ui/Button.svelte`, `#lib/state/session.svelte.js`.

Svelte 5 runes only (`$state`, `$derived`, `$props`, `$effect` sparingly), event attributes
(`onclick`), snippets instead of slots. Prettier: `npx prettier --write mockup/src` from the
repository root.
