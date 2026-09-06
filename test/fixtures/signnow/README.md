# Captured signNow responses

Real responses from `api.signnow.com`, captured 2026-09-04 against the trial
API account in `realax-api/.env`. The Zod schemas in
`src/integrations/signnow/` are built from these, not from documentation — see
rule 2 in `CLAUDE.md`.

Produced by `tools/capture_signnow.ts` and
`tools/capture_signnow_webhooks.ts`. Both are throwaway tools outside `src/`.

| File | Request |
|---|---|
| `oauth-token-unsupported-grant.json` | `POST /oauth2/token`, `grant_type=client_credentials` → **400** |
| `invalid-token.error.json` | `GET /user` with a bad bearer → **400** |
| `document-upload.json` | `POST /document`, multipart, the blank `forms/sources/decrypted/100.pdf` |
| `document-get.json` | `GET /document/{id}`, before any fields |
| `document-add-fields.request.json` | the body we sent to `PUT /document/{id}` |
| `document-add-fields.json` | `PUT /document/{id}` → 200 |
| `document-get-with-fields.json` | `GET /document/{id}`, after field placement |
| `user-get.json` | `GET /user` — trimmed, see below |
| `document-invite.error.json` | `POST /document/{id}/invite` with one malformed recipient address → **400** |
| `state.json` | the reusable document id, carried between capture steps |
| `document-invite.request.json` | the body we sent to `POST /document/{id}/invite` |
| `document-invite.json` | `POST /document/{id}/invite` → 200 |
| `webhook.01`–`webhook.07` | the callbacks of one complete two-signer signing run |

Embedded signing (build plan 3.2), captured 2026-09-07. A second document, so
the one above keeps its "fields but no invite" property:

| File | Request |
|---|---|
| `embedded-document-upload.json` | `POST /document`, the blank `100.pdf` again |
| `embedded-document-add-fields.request.json` | the body sent to `PUT /document/{id}` |
| `embedded-document-add-fields.json` | `PUT /document/{id}` → 200 |
| `embedded-document-get-with-fields.json` | `GET /document/{id}`, after field placement |
| `embedded-invite-create.request.json` | the body sent to `POST /v2/documents/{id}/embedded-invites` |
| `embedded-invite-create.json` | that call → **201**, with per-signer ids |
| `embedded-invite-create.error.json` | the same with one malformed address → **400** |
| `embedded-invite-link.json` | `POST .../embedded-invites/{id}/link` → 200. The link itself is redacted |
| `embedded-invite-link-order2.error.json` | the same for signer 2, out of turn → **403** |
| `embedded-invite-link.error.json` | the same for an invite id that does not exist → **404** |
| `embedded-document-get-after-invite.json` | `GET /document/{id}`, with the embedded invites on it |
| `webhook.embedded.01`–`.02` | the callbacks from signing one embedded envelope |

The two webhook files came from a different route than the rest: they were not
written by `capture_signnow_webhooks.ts` but read back out of `SignerEvent.payload`
after a real signature went through the running app, and redacted the same way
by hand. So there is no matching raw body in `logs/` and no signature to verify
against — the HMAC is already covered by `webhook.04`–`webhook.07`. What these
are evidence of is the event *sequence*, which is finding 24.

Embedded document id: `ded43080263d4830ba0172afbd0692bfe0248cad`. Unlike the one
above it **does** hold a live invite set — see the Open section before deleting
it.

The webhook run, in the order it arrived:

| # | event | signer | `content.status` |
|---|---|---|---|
| 01 | `user.document.fieldinvite.create` | signer 1 | `created` |
| 02 | `user.document.fieldinvite.create` | signer 2 | `created` |
| 03 | `user.document.fieldinvite.sent` | signer 1 | `pending` |
| 04 | `user.document.fieldinvite.signed` | signer 1 | `fulfilled` |
| 05 | `user.document.fieldinvite.sent` | signer 2 | `pending` |
| 06 | `user.document.fieldinvite.signed` | signer 2 | `fulfilled` |
| 07 | `user.document.complete` | — | — |

01–03 arrived unsigned, before the subscriptions were repaired; 04–07 carry a
verified `x-signnow-signature`. `fieldinvite.create` is captured but **not
subscribed to** — it fires for every signer at invite time and tells us nothing
`sent` does not.

Reusable document id: `08ba14321d484b30a3dd74a0bf3cd40d8dee71b8`. It has fields
and roles but **no invite**, so re-running the read-only steps costs nothing.

## Redactions

Everything is passed through `redact()` in `tools/capture_signnow.ts` before it
is written. The *shape* is preserved — a key holding `"<redacted>"` still proves
the key exists and is a string, which is all a Zod schema needs.

- Any key named `access_token`, `refresh_token`, `token`, `api_key`, `secret`,
  `secret_key`, `password`, `client_secret` → `"<redacted>"`.
- **Personal names** — `first_name`, `last_name`, `owner_name`, `signer_name`,
  `full_name` → `"<redacted>"`. `GET /user` and `GET /document` both return the
  account holder's real name. Rule 6 keeps client names out of logs and error
  messages; a file committed to the repo forever is no better a place for one.
- Email addresses → stable placeholders. The account owner becomes
  `owner@example.test`; capture signers become `signer1@example.test` /
  `signer2@example.test`; anything else becomes
  `redacted-<8 hex>@example.test`. Addresses are mapped rather than removed so a
  fixture still shows which signer an event belongs to.

One trim, recorded here so the file is not mistaken for a byte-exact capture:

- `user-get.json` keeps only the identity fields. The real response is ~17 KB,
  almost all of it subscription, team, organization and billing-period metadata
  that nothing in this codebase reads. Same reasoning as the `agents` removal in
  `test/fixtures/repliers/README.md`.

To check: grep this directory for the account's own address and for the mail
provider's domain. Both must return nothing. (The literal strings are not
written here, so that the check does not match this file.)

Also, before committing any `embedded-*.json`:

    grep -o 'https[^"]*' test/fixtures/signnow/embedded-*.json

Every hit must be a bare `https://api.signnow.com`. Anything with a path or a
query on it is a live signing link about to enter git history, where deleting it
later does not remove it — a credential that lets whoever reads the repository
execute a contract as somebody else. `redact()` should have turned it into
`<redacted-url>` already; a hit means it did not, and the fix is the redaction,
not the file.

Grepping the whole directory for URL-shaped tokens instead does **not** work,
and it is worth knowing why before someone writes that check and starts ignoring
it: `document-get.json` legitimately holds thumbnail URLs with the 40-hex
document id in the path, and they match every "long opaque segment" pattern
anyone would reasonably write. They are not credentials — fetching one needs the
bearer token — so they stay.

## Findings

These are the reasons the client is written the way it is. Each one contradicts
something a reasonable person would have assumed from the documentation.

**1. `client_credentials` is not a supported grant.** It answers 400
`invalid_request`. signNow supports `password`, `refresh_token` and
`authorization_code` only. For a backend acting as a single account — which is
what REALAX is — signNow's own guidance is a **non-expiring API key** from
API Dashboard → Apps and Keys → API Keys, used directly as
`Authorization: Bearer`. That is what `SIGNNOW_API_KEY` holds, and it is why
there is no token cache, no `expires_in` handling and no refresh logic in the
client. The password grant additionally only works for the *application owner*
(any other user gets code 11005001), so it would not have generalised anyway.

**2. An invalid token answers 400, not 401 — and the numeric code is useless.**
`invalid-token.error.json` is a 400 with `{"error":"invalid_token","code":1537}`.
`oauth-token-unsupported-grant.json` is a 400 with
`{"error":"invalid_request","code":1537}`. **The same `code` for two unrelated
failures.** So neither the HTTP status nor `code` separates "the key is wrong"
(`SignNowError('misconfigured')` — no retry can ever help) from "the request is
wrong" (`rejected`). Only the `error` string does. A client written from the
docs would have branched on 401 and misclassified every revoked key.

**3. Fields can be placed on the OREA PDFs, and roles are created implicitly.**
This was the largest open question: the OREA forms have no AcroForm fields at
all (`CLAUDE.md`). `PUT /document/{id}` with a `fields` array answered 200, and
the subsequent `GET` shows four fields and two roles that we never created
explicitly — signNow derives a role from the `role` name on each field and
assigns it a `unique_id`. That `unique_id` is what an invite has to reference,
which is why `SigningEnvelope.signers` carries `externalRoleId`.

**4. `PUT /document/{id}` REPLACES every field.** Per the docs: "If you use this
request with a document with fields, new fields will override the old ones." It
is not an append. The client must send the complete field set in one call.

**5. Fields can only be added before the document is sent.** So the ordering in
`createEnvelopeForForm` is fixed: upload → place fields → invite. There is no
adding a missed signer's field after the first invite goes out.

**6. Sequential signing comes from the invite, not from the role.** Both roles
came back `"signing_order": "1"` after field placement — the role-level default
is parallel, and `signing_order` is a **string**, not a number. What actually
gates signing is the required `order` integer on each entry of the invite's `to`
array: 1 signs first, and only then is 2 invited. So the role's own
`signing_order` is not what `EnvelopeSigner.order` maps to.

Also from the invite contract: **signNow permits several recipients to share an
order.** Rejecting a duplicate `signingOrder` in `resolveSigners` is therefore a
REALAX policy choice — two parties explicitly at position 1 means the agent's
intent is ambiguous and sequential signing cannot be honoured — not a vendor
limitation. Worth knowing before someone "fixes" it.

**9. There are TWO error envelope shapes, and they are not interchangeable.**
The auth layer answers `{"error": "invalid_token", "code": 1537}`. The API layer
answers `{"errors": [{"code": 65585, "message": "Email is invalid"}]}` — plural
key, array, `message` instead of `error`. A client that parses one shape will
read `undefined` from the other and misreport every failure of that class. Both
arrive as HTTP 400.

**10. `GET /user` has no `email` field.** It returns `primary_email` and an
`emails` array of plain strings. This matters because an invite's `from` must be
the login email of the account owning the key, and sending an empty one is
answered `From must not be empty` — which names the symptom, not the cause. The
sender is fetched at call time rather than configured, so there is one fewer
value in `.env` that can drift out of step with the key beside it.

**7. Page geometry is 1:1 with PDF points.** signNow reports each page as
`{"width":612,"height":792}`, matching the Letter-size media box in
`forms/templates/100.json`. Field positions are in pixels at 72 DPI, so one
signNow pixel is one PDF point and no scaling is needed — only an origin flip.

**8. Document ids are 40 lowercase hex characters.** They satisfy `SAFE_SEGMENT`
(`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`) in `src/lib/s3.ts`, so `keys.auditTrail()`
will not throw on one in 3.4. The client validates this anyway, at creation
time, because the guarantee is ours to keep rather than the vendor's.

**11. The y-origin is TOP-LEFT — confirmed by signing, not by reading.** Our
template `bbox` is PDF user space: origin bottom-left, y increasing upward,
`[x0, y0, x1, y1]`. The conversion is `y = pageHeight - y1`. Verified by placing
the `execution.buyer1` and `execution.seller1` fields, having both parties sign,
and rendering page 5 of the result: both signatures land on their execution
lines. The docs never state the origin, and the pre-signature `download` could
not settle it — an unsigned field draws nothing, so the download is
byte-for-byte the blank form.

**12. Field placement is one-indexed for us, zero-indexed for signNow.**
`page_number` counts from 0. Our template's `page` counts from 1.

**13. The webhook payload is NESTED, and there are two content shapes.**
Everything is under `meta` and `content`; there is no top-level `event`:

```json
{ "meta":    { "event": "user.document.fieldinvite.signed", "timestamp": 1788517139,
               "callback_url": "...", "initiator_id": "..." },
  "content": { "document_id": "08ba…71b8", "invite_id": "ee8f…f86d",
               "signer": "signer1@example.test", "status": "fulfilled" } }
```

`user.document.complete` carries a **different** content shape —
`{ document_id, document_name, user_id }`, with no `invite_id` and no `signer`.
`content.document_id` is the only field common to both, which is what makes
resolve-by-`externalId` the correct lookup. `include_metadata` was `false` on
every subscription anyway, so the metadata route was never available.

**14. `content.invite_id` exists per signer, though the invite response has no
ids at all.** `POST /document/{id}/invite` answers exactly `{"status":"success"}`
— no invite id, no signer ids, nothing to correlate with. The per-signer
`invite_id` only ever appears on the events. So `SentInvite` has nothing useful
to return, and per-signer correlation is built from the events plus the role ids
read back after field placement.

**15. signNow chains the sequence itself.** The captured order was: two
`fieldinvite.create` at invite time (both signers), `fieldinvite.sent` for signer
1 only, `fieldinvite.signed` for signer 1, then **`fieldinvite.sent` for signer 2
without us doing anything**, `fieldinvite.signed` for signer 2, then
`document.complete`. Inviting the next signer is not something 3.2 has to
implement.

**16. The HMAC is confirmed against real payloads.** `base64` of the **raw**
sha256 digest — not base64 of the hex string. Events 04–07 in the capture run
verified byte-for-byte against `SIGNNOW_WEBHOOK_SECRET`.

**17. Trial documents are watermarked "Development mode",** diagonally across
every page. A real Agreement of Purchase and Sale cannot be executed like this,
so the paid API plan is a prerequisite for the pilot, not merely a volume
decision. See `REALAX_BUILD_PLAN.md` blockers.

**18. A field invite is charged once per invite, not per signer.** Per signNow's
invite guide: "If multiple signers are included in one invite, it counts as a
single invite." Freeform invites are charged per signer instead — another reason
to stay on field invites.

**19. Embedded invites are NOT gated on the paid plan.** `POST /v2/documents/
{id}/embedded-invites` on the trial account answers **400** with
`19003008 "Email value is not a valid email address."` — a validation error
about the one field we deliberately broke, not a 402/403 upgrade wall. Captured
in `embedded-invite-create.error.json`.

Three things follow, and all three were open questions before this call:

- The v2 endpoint **exists and is reachable** on the trial. 3.2 is not blocked on
  buying the plan. The watermark (finding 17) still is, for the pilot.
- signNow **parsed the request body far enough to validate the email**, which
  means `invites[]` with `role_id`, `order` and `auth_method` was accepted
  structurally. That is weak evidence the request shape is right — weak because
  it only proves the body was not rejected outright, not that `order` is
  honoured. `embed-link-order2` is still what settles that.
- It is the **API-layer error envelope** (`{errors:[{code, message}]}`), the same
  one `document-invite.error.json` carries, and it parses against the existing
  `apiErrorSchema` unchanged. So there is no third envelope shape and
  `classify()` in `signnow.client.ts` does not need widening — a `rejected`, not
  a `misconfigured`.

**20. The embedded create response carries per-signer ids — the v1 invite's does
not.** `POST /v2/documents/{id}/embedded-invites` answers **201** with
`data[]` of `{id, email, role_id, order, status}`. Finding 14 records that the
v1 invite answers `{"status":"success"}` with nothing to correlate, which is why
`SentInvite` exists to say so. This is the opposite, and it is the single most
useful thing in this capture: `id` here is the `invite_id` the webhooks carry,
so **per-signer correlation is possible on the embedded path and impossible on
the email one.**

The two signers come back with *different* statuses — signer 1 `pending`,
signer 2 `created` — which is the first evidence that `order` is honoured rather
than accepted and ignored.

**21. The vendor enforces the signing turn itself.** Minting a link for signer 2
while signer 1 has not signed answers **403**, `19001028 "The field invite is
not pending or fulfilled."` So sequential signing survives the move to embedded;
it is not something 3.2 has to build, and the parallel-signing worry that would
have contradicted build plan 3.1 does not arise.

The API should still refuse first, with a message naming whose turn it is. A
signer-facing 502 that means "not your turn yet" is a worse answer than a 409
that says so, and the turn is derivable from `SignerEvent` rows without asking
the vendor.

An unknown invite id is a different code: **404**, `19002002 "Field invite not
found"`.

**22. The signing page can be put in an iframe.** `GET` on a minted link returns
no `X-Frame-Options`, no `frame-ancestors` directive, and its only CSP header is
`content-security-policy-report-only` — which is not enforced. So the embedded
flow the build plan asks for is actually available, rather than being a redirect
wearing an iframe's name.

Worth re-checking before the pilot: this is a header, not a contract, and a
vendor can add `frame-ancestors` in any release.

**23. `field_invites[].email` is not an email address.** On an embedded invite it
is the address followed by the API application's name in parentheses, and that
name contains the account holder's own username. `EMAIL_PATTERN` replaces the
address and leaves the parenthetical standing, so `redact()` has an
`APP_NAME_PATTERN` for it too. Anything parsing this field for an address has to
expect the suffix. (The literal form is not written out here, so that a grep for
it does not match this file — the same reason the addresses above are not.)

Embedded invites do appear in the document's `field_invites`, flagged
`is_embedded: true` with an `embedded_signer` object, so invite state is
readable from `GET /document/{id}` without keeping it ourselves.
`short_link_url` is `null` on them — there is no short link, because there is no
email to put one in.

**24. The webhooks are identical for an embedded signature, and the invite ids
match.** Captured by signing a real embedded envelope through the app:
`webhook.embedded.01` and `.02`. Three things, all of which could have gone the
other way:

- **`user.document.fieldinvite.sent` fires even though no email is sent.** The
  obvious guess was that it would not — the event is named after a delivery that
  does not happen here. It does, so `STATUS_FOR_EVENT` in `signing.service.ts`
  needs no embedded-specific branch and the envelope moves through exactly the
  states the email path moves through.
- **`content.invite_id` is the same id `POST /v2/…/embedded-invites` returned**,
  verified against the ids stored on the envelope. Finding 20 predicted this and
  it holds: per-signer correlation genuinely works on the embedded path, and
  `content.document_id` still matches `externalId`.
- **signNow chains the next signer here too.** Signing as signer 1 produced a
  `fieldinvite.signed` for signer 1 *and* a `fieldinvite.sent` for signer 2,
  within the same second and with no request from us. Finding 15 said this about
  the email family; it is now evidenced for embedded as well.

The two arrived out of order — `sent` for signer 2 recorded 26 ms *before*
`signed` for signer 1 — which is precisely the case `STATUS_RANK` exists for.
The envelope came to rest on `signed` rather than being walked backwards to
`sent`, without anybody having to think about it.

## Open

**Subscriptions had to be repaired, and can drift again.** The dashboard created
**53** subscriptions — every event in the catalogue — and put a `secret_key` on
**none** of them, which is why events 01–03 arrived with no
`x-signnow-signature` header at all. `tools/signnow_subscriptions.ts` is the
fix: `sync <callback-url> --prune` leaves exactly the five events this service
uses, each carrying the secret. Re-run it whenever the dev tunnel URL changes,
because the URL is part of the subscription.

**`user.document.fieldinvite.decline` and `user.invite.expired` are still
uncaptured.** Decline needs another billable invite; expiry needs days to
elapse. Their payload shapes are unverified, which is why
`webhook.controller.ts` parses only the two fields it acts on — `meta.event` and
`content.document_id` — and stores the whole body in `SignerEvent.payload`. A
strict schema would reject the event types we have never seen, and rejecting
means 4xx, and 30 of those in an hour costs us the subscription.

**Embedded signing (3.2) is captured, and every question it was run to answer
is settled.** Findings 19–24. Nothing about it is outstanding.

The only remaining unknowns are the two the email path also has:
`user.document.fieldinvite.decline` and `user.invite.expired` are still
uncaptured on either delivery mode, for the reasons above — a decline needs
another billable invite and an expiry needs days to pass.

**A signing link is a bearer credential.** Whoever holds one can execute the
contract as that signer, with no login. They are redacted out of every fixture
twice over — by key name in `SECRET_KEYS` and by shape in `OPAQUE_URL_PATTERN`,
because guessing the key name is not a security control — and printed to the
terminal instead. The shape rule over-matches knowingly: re-capturing
`document-get.json` with `--force` will redact its thumbnail URLs too, because
they carry the document id in the path and nothing separates that from a token
by shape alone. Losing a thumbnail URL costs nothing the id beside it does not
already give you; keeping a signing token costs a signature.

## Webhook fixtures

Written by `tools/capture_signnow_webhooks.ts`, and deliberately split in two:

- `webhook.<seq>.<event>.json` — **here, committed, redacted.** What the Zod
  schema is built from and what `test/signnow-webhook.test.ts` posts. The tests
  sign these bytes themselves with a test secret, so they never need signNow's
  own signature.
- `logs/signnow-capture/webhook.<seq>.<event>.raw.bin` and `.headers.json` —
  **not committed** (`logs` is gitignored). Byte-exact body and the real
  `x-signnow-signature`. Redacting a body changes its bytes and destroys the
  signature, which is why these cannot be one file. Their only job is to
  confirm once, by hand, that our HMAC reproduces signNow's — base64 of the
  *raw* sha256 digest, not base64 of the hex string. The capture server prints
  MATCHES / DOES NOT MATCH on arrival.
