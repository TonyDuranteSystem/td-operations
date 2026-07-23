# Lease & Operating Agreement (OA)
_Last verified against code: 2026-07-23 — Claude (OA read-before-signing DRAFT download + "I signed by hand" path with optional scan upload — see "OA draft download & sign-by-hand" below; branch `claude/oa-filing-uses-recorded-path`)_
_Prior: 2026-07-07b — Claude (MMLLC entity-type normalization fix + portal self-service OA + Intercompany Agreement wiring — see the OA/ICA sections below; branch `claude/optimistic-dhawan-f7595e`)_
_Prior: 2026-07-07 — Claude (Drive duplicate-upload sweep, LT Program incident class — the lease-signed and oa-signed webhooks' signed-PDF uploads (+ both lease-regen routes) switched from `uploadBinaryToDrive` to `uploadBinaryToDriveUpsert` (stable file name → a retry/re-run refreshes the ONE existing Drive file in place instead of adding a copy). No other behavior in this subsystem touched; full sweep rationale in `documents.md` (2026-07-07b). Branch `claude/objective-cohen-b75f61`.)_
_Prior: 2026-06-24 — Claude (oa-signed webhook: corrected stale v2 stage name "Post-Formation" → "Articles Received" in the post-formation milestone breadcrumb; prior full read 2026-05-29 of lib/mcp/tools/lease.ts, lib/mcp/tools/oa.ts)_

## What it is
Two client documents TD generates, sends, and tracks to signature:
1. **Lease** — the registered business-address / virtual-office lease TD provides to the client (annual, per `contract_year`).
2. **Operating Agreement (OA)** — the LLC's operating agreement (SMLLC or MMLLC), generated from CRM account data.

Both follow the same pattern: create a record → send a tokenized link via Gmail (with open tracking, through `safeSend`) → client views/signs → a signed webhook records it.

## Lease
- Tools (`lib/mcp/tools/lease.ts`): `lease_create`, `lease_get`, `lease_list`, `lease_update`, `lease_send`, `lease_agreements`.
- **Status lifecycle:** `draft → sent → viewed → signed → active → expired`.
- `lease_send` **approves + sends immediately** (not a draft) via Gmail with open tracking, sets status `sent`, requires `tenant_email`. Use `gmail_track_status` to confirm the client opened it. Uses `safeSend` (R037).
- Link: `${APP_BASE_URL}/lease/{token}/{access_code}`. Signed webhook: `app/api/lease-signed/route.ts`. PDF (re)generation: `app/api/lease-regen-drive`, `app/api/crm/admin-actions/regen-lease-pdf`.
- `leases` columns: `token`, `access_code`, `tenant_company`, `suite_number`, `status`, `contract_year`, `term_start_date`/`term_end_date`, `monthly_rent`/`yearly_rent`, `view_count`, `signed_at`, `tenant_email`.

## Operating Agreement (OA)
- Tools (`lib/mcp/tools/oa.ts`): `oa_create` (from CRM account data; SMLLC or MMLLC), `oa_get`, `oa_send` (Gmail + tracking, `safeSend`), `oa_agreements`, `oa_id`, `oa_signatures`.
- **Only supported states** — `OA_SUPPORTED_STATES` (`lib/types/oa-templates.ts`) gates which states have an OA template.
- Tokenized link + access code. Signed webhook: `app/api/oa-signed/route.ts`.
- **Three creation paths** (all insert `oa_agreements`):
  1. MCP `oa_create` (staff, free-form members params for MMLLC).
  2. CRM button (`app/api/crm/admin-actions/generate-document/route.ts::generateOA`) — MMLLC members come from the **`members` table** (real `ownership_pct`, company members included; individual address falls back to `contacts.residency`). Errors if an MMLLC has no members rows or ownership ≠ 100%. Never fabricates an even split (Datavora incident, 2026-05-25).
  3. Portal self-service (`app/api/portal/operating-agreement/create/route.ts`) — client "Create & Send for Signing" in `/portal/documents/generate`. MMLLC: reads `members` table, requires every member to have `contact_id` (they must sign), ownership must total 100%, creates one `oa_signatures` row per member and portal-chats each a per-signer link.

### ⚠️ Entity-type normalization — MANDATORY invariant
`accounts.entity_type` stores **long form** ("Single Member LLC" / "Multi Member LLC" / "C-Corp Elected") — the value 'MMLLC' NEVER appears in accounts. `oa_agreements.entity_type` stores the **short code** ('SMLLC'/'MMLLC'). ANY comparison of an entity type string against 'MMLLC' MUST go through `normalizeEntityType()` (`lib/portal/entity-type.ts`). **Precedent (2026-07-07, Umberto Moretti / Azarexa):** the portal create route compared raw `accounts.entity_type === 'MMLLC'` — false for every account — so every portal-generated OA was built single-member with the primary contact at 100%, ignoring the members table; Datavora LLC signed a legally wrong OA. Fixed in: portal create route, `app/operating-agreement/[token]/[code]/page.tsx`, `app/portal/sign/page.tsx`, `app/portal/sign/oa/page.tsx`, `generate-documents-client.tsx`.

## Intercompany Transfer Agreement (ICA)
- Generator: `lib/pdf/intercompany-agreement-pdf.ts` (operating LLC ↔ treasury/holding member company). CRM wiring: `lib/operations/intercompany.ts` — `assembleIntercompanyInput()` (pure, unit-tested) + `generateIntercompanyForAccount()`.
- **All data from CRM**: operating company from `accounts`; treasury from the `members` row with `member_type='company'` (ownership_pct, address, EIN) with fallback to the treasury company's own `accounts` row matched by name (EIN / address / state_of_formation). Missing data → hard error naming the field, never a default.
- Entry points: CRM account page → Documents to Sign panel → "Intercompany Agreement" row (only shown for MMLLC accounts) → `generate_intercompany` action in `generate-document/route.ts`. Output: PDF filed to the account Drive folder + portal-visible `documents` row.

## Business rules
- **R037** — `lease_send` / `oa_send` go through `safeSend()` (idempotency check → send → status update after).
- **R012 / R005** — client links use `APP_BASE_URL` (`app.tonydurante.us`), never the internal domain.
- **R035** — test a lease/OA via `?preview=td` before sending.
- **OA only for supported states** — an unsupported state has no template; `oa_create` will reject/skip.

## How it's built — key files & tables
- Files: `lib/mcp/tools/lease.ts`, `lib/mcp/tools/oa.ts`, `lib/types/oa-templates.ts` (`OA_SUPPORTED_STATES`), `app/api/lease-signed/route.ts`, `app/api/oa-signed/route.ts`, `app/api/lease-regen-drive/route.ts`, `app/lease`, `lib/mcp/safe-send.ts`, PDF generation in `lib/pdf/`.
- Tables: `leases`, the OA/operating-agreement table, signature/signature-request records, `accounts`, `contacts`.

## OA public pages — how data reaches the browser (2026-07-22)

**The two public OA pages MUST NOT read `oa_agreements` / `oa_signatures` with the anon key.**
They go through `GET /api/operating-agreement/[token]/fetch`, which holds the service key,
verifies the access code SERVER-SIDE, and returns the whitelist in `lib/oa/public-view.ts`.

Why (dev job 023c7d06): both pages used to `select('*')` with the anon key and compare the
access code in the BROWSER — i.e. after the row had already been delivered. Policies were
`USING (true)` for role `public` and `anon` held SELECT on both tables. Tokens are
`${companySlug}-oa-${year}`, derivable from a company name that is public in state
registries. One unauthenticated PostgREST request therefore returned, across ALL agreements:
`access_code`, `ein_number`, `member_email`, `member_address`, the members blob — and every
co-signer's personal signing code, which is the credential that authorises signing AS that
member. Reproduced and then verified closed on an isolated local stack seeded with
production's exact policy set (`scripts/migrations/20260722-0100-oa-close-public-read.sql`).

Rules that follow:
- **Never widen `toPublicAgreement` / `toPublicSignature` by spreading a row.** `assertNoSecrets`
  throws on `access_code` / `member_email` / `email` / `account_id` / `contact_id`, including
  inside nested JSONB — the `members` blob carried member emails and was caught only by
  inspecting the route's real output, not by reading the mapper.
- **`tests/unit/anon-grant-contract.test.ts` is the gate.** It derives the browser's anon
  privilege needs from the code. If it fails, the code's needs changed — reconcile it
  deliberately, and never revoke a grant on the strength of a grep.
- **Admin preview cannot sign.** `canSign` excludes `isAdmin`, and the route requires a real
  staff session via `isStaffPreview` (2026-07-21 incident) — the query flag alone proves nothing.
- **New public/token-gated routes need a `middleware.ts` PUBLIC_PREFIXES entry** or they 307 to
  the staff login. This one did, and only a real request surfaced it.

**STILL OPEN — `anon` retains UPDATE on both tables.** The signing page still writes its
signature row, the counter and the final status straight from the browser, so an attacker who
guesses a token can corrupt an agreement. Closing it means moving those writes server-side
first; the read fix does NOT close it. Separately open: the signing-integrity defects
(browser-side finalization, no server reconciliation) — see the council review on that job.

## OA draft download & sign-by-hand (2026-07-23)
A client can complete an Operating Agreement three ways from the signing page (all three render **inside the portal iframe** too — the download used to be hidden whenever `?portal=true` was set, i.e. on every route a client actually uses):
1. **Sign online** — the existing e-sign flow.
2. **Download the draft** — `GET /api/operating-agreement/[token]/pdf?code=<code>`. Renders the agreement ON DEMAND (nothing stored) and is **DRAFT ONLY, never executed**. That single rule dissolves the whole class of review blockers: it reads no signature images (so it never touches the anon-writable `signed-oa` bucket with the service key), it is not a second producer of the signed instrument, and `generateOperatingAgreementPDF({ draft: true })` stamps every page + rewrites the preamble and the IN WITNESS WHEREOF recital to their **unexecuted** form so the copy cannot be passed off as signed. Gates (all AFTER the code check): voided → 410, signed → 409, plus a per-request rate limit.
3. **"I signed it by hand"** — `POST /api/operating-agreement/[token]/hand-signed` (multipart; optional `file`). Marks the agreement `signed` with **`signature_method='by_hand'`** and leaves `pdf_storage_path` NULL (TD holds no executed instrument unless the client uploads a scan). Files the unsigned draft named "(Unsigned Copy — client signed by hand)"; when a scan is uploaded THAT is filed as the signed copy. Emails support either "scan received" or "NO SIGNED COPY ON FILE — chase it". Filing is best-effort and escalates via `reportSystemError`; the client's confirmation is never undone by a Drive hiccup.

**`signature_method`** (`electronic` | `by_hand` | NULL) distinguishes an agreement TD holds a real signature for from one the client only *declared*. NULL = signed before the distinction existed (74 legacy rows, deliberately NOT backfilled). Migration `20260723-1200-oa-signature-method.sql`.

**Design note for the next session:** the on-screen SIGNED render still uses the browser html2pdf capture (pre-existing), so the executed PDF and this server draft are still two renderers — the draft download deliberately sidesteps that by refusing signed agreements rather than re-rendering them. Retiring the browser capture (have the sign POST call `generateOperatingAgreementPDF` server-side) is the follow-up that makes it one renderer; see `lib/operations/esign.ts` `flattenEnvelopeToSignedPdf` for the pattern.

## Gotchas, invariants & past bugs
- **`lease_send` sends a real email immediately** (not a Gmail draft) — don't call it to "preview." Use `?preview=td` for review.
- **OA generation is state-gated** — if the company's state isn't in `OA_SUPPORTED_STATES`, there's no template; add the template before generating.
- **Use `safeSend`** for any new lease/OA send path (R037) — mark "sent" only AFTER the send succeeds, with idempotency first.
- Lease is annual (`contract_year`) — a new year is a new lease record, not an edit of the old one.

## How to verify current state
- Read `lib/mcp/tools/lease.ts` + `lib/mcp/tools/oa.ts` (tool contracts + statuses), `app/api/lease-signed/route.ts` / `oa-signed/route.ts` (the sign events), `lib/types/oa-templates.ts` (`OA_SUPPORTED_STATES`).
- A client's lease/OA: `SELECT token, status, contract_year, signed_at FROM leases WHERE account_id='<id>';`
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
