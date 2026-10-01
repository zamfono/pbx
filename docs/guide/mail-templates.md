# Mail templates

Every mail the stack sends is rendered from a template: the voicemail notification, the
missed-call mail (to users with `notifyMissedCalls` set), the setup mail with a new account's
set-password link, the password-reset mail, and the two mails to every owner about updates
(`update-stack`): a failed automatic update and a breaking release to install by hand. Each
template has a `subject`, a plain-text `bodyText` and an optional `bodyHtml`.

## Kinds, languages and which template applies

There are six kinds, `voicemail`, `missedCall`, `setup`, `reset`, `updateFailed` and
`breakingUpdate`, and six languages, `de`, `en`, `es`, `fr`, `it` and `ru`. The stack ships a
**builtin** template for every kind and language; a **tenant** template overrides one of them. A mail uses the tenant's template for its
kind in `settings.language`, else the builtin one for that language. An override in another
language is kept but used only once `settings.language` is switched to it.

All template operations are `admin`.

- `mailTemplates.list` (`GET /mailTemplates`) returns the effective template of every kind in the
  tenant language, each with `source` `builtin` or `tenant`.
- `mailTemplates.get` (`GET /mailTemplates/{kind}/{language}`) returns one, in any language.
- `mailTemplates.put` (`PUT /mailTemplates/{kind}/{language}`) stores an override with `subject`,
  `bodyText` and optionally `bodyHtml` (`null` or left out sends text only). It replaces any
  earlier override of that kind and language as a whole.
- `mailTemplates.delete` (`DELETE /mailTemplates/{kind}/{language}`) removes the override, so the
  builtin template applies again; 404 when there is none. Both writes are undoable (`guardrails`).
- `mailTemplates.test` (`POST /mailTemplates/{kind}/test`) sends the effective template, in the
  tenant language, to the caller's own address with sample values, and answers `status`.

Read the builtin template with `mailTemplates.get` before writing an override: it is the best
starting point and shows the branches the kind needs.

## Syntax

Templates are Handlebars, restricted to:

- `{{placeholder}}` substitution, from the kind's placeholders below;
- the blocks `{{#if}}`, `{{#unless}}`, `{{#each}}` and `{{#with}}`, with `{{else}}`;
- one helper, `{{date value}}`, which formats a timestamp such as `receivedAt` in the tenant's
  language and time zone (`settings.timezone`), as a medium date and a short time.

Partials, any other helper and `{{{triple-stash}}}` output in `bodyHtml` are refused; values are
HTML-escaped in `bodyHtml`. The subject and text body are not escaped.

## Placeholders per kind

Every kind offers `companyName` (`settings.companyName`), `recipientName` (the recipient user's
name, or the ring group's for a group mailbox) and `fqdn` (the stack's domain). In addition:

| Kind             | Also offered                                                                            | Required |
| ---------------- | --------------------------------------------------------------------------------------- | -------- |
| `voicemail`      | `callerNumber`, `callerName`, `mailboxName`, `receivedAt`, `durationS`                  | none     |
| `missedCall`     | `callerNumber`, `callerName`, `receivedAt`, `didLabel`                                  | none     |
| `setup`          | `link`, `linkExpiresAt`, `invitedBy` (empty for the first owner at boot)                | `link`   |
| `reset`          | `link`, `linkExpiresAt`                                                                 | `link`   |
| `updateFailed`   | `fromVersion` (empty when unknown), `toVersion`, `reason`, `failedAt`                   | none     |
| `breakingUpdate` | `currentVersion`, `version`, `releaseUrl`, `publishedAt` (empty when GitHub names none) | none     |

`callerName` is the phone-book name for the caller's number, empty when no contact has it
(`directory`), so `{{#if callerName}}` chooses the wording. The voicemail audio is attached to the
`voicemail` mail as MP3 or Opus; a template cannot change that.

A `mailTemplates.put` is refused with 422, naming the problem, when any of the three parts uses a
placeholder its kind does not offer, a disallowed helper or a partial, or when no part uses a
required placeholder: a `setup` or `reset` mail without its `link` would be useless.

```json
{
  "subject": "Missed call from {{#if callerName}}{{callerName}}{{else}}{{callerNumber}}{{/if}}",
  "bodyText": "Hello {{recipientName}},\n\n{{callerNumber}} called {{didLabel}} on {{date receivedAt}}.\n\n{{companyName}}",
  "bodyHtml": null
}
```

## Recipients and the relay

A user's mailbox mails its user; a ring-group mailbox mails every member, nested user groups
included, in blind copy. Mail needs a relay (`settings.smtpHost` and the related settings, owner
only). Without one nothing is sent, `mailTemplates.test` answers `skipped`, voicemail and
missed-call mails are dropped (MWI and the `voicemail.new` event still happen, `webhooks`), and
`users.create` (`POST /users`) and `users.resetPassword` (`POST /users/{id}/resetPassword`) return
the set-password link for the admin to pass on, as they do with a relay too. A failing relay is
retried in process over about three and a half minutes before the mail is dropped and `test`
answers `failed`, so a test against a broken relay takes that long to return. `sent` means the
relay accepted the mail, not that it arrived.
