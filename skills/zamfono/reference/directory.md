# Directory

The company phone book, the contacts, and the search that finds a colleague, a ring group or a
customer by name, extension or number.

## The phone book

A contact is a tenant-wide phone-book entry: `displayName`, optional `company` and `email`, and
`phones`, a list of `{ "label": "Mobile", "number": "+43 664 1234567" }`. Every user sees the
same book; there are no personal contacts.

- `contacts.list` (`GET /api/v1/contacts`, paginated, by name) and `contacts.get`
  (`GET /api/v1/contacts/{id}`) are open to every user.
- `contacts.create` (`POST /api/v1/contacts`), `contacts.update` (`PATCH /api/v1/contacts/{id}`) and
  `contacts.delete` (`DELETE /api/v1/contacts/{id}`, a soft delete, `guardrails`) are `admin`.

**Numbers are normalized on write**, like a DID's: spaces, dashes and brackets are dropped and a
national number becomes international with `settings.country`, so `0664 123 45 67` for an
Austrian tenant is stored as `+436641234567`. A number that cannot be resolved, digits that are no
valid number as dialled in that country, is refused with 422, as is a number or a label that
appears twice in one contact. The same number may belong to several contacts.

**`phones` is replaced as a whole.** A `contacts.update` that includes `phones` replaces every
number of the contact with the list sent, so adding one number means sending the existing ones
too; leaving `phones` out keeps them. `company` and `email` are cleared with `null` and kept when
left out.

## Caller names

When a call arrives, its caller's number is looked up in the phone book, exactly as stored,
deleted contacts excluded. The contact's `displayName` is then:

- the caller-ID name shown on the softphones and desk phones that ring, for a direct call and a
  ring group alike;
- `{{callerName}}` in the voicemail and missed-call mails (`mail-templates`), and among the
  values a `sip` target's headers can carry (`forward-to-ai-agent`).

A number no contact holds, or a withheld one, gives no name, and the mails' `{{callerName}}` is
empty. The call history and the `voicemails` rows store the number only, so a name added later
shows from the next call on, and a client that lists past calls looks numbers up itself, for
instance with `search.query`.

## Search

`search.query` (`GET /api/v1/search?q=`, role `user`) is the type-ahead behind a search bar: one
query, matched case-insensitively as a substring, against

- users: name and extension, and e-mail for an `admin` or `owner`;
- ring groups: name and extension;
- contacts: display name, company and every phone number.

```json
{
  "items": [
    {
      "kind": "user",
      "id": "…",
      "label": "Anna Huber · 101",
      "matched": "name"
    },
    {
      "kind": "contact",
      "id": "…",
      "label": "Huber GmbH · +4319876543",
      "matched": "phones"
    }
  ],
  "nextCursor": null
}
```

`kind` is `user`, `ringGroup` or `contact`, `label` the text to show and `matched` the field of
the resource that hit, as that resource names it (a user's `name`, `extension` or `email`, a ring
group's `name` or `ext`, a contact's `displayName`, `company` or `phones`), so a client renders one
mixed list and links each item to its resource. A pasted number finds the contact whatever its
spelling: `+43 1 987 6543`, `01 987 6543`, `9876543` and `(01) 987` all find the contact above.
Deleted rows never appear. Like every list, the hits are paged with `limit` and `cursor`.
