# E-Sign (internal e-signature engine)
_Last verified against code: 2026-06-27b — Claude (**SHIPPED TO PRODUCTION** — schema migration applied on prod (7 tables + `increment_esign_signed_count` + 7 RLS policies) and code merged to `main` @ `f398ee24`. Smoke-tested live: signer page 200, signer API queries `esign_signers` cleanly, worker asset served, staff editor auth-gated. TD-first (`origin='staff'`) is the only live flow; the client product is still Phase 5.)_
_Prior: 2026-06-27 — Claude (built Phases 0–4 + in-portal signing on branch `claude/exciting-archimedes-28b4c7`; sandbox)_

## What it is
An in-house e-signature system (Dropbox Sign / DocuSign class), **built internally — no external signing provider**. Staff upload a PDF in the CRM (**Tools → E-Sign**), visually place fields (signature / initials / date / text / checkbox), name one or more signers, and send. Each signer gets a unique link, signs in the browser, and when the last required signer signs the server flattens the values into the PDF, appends a Certificate of Completion, and files the signed PDF into the owning account's documents.

It is built **multi-tenant from day one** (`owner_account_id` + `origin` on every envelope) so the same engine can later power a **portal client product** (clients send e-sign to their own third parties). **Today only `origin='staff'` (TD-first) flows are live.** The client product (per-account sender settings, SES, quotas, adversarial isolation tests, cohort ramp) is **Phase 5 — not built**.

> **Status:** LIVE on production (2026-06-27). The schema migration `scripts/migrations/20260626-1500-esign-schema.sql` was applied to prod via the Supabase SQL editor (prod DDL through `execute_sql` is blocked by R105 — confirmed again at ship time; see `reference_prod_ddl_via_supabase_dashboard`), and the code is on `main`. Only TD-staff (`origin='staff'`) flows are live; the portal client product remains Phase 5 (gated by `esign_account_settings.esign_enabled`, default false).

## Business rules
- **Build internally, no external provider** (explicit decision — full control, no per-envelope fees, no client data leaving the stack).
- **TD-first.** TD is the only live sender; existing **Gmail** is the send backend behind the `sendSignerInvite` abstraction. SES + `noreply@esign.tonydurante.us` is a Phase-5 backend swap, not a rewrite.
- **Envelope is immutable after `sent`** (fields/signers locked — the snapshot model).
- **Routing:** `sequential` (default) or `parallel`. Sequential invites the next signer only when the prior one signs (chained via `enqueueJob`).
- **Expiry:** `expires_at` (default 14 days, configurable). Past-expiry envelopes flip to `expired` and links are rejected.
- **The signing artifact is legal evidence:** every event (created/sent/viewed/signed/declined/completed/voided/reminder_sent) is written server-side with IP + user-agent into `esign_events`; the Certificate of Completion records per-signer name/email/IP/UA/timestamp + document hash.

## How it's built
### Tables (all `esign_*`, created in `scripts/migrations/20260626-1500-esign-schema.sql`)
- **`esign_envelopes`** — the parent. `token`, `access_code`, `owner_account_id`, `origin ('staff'|'client')`, `contact_id`, `service_delivery_id`, `template_id`, `document_name`, `pdf_storage_path`, `signed_pdf_path`, `signed_pdf_drive_id`, `certificate_path`, `page_count`, `routing_order`, `status (draft→sent→in_progress→completed | declined/voided/expired)`, `signed_count`, `total_signers`, `expires_at`, `completed_at`, `voided_at`.
- **`esign_signers`** — one row per signer. `envelope_id` (FK, cascade), `signer_index` (unique per envelope), `signing_order`, `name`, `email`, `contact_id` (NULL for third parties), `access_code` + `token` (unique, per-signer), `status (pending→sent→viewed→signed | declined)`, consent fields, `sent_at/viewed_at/signed_at/declined_at`, `view_count`, `signed_by_name`, `signature_image_path`, `initials_image_path` (separate asset), `last_ip`, `last_user_agent`.
- **`esign_fields`** — one row per placed field. `signer_id`, `field_type CHECK (signature|initials|date|text|checkbox)`, `page_index`, `pos_x/pos_y/width/height` (numeric, **normalized 0..1, top-left origin**), `required`, `value`, `filled_at`, `font_size`.
- **`esign_events`** — append-only legal trail (server-written only).
- **`esign_templates` / `esign_template_fields`** — reusable layouts scoped by `owner_account_id`.
- **`esign_account_settings`** — per-account sender name / reply-to / quota (Phase-5 surface; rows exist but only TD flows today).
- **RPC `increment_esign_signed_count(envelope_uuid)`** — atomic last-signer completion gate.

### Key files
- **Coordinates:** `lib/esign/coordinates.ts` — `normalizedToPdfRect` (the Y-flip from 0..1 top-left to pdf-lib bottom-left points; **refuses rotated pages**), plus DOM↔normalized helpers. The single highest-risk transform; fully unit-tested.
- **Flatten + certificate:** `lib/esign/flatten.ts` (`flattenEsignPdf`) + `lib/esign/certificate.ts` (`appendCertificatePage`). **Text/date use `lib/pdf/unicode-fonts.ts` (DejaVu Sans), NEVER `StandardFonts.Helvetica`** (which crashes on accented names / €).
- **Upload safety:** `lib/esign/upload-guard.ts` — `validatePdfUpload` (magic-byte PDF check, size/page caps) + a `scanForMalware` seam.
- **Send:** `lib/esign/send.ts` — `buildSignerInviteEmail` (RFC2047 subject, bilingual EN/IT, HTML-escaped) + `sendSignerInvite`. The provider abstraction.
- **Link base:** `lib/esign/link-base.ts` — `chooseLinkBase` / `originFromHeaders`. **Signing links use the request origin on preview/sandbox; `APP_BASE_URL` only in production** (R005) — this fixes the "signing link points to prod" bug.
- **Reminders:** `lib/esign/reminders.ts` — `runEsignReminders(now)` (time-travel-testable; expiry + reminder cadence).
- **Orchestration:** `lib/operations/esign.ts` — `createEsignEnvelope`, `flattenEnvelopeToSignedPdf`, `finalizeEsignCompletion` (files the signed PDF into account documents + support email; idempotent), template create/get/list. Uses `const db = supabaseAdmin as any` (esign_* not in generated types).
- **Durable send:** `lib/jobs/handlers/esign-send-email.ts`, registered as `esign_send_email` in `lib/jobs/registry.ts`. Email rides the live **`job_queue`** (`lib/jobs/queue.ts`) — **NOT `email_queue`** (that is a Gmail-draft approval queue, wrong shape). Send is enqueued, never inline.
- **Staff UI:** `app/(dashboard)/tools/esign/{page,new/page,new/esign-editor,[id]/page}.tsx`. The editor (`esign-editor.tsx`) renders the PDF with `pdfjs-dist` and captures drag-drop field placement.
- **Staff API:** `app/api/esign/envelopes/**` + `app/api/esign/templates/**` (gated by `isDashboardUser`).
- **Signer page (public):** `app/sign/[token]/[code]/page.tsx` + `app/api/sign/[token]/{fetch,pdf,submit,decline}/route.ts`. Token + per-signer access code; **no Supabase auth**. `submit` does the TOCTOU guard + atomic RPC + flatten + finalize + sequential chaining. Supports `?preview=td` (admin skip) and `?portal=true` (embedded — posts `{type:'document-signed'}` to the parent on completion).
- **In-portal signing:** `app/portal/sign/esign/page.tsx` resolves the logged-in client's pending signer **by login email** and embeds `/sign/{token}/{code}?portal=true` via `PortalDocumentClient`. `app/portal/sign/page.tsx` adds matching e-sign items to the "To sign" list.
- **Cron:** `app/api/cron/esign-reminders/route.ts` (`vercel.json`, every 6h).
- **Shared components:** `components/esign/{pdf-viewer,signature-pad-modal,copy-field,send-button}.tsx`.

### Data flow (staff single-signer happy path)
1. Staff upload PDF → `validatePdfUpload` → stored at `pdf_storage_path`; envelope created `status='draft'`, `origin='staff'`, `owner_account_id` from the account picker.
2. Staff place fields (normalized coords) + name signer → Create → fields saved as a bulk replace.
3. Send → `esign_send_email` job enqueued → `sendSignerInvite` (Gmail) → signer `status='sent'`, `sent_at` set, `esign_events` row.
4. Signer opens `/sign/{token}/{code}` → `fetch` validates the code, returns only that signer's fields + the PDF → signs (signature_pad) → `submit`.
5. `submit`: TOCTOU `status <> 'signed'` guard + `increment_esign_signed_count` RPC. When it's the last required signer → `flattenEnvelopeToSignedPdf` (values + Certificate, unicode font) → `finalizeEsignCompletion` files the signed PDF into the account's documents + support email. Envelope → `completed`.

## Gotchas, invariants & past bugs
- **Middleware public paths (production-breaking if missed):** `/sign/`, `/api/sign/`, and the pdfjs worker `/esign/pdf.worker.min.mjs` MUST be in `PUBLIC_PREFIXES` in `middleware.ts`, or external signers get 307'd to the staff login and the PDF won't render. Caught only by **real-browser E2E** — handler-level tests bypass middleware. See `auth-oauth.md` and `reference_middleware_public_paths_and_browser_e2e`.
- **Signing-link base:** never hardcode `APP_BASE_URL` for the link — it points to prod and breaks sandbox QA. Use `chooseLinkBase` (request origin off-prod).
- **Coordinate transform is the top functional risk** — Y-flip + DPR + rotation. `normalizedToPdfRect` refuses rotated pages rather than mis-rendering. Verify a flatten by **opening the PDF**, not by replicating the math.
- **Unicode flatten crash** — pdf-lib's WinAnsi `StandardFonts` throws on accented names / €. All text/date rendering goes through `lib/pdf/unicode-fonts.ts`.
- **Initials ≠ signature** — stored as a separate asset (`initials_image_path`).
- **Double-submit / completion race** — guarded by the `status <> 'signed'` TOCTOU check + the atomic `increment_esign_signed_count` RPC (cloned from `increment_oa_signed_count`).
- **Tenant isolation is enforced in APP CODE, not RLS** — the portal uses `supabaseAdmin` (service role, bypasses RLS). Portal reads must filter by the right account/identity. RLS on `esign_*` is defense-in-depth only.
- **In-portal signer match is by login email** (`auth.users.email = esign_signers.email`), because TD-first signers carry an email but no `contact_id`. The embed page re-checks the email before exposing the link — a client cannot open another's link via the portal.
- **`job_queue`, not `email_queue`** for sending (verified: `email_queue` is a human-approval Gmail-draft queue).
- **Sandbox blocks outbound email** (`gmail.ts` SANDBOX_MODE) — never QA delivery in sandbox; verify the queued job + DB state instead (`reference_sandbox_blocks_outbound_email`).
- **`esign_*` are not in the generated Supabase types** — every server query casts `supabaseAdmin as any`.
- **Coexists with the legacy `signature_requests` / Form 8879 path** — that was deliberately NOT extended (it's read/written client-side by a live anon page). Don't conflate the two.

## How to verify current state
- **Schema present (sandbox):** `psql "$SANDBOX_DB" -c "\dt esign_*"` (7 tables) and `\df increment_esign_signed_count`. Production: confirm the migration was promoted before assuming the tables exist.
- **Active routes:** `find app/api/esign app/api/sign -name route.ts` and `find "app/(dashboard)/tools/esign" app/sign app/portal/sign/esign -name '*.tsx'`.
- **Middleware allowlist:** confirm `/sign/`, `/api/sign/`, `/esign/pdf.worker.min.mjs` are in `PUBLIC_PREFIXES` (`middleware.ts`).
- **Send handler registered:** grep `esign_send_email` in `lib/jobs/registry.ts`.
- **Cron registered:** grep `esign-reminders` in `vercel.json`.
- **Unit tests:** `npm run test:unit` (coordinates, flatten/unicode, upload-guard, certificate, link-base, send).
- **Real-browser proof:** `tests/e2e/esign-editor.spec.ts` + `tests/e2e/esign-signer.spec.ts` (run against a local server on :3000 with sandbox `.env.local`; these are untracked dev tools).
