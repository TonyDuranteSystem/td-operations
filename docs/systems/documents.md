# Documents & Storage
_Last verified against code: 2026-06-25 — Claude (`autoSaveDocument` (`lib/portal/auto-save-document.ts`) `confidence` was hardcoded to the numeric `1.0`, which VIOLATES the production `documents_confidence_check` CHECK constraint (`confidence IN ('high','medium','low')`) — so EVERY autoSaveDocument insert in production (ITIN W-7/1040-NR/Schedule OI, signed OA / lease / contract) failed and the error was swallowed by callers, the root cause of "docs in Drive but not in the documents table" (Daniel Pasztor). Sandbox has NO such constraint, which masked it across all prior testing. Fixed: `confidence: 'high'`. Verified against prod: constraint def = `CHECK (confidence = ANY (ARRAY['high','medium','low']))`, existing rows are 3670 'high' + 383 'low'. The companion `app/api/itin-form-completed` change (shipped in `fix/itin-workspace`) now checks autoSaveDocument's return and logs the real error instead of reporting "ok".)_
_Earlier 2026-06-20 — Claude (CRM **account Documents tab** now lists ALL `documents` rows for the account via a new `AccountDocumentsList` (`components/accounts/account-documents-list.tsx`), rendered above the Drive-only `FileManager`. Reason: the new Company Formation flow uploads via the Storage fallback (`onboarding-uploads`, `drive_file_id='storage:…'`, signed-URL `drive_link`) and never creates a Drive folder — so an account could show a doc count (e.g. "4") while `FileManager` rendered only its "No Google Drive folder" empty state. The list links each row to `drive_link` (Drive URL in prod, signed Storage URL for fallback uploads) and shows portal-visibility. Data was already fetched by the account page; no new query. Note: fallback `drive_link` is a 1-year signed URL — long-term re-signing is a separate follow-up.)_
_Earlier 2026-06-16 — Claude (ITIN IRS-form fillers updated: the Certified Acceptance Agent mailing address printed on the W-7 (`lib/pdf/w7-fill.ts` `AGENT`) and the preparer address + `CAA_HOME` on the 1040-NR (`lib/pdf/1040nr-fill.ts`) — where the IRS routes ITIN correspondence — now use TD's document-receiving office **Seminole, 11125 Park Blvd Suite 104-153, FL 33772** (was the old Largo address). SS-4/8832 fillers and PDF footers were intentionally left on the existing address.)_
_Earlier 2026-06-16 — Claude (`autoSaveDocument` (`lib/portal/auto-save-document.ts`) gained an optional `serviceDeliveryId` param, written to `documents.service_delivery_id` on insert (untyped — column not in generated types). Lets flow-generated docs link to their service_delivery so they surface on the flow workspace / portal flow page (which query by `service_delivery_id`). Used by the ITIN doc generator (`app/api/itin-form-completed`) for W-7/1040-NR/Schedule OI. Prior 2026-06-11: unified share-path alerting via updateDocument choke point + chat-on-share flag + document_reprocess self-heal job + OCR audit CHECK 40; 2026-06-06 new-document client alerts.)_

## What it is
How files are stored, processed, classified, indexed, and generated. Three storage surfaces + a processing pipeline + PDF generation.

## The three storage surfaces
1. **Google Drive** — the primary document store: the **"Tony Durante LLC" Shared Drive** (ID `0AOLZHXSfKUMHUk9PVA`). Access via a **Service Account + Domain-Wide Delegation impersonating `support@tonydurante.us`** (`lib/google-drive.ts`; SA key in `GOOGLE_SA_KEY` base64 → JWT → token). Tools: `drive_upload` (**text**), `drive_upload_file` (**binary** — PDF/images), `drive_list_folder`, `drive_search`, `drive_move`, `drive_rename`, `drive_delete`, `drive_create_folder`, `drive_read_file`, `drive_get_file_info`, `drive_file_id`, `drive_folder_id`.
2. **Supabase Storage** — the `td-operations` bucket for app/internal files (SOPs, project files). Tools: `storage_read/write/list/move/delete`. **Storage files are auto-mirrored to Google Drive.**
3. **`documents` table** — the CRM **index** of processed documents (not the bytes — Drive holds those). Columns include `account_id`, `contact_id`, `file_name`, `document_type_name`, `category`, `drive_file_id`, `status`, `confidence`, `processed_at`, `portal_visible`.

## The document-intelligence pipeline
`lib/mcp/tools/doc.ts`: **Drive file → OCR → classify → store in `documents`**.
- `doc_process_file` (one), `doc_process_folder` (batch flat), `doc_process_client` (recursive client tree, subfolders 1–5), `doc_bulk_process` (all docs for a CRM account, auto-resolves the Drive folder).
- `doc_search` / `doc_list` / `doc_get` / `doc_stats`.
- `doc_map_folders` — links orphan documents to CRM accounts via Drive folder ancestry.
- `doc_compliance_check` / `doc_compliance_report` — required-vs-present docs per client.
- `doc_mass_process`, `doc_update_health`.

### Classification
`lib/mcp/tools/classify.ts` + `lib/classifier.ts`: **DocAI OCR** (scanned PDFs/images) + **40+ regex rules** (ported from `gdrive-file-classifier.py`). Categories: **Company, Contacts, Tax, Banking, Correspondence**. Tools: `classify_document`, `classify_text`, `classify_list_rules`, `docai_ocr_file`.

## PDF generation (`lib/pdf/`)
Form fillers and generators: `ss4-fill` (EIN), `w7-fill` (ITIN W-7), `8832-fill`, `1040nr-fill`, `tax-form-pdf`, `invoice-pdf`, `intercompany-agreement-pdf`, `itin-data-summary`; helpers `sanitize`, `unicode-fonts`, `wrap-text`.
- **`invoice-pdf` renders negative line items with a leading minus** (e.g. a `Credit applied` line shows `-$500.00`, not `$500.00`) so a credit reads as a deduction, not a charge — matches the same fix in the invoice detail dialog (2026-06-02).

## Auto-save & portal visibility
`lib/portal/auto-save-document.ts` inserts a `documents` row (e.g. when an offer is signed) — deduped by `drive_file_id`, `status='classified'`, and a **`portal_visible`** flag (default false) that controls whether the client sees it in the portal. `lib/portal/document-templates.ts` generates templated docs.

**New-document client alerts (2026-06-06, unified 2026-06-11):** when a document becomes client-visible, the client gets a portal notification + push (email for non-push users via the digest), an optional portal **chat message** ("A new document has been added to your folder: <name>", flag `new_document_chat_message_enabled`, default ON per Antonio 2026-06-11), and the doc shows as "New" in the portal until opened. **Dispatch is owned by the `updateDocument()`/`updateDocumentsBulk()` choke point** (`lib/operations/document.ts`): any patch that actually transitions `portal_visible` false→true fires `notifyClientsOfNewDocument()` fire-and-forget — covering the file-manager toggle, process-and-share, the signature webhook, and every future caller. Single updates alert by default (`clientAlert: false` to opt out); bulk defaults to NOT alerting (portal-transition migrations would flood clients). The two admin upload routes call the module directly (raw insert, not updateDocument). Extra `documents` columns: `notify_client` (per-doc opt-out, default true) + `client_notified_at` (idempotency + baseline). Per-contact opened state lives in `portal_document_views`. Full behavior in `portal.md`.

**OCR-outage resilience (2026-06-11, after the Document AI billing outage sat unnoticed 2 days):** `process-and-share` on a `status='error'` doc still shares it (client first) but keeps the honest error status — it NEVER fakes `classified` — and queues a **`document_reprocess` job** (`lib/jobs/handlers/document-reprocess.ts`, max 12 attempts ≈ 1h of 5-min cron retries, dedup on pending jobs per document) that re-runs OCR+classification when the backend recovers. Longer outages surface via **audit-health-check CHECK 40** (`recent_document_ocr_errors`, P1): documents with errors in the last 24h appear in the daily 9am alert email.

## Business rules
- **`drive_upload` = text, `drive_upload_file` = binary** (PDF/images). Using the wrong one corrupts binary content.
- **`portal_visible` gates client visibility** — only flagged documents appear in the portal; client-visible document deletion uses soft-delete (R100).
- The Service Account impersonates `support@tonydurante.us` (DWD) for all Drive/Gmail access.

## How it's built — key files
`lib/google-drive.ts` (SA/DWD + `SHARED_DRIVE_ID`), `lib/docai.ts` (OCR), `lib/classifier.ts` (rules), `lib/pdf/*` (generation), `lib/mcp/tools/{doc,classify,docai,drive,storage}.ts`, `lib/portal/auto-save-document.ts`, `lib/portal/document-templates.ts`. Tables: `documents` (index) + Google Drive (bytes) + the Supabase `td-operations` bucket.

## Gotchas, invariants & past bugs
- **`documents` is an INDEX, not the file store** — `drive_file_id` points at the real bytes in Drive. Deleting a `documents` row doesn't delete the Drive file (and vice-versa).
- **Wrong upload tool corrupts binaries** — never `drive_upload` a PDF; use `drive_upload_file`.
- **Folder ancestry matters** — `doc_map_folders` links docs to accounts by Drive folder tree; misfiled documents won't auto-link.
- **Shared Drive ID + SA key are fixed config** — `0AOLZHXSfKUMHUk9PVA` / `GOOGLE_SA_KEY`; a bad SA key fails all Drive ops silently-ish (auth error).
- **Supabase Storage auto-mirrors to Drive** — a `storage_write` also lands in Drive; don't double-upload.

## How to verify current state
- Read `lib/google-drive.ts` (`SHARED_DRIVE_ID`, SA/DWD auth), `lib/mcp/tools/doc.ts` (the pipeline tool list), `lib/classifier.ts` (the rules + categories).
- A client's indexed docs: `SELECT file_name, category, document_type_name, portal_visible, drive_file_id FROM documents WHERE account_id='<id>' ORDER BY processed_at DESC;`
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
