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

**Embedded signing (3.2) has not been captured at all.** The steps exist —
`embed-invite-400` through `embed-cleanup` in `tools/capture_signnow.ts` — and
nobody has run them. Nothing in `src/` may be written against embedded invites
until they have been, and no `embedded-*.json` file appears in this directory:
rule 2 is the whole reason this folder exists, and the v2 family is exactly the
sort of thing the eighteen findings above were all about.

Run `embed-invite-400` first. It is free, it uses the shared document, and if
embedded signing is not on the trial plan it answers 402/403 with an upgrade
message — which is the cheapest possible way to learn that, and the fixture is
then the evidence for a purchase decision rather than a dead end. Only spend
`--yes-embed-invites` once that step has answered a validation error instead.

Three questions the capture has to settle, none of which the documentation can
be trusted for:

1. **Does the create response carry per-signer ids?** The v1 invite answers
   `{"status":"success"}` with nothing to correlate (finding 14), which is why
   `SentInvite` records that it yields nothing. If v2 does return ids, per-signer
   correlation becomes possible for the first time and the webhook
   `content.invite_id` can finally be matched to a party.
2. **Does `order` gate an embedded link?** Finding 6 established that the
   invite's `order` drives the sequence on the *email* family. `embed-link-order2`
   mints a link for signer 2 before signer 1 has signed. If it works, embedded
   signing is parallel and sequential signing is *lost* by moving to it — which
   contradicts build plan 3.1 and the duplicate-position rejection in
   `resolveSigners`, and is a product decision rather than an implementation one.
3. **Does the webhook sequence change?** Finding 15 says signNow chains the next
   invite itself, evidenced by `webhook.05`. Embedded emails nobody, so
   `user.document.fieldinvite.sent` may not fire at all. Re-run
   `tools/signnow_subscriptions.ts sync <url> --prune`, then
   `tools/capture_signnow_webhooks.ts`, sign both signers, and diff the sequence
   against `webhook.01`–`webhook.07`. "Identical" is itself a finding worth
   writing down.

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
