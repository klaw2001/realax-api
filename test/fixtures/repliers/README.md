# Captured Repliers responses

Real responses from `api.repliers.io`, captured 2026-09-01 with the key in
`realax-api/.env`. The Zod schemas in `src/integrations/repliers/schema.ts`
are built from these, not from documentation — see rule 2 in `CLAUDE.md`.

| File | Request |
|---|---|
| `search-listings.json` | `GET /listings?pageNum=1&resultsPerPage=2` |
| `search-listings-empty.json` | `GET /listings?city=Toronto&pageNum=1&resultsPerPage=2` |
| `get-listing.json` | `GET /listings/ACT8714298` |

Two edits to what came back, both recorded here so the files are not mistaken
for byte-exact captures:

- `listings[].agents` / `agents` removed. It carries listing agents' names,
  phone numbers and brokerage addresses. Nothing in this codebase reads it,
  so there is no reason to keep third-party contact details in the repo.
- `search-listings.json` holds two listings because that is what the request
  asked for; the envelope around them is untouched.

**The key returns US data, not TRREB.** Every listing is Austin/Charlotte/
Nashville, `boardId: 110`, MLS numbers like `ACT8714298` and `RECIR...` —
three to five letters then digits. A query for `state=ON` returns
`count: 0`. The build plan's TRREB pattern (one letter, 7–8 digits, e.g.
`C5839471`) matches nothing in this dataset. Both patterns are handled in
`client.ts`; the Ontario one is unexercised until the key is switched.
