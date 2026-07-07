# Lease & Operating Agreement (OA)
_Last verified against code: 2026-07-07 — Claude (Drive duplicate-upload sweep, LT Program incident class — the lease-signed and oa-signed webhooks' signed-PDF uploads (+ both lease-regen routes) switched from `uploadBinaryToDrive` to `uploadBinaryToDriveUpsert` (stable file name → a retry/re-run refreshes the ONE existing Drive file in place instead of adding a copy). No other behavior in this subsystem touched; full sweep rationale in `documents.md` (2026-07-07b). Branch `claude/objective-cohen-b75f61`, SANDBOX — Antonio ships.)_
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

## Business rules
- **R037** — `lease_send` / `oa_send` go through `safeSend()` (idempotency check → send → status update after).
- **R012 / R005** — client links use `APP_BASE_URL` (`app.tonydurante.us`), never the internal domain.
- **R035** — test a lease/OA via `?preview=td` before sending.
- **OA only for supported states** — an unsupported state has no template; `oa_create` will reject/skip.

## How it's built — key files & tables
- Files: `lib/mcp/tools/lease.ts`, `lib/mcp/tools/oa.ts`, `lib/types/oa-templates.ts` (`OA_SUPPORTED_STATES`), `app/api/lease-signed/route.ts`, `app/api/oa-signed/route.ts`, `app/api/lease-regen-drive/route.ts`, `app/lease`, `lib/mcp/safe-send.ts`, PDF generation in `lib/pdf/`.
- Tables: `leases`, the OA/operating-agreement table, signature/signature-request records, `accounts`, `contacts`.

## Gotchas, invariants & past bugs
- **`lease_send` sends a real email immediately** (not a Gmail draft) — don't call it to "preview." Use `?preview=td` for review.
- **OA generation is state-gated** — if the company's state isn't in `OA_SUPPORTED_STATES`, there's no template; add the template before generating.
- **Use `safeSend`** for any new lease/OA send path (R037) — mark "sent" only AFTER the send succeeds, with idempotency first.
- Lease is annual (`contract_year`) — a new year is a new lease record, not an edit of the old one.

## How to verify current state
- Read `lib/mcp/tools/lease.ts` + `lib/mcp/tools/oa.ts` (tool contracts + statuses), `app/api/lease-signed/route.ts` / `oa-signed/route.ts` (the sign events), `lib/types/oa-templates.ts` (`OA_SUPPORTED_STATES`).
- A client's lease/OA: `SELECT token, status, contract_year, signed_at FROM leases WHERE account_id='<id>';`
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
