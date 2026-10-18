-- dev job 264bb882 (Stop Drive S1b round 4) -- the knowledge base and the SOPs still point at tools that no longer exist
-- (tax_send_to_accountant, drive_upload_file, drive_rename) and at the retired accountant/India hand-off.
-- R060: the KB is the canonical source, so the repo-side change is this migration. It rewrites ONLY the lines listed below, by
-- row id + exact text. A row is updated only if EVERY line it expects is still present (otherwise it is left untouched and shows
-- rows_updated = 0 in the report). The extension process ("India files extensions in bulk", tax_extension_list) is NOT touched.
-- The ORIGINAL content of every row it touches is kept in retired_handoff_text_backup, so the UNDO is exact.
-- Verified read-only against production on 2026-10-18: all 38 edits matched exactly one row.
-- Two statements, run one at a time. Expected report: 13 rows, each rows_updated = 1.

CREATE TABLE IF NOT EXISTS retired_handoff_text_backup (
  tbl text NOT NULL,
  id uuid NOT NULL,
  content text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tbl, id)
);

WITH
b AS (
  INSERT INTO retired_handoff_text_backup (tbl, id, content)
  SELECT 'sop', id, content FROM sop_runbooks WHERE id IN ('1aef7643-a978-497c-a06a-03325193bba3','0e278dc1-af9b-4767-8991-f77ce4567365','95a19ea3-1a0f-429b-9e43-f938a10e2cf3','efb7db81-d540-4b7b-9e06-50c14bd07f19','4c012022-ae6d-4b36-9535-87b02957eecb','0f534069-1103-43c5-a7c9-fe2d3924e6f4','91b1bd12-9d38-4aba-afe3-103329e5330a','9ea1e78a-d984-4463-b960-ce144556e98d')
  UNION ALL
  SELECT 'kb', id, content FROM knowledge_articles WHERE id IN ('d4ae79f4-732d-43dd-8ce5-aca739b3dc80','370347b6-cfa7-486e-a757-e2acce70e15d','d8a1a0f6-d238-4466-bb39-fafd4e8e7c38','095f8a5f-6c01-4830-9c00-2a3abbcc38ae','ae721725-946d-443d-a0ed-3bba42a61f9d')
  ON CONFLICT (tbl, id) DO NOTHING
  RETURNING 1
),
u1 AS (
  UPDATE sop_runbooks SET content = replace(replace(replace(replace(replace(replace(regexp_replace(replace(replace(replace(replace(replace(replace(content, $q$YES — blocks India until June paid$q$, $q$YES — blocks the return until June paid$q$), $q$| **Send to India** | After 2nd payment confirmed | After data received (no gate) |
$q$, $q$$q$), $q$5. Send to India for preparation
6. Review (Antonio)$q$, $q$5. Review (Antonio)$q$), $q$Advance to Phase 4$q$, $q$Advance to Phase 5$q$), $q$**CRITICAL RULE**: Tax return is NOT sent to India until 2nd installment is paid. No exceptions.$q$, $q$**CRITICAL RULE**: The tax return does not move on until the 2nd installment is paid. No exceptions.$q$), $q$Go directly to Phase 4.$q$, $q$Go directly to Phase 5.$q$), $q$(?s)## PHASE 4: Send to India.*?(?=## PHASE 5)$q$, $q$$q$), $q$Scenario 2: already sent to India$q$, $q$Scenario 2: already paid in full$q$), $q$| No service until paid | Never send data to India without payment confirmed |$q$, $q$| No service until paid | The tax return does not move on without payment confirmed |$q$), $q$| 2nd payment = gate (Scenario 1) | India blocked until June installment paid |$q$, $q$| 2nd payment = gate (Scenario 1) | Return blocked until June installment paid |$q$), $q$| Email format to India | [Company] - [Contact] - [EIN] - [Type] to tax@adasglobus.com |
$q$, $q$$q$), $q$| tax_send_to_accountant | Bundles all docs from Drive, emails India |
$q$, $q$$q$), $q$Comparative Balance Sheet, tax_send_to_accountant |$q$, $q$Comparative Balance Sheet |$q$), updated_at = now()
  WHERE id = '1aef7643-a978-497c-a06a-03325193bba3' AND
    position($q$YES — blocks India until June paid$q$ IN content) > 0
    AND position($q$| **Send to India** | After 2nd payment confirmed | After data received (no gate) |
$q$ IN content) > 0
    AND position($q$5. Send to India for preparation
6. Review (Antonio)$q$ IN content) > 0
    AND position($q$Advance to Phase 4$q$ IN content) > 0
    AND position($q$**CRITICAL RULE**: Tax return is NOT sent to India until 2nd installment is paid. No exceptions.$q$ IN content) > 0
    AND position($q$Go directly to Phase 4.$q$ IN content) > 0
    AND content ~ $q$(?s)## PHASE 4: Send to India.*?(?=## PHASE 5)$q$
    AND position($q$Scenario 2: already sent to India$q$ IN content) > 0
    AND position($q$| No service until paid | Never send data to India without payment confirmed |$q$ IN content) > 0
    AND position($q$| 2nd payment = gate (Scenario 1) | India blocked until June installment paid |$q$ IN content) > 0
    AND position($q$| Email format to India | [Company] - [Contact] - [EIN] - [Type] to tax@adasglobus.com |
$q$ IN content) > 0
    AND position($q$| tax_send_to_accountant | Bundles all docs from Drive, emails India |
$q$ IN content) > 0
    AND position($q$Comparative Balance Sheet, tax_send_to_accountant |$q$ IN content) > 0
  RETURNING id
),
u2 AS (
  UPDATE knowledge_articles SET content = replace(replace(content, $q$6. After 2nd installment paid: package data and handoff to India filing team$q$, $q$6. After 2nd installment paid: the tax return gate is lifted$q$), $q$- Tax return NOT sent to India until 2nd payment confirmed$q$, $q$- Tax return does not move on until the 2nd payment is confirmed$q$), updated_at = now()
  WHERE id = 'd4ae79f4-732d-43dd-8ce5-aca739b3dc80' AND
    position($q$6. After 2nd installment paid: package data and handoff to India filing team$q$ IN content) > 0
    AND position($q$- Tax return NOT sent to India until 2nd payment confirmed$q$ IN content) > 0
  RETURNING id
),
u3 AS (
  UPDATE knowledge_articles SET content = replace(replace(content, $q$(paying those fires the accountant hand-off machinery)$q$, $q$(paying those would lift the tax-return payment gate)$q$), $q$C6. 2nd installment (June) = gate before tax return goes to India. No exceptions.$q$, $q$C6. 2nd installment (June) = gate before the tax return moves on. No exceptions.$q$), updated_at = now()
  WHERE id = '370347b6-cfa7-486e-a757-e2acce70e15d' AND
    position($q$(paying those fires the accountant hand-off machinery)$q$ IN content) > 0
    AND position($q$C6. 2nd installment (June) = gate before tax return goes to India. No exceptions.$q$ IN content) > 0
  RETURNING id
),
u4 AS (
  UPDATE knowledge_articles SET content = replace(content, $q$- Tax return signed → Send to India | account | Luca$q$, $q$- Tax return signed → File the signed tax return | account | Luca$q$), updated_at = now()
  WHERE id = 'd8a1a0f6-d238-4466-bb39-fafd4e8e7c38' AND
    position($q$- Tax return signed → Send to India | account | Luca$q$ IN content) > 0
  RETURNING id
),
u5 AS (
  UPDATE knowledge_articles SET content = replace(content, $q$- June: 2nd installment = gate before tax return goes to India team$q$, $q$- June: 2nd installment = gate before the tax return moves on$q$), updated_at = now()
  WHERE id = '095f8a5f-6c01-4830-9c00-2a3abbcc38ae' AND
    position($q$- June: 2nd installment = gate before tax return goes to India team$q$ IN content) > 0
  RETURNING id
),
u6 AS (
  UPDATE knowledge_articles SET content = replace(replace(replace(replace(replace(content, $q$- Tool: `tax_send_to_accountant(account_id, tax_year, dry_run=true)` — bundles all documents from Drive
$q$, $q$$q$), $q$- **ALWAYS run with dry_run=true first** to preview the package. Get Antonio's approval. Then run with dry_run=false to send.
$q$, $q$$q$), $q$- Email subject format: `{Company} - {Contact} - {EIN} - {ReturnType}`
$q$, $q$$q$), $q$- Default accountant email: tax@adasglobus.com (configurable via accountant_email param)
$q$, $q$$q$), $q$- Tool searches both Tax/{year}/ subfolder AND Tax/ root for documents (handles both folder structures)
$q$, $q$$q$), updated_at = now()
  WHERE id = 'ae721725-946d-443d-a0ed-3bba42a61f9d' AND
    position($q$- Tool: `tax_send_to_accountant(account_id, tax_year, dry_run=true)` — bundles all documents from Drive
$q$ IN content) > 0
    AND position($q$- **ALWAYS run with dry_run=true first** to preview the package. Get Antonio's approval. Then run with dry_run=false to send.
$q$ IN content) > 0
    AND position($q$- Email subject format: `{Company} - {Contact} - {EIN} - {ReturnType}`
$q$ IN content) > 0
    AND position($q$- Default accountant email: tax@adasglobus.com (configurable via accountant_email param)
$q$ IN content) > 0
    AND position($q$- Tool searches both Tax/{year}/ subfolder AND Tax/ root for documents (handles both folder structures)
$q$ IN content) > 0
  RETURNING id
),
u7 AS (
  UPDATE sop_runbooks SET content = replace(replace(content, $q$| 18 | Save bank documents | Claude | drive_upload_file | Save account confirmation, welcome docs to Drive (4. Banking/) |$q$, $q$| 18 | Save bank documents | Claude | Storage page | Save account confirmation, welcome docs in the company's storage (Banking folder) |$q$), $q$| drive_upload_file | Save bank docs to Drive |$q$, $q$| Storage page | Save bank docs in the company's storage |$q$), updated_at = now()
  WHERE id = '0e278dc1-af9b-4767-8991-f77ce4567365' AND
    position($q$| 18 | Save bank documents | Claude | drive_upload_file | Save account confirmation, welcome docs to Drive (4. Banking/) |$q$ IN content) > 0
    AND position($q$| drive_upload_file | Save bank docs to Drive |$q$ IN content) > 0
  RETURNING id
),
u8 AS (
  UPDATE sop_runbooks SET content = replace(replace(content, $q$| 12 | Save documents | Claude | drive_upload_file | Signed lease + Form 1583 to Drive (1. Company/) |$q$, $q$| 12 | Save documents | Claude | Storage page | Signed lease + Form 1583 in the company's storage (Company folder) |$q$), $q$| drive_upload_file | Save documents to Drive |$q$, $q$| Storage page | Save documents in the company's storage |$q$), updated_at = now()
  WHERE id = '95a19ea3-1a0f-429b-9e43-f938a10e2cf3' AND
    position($q$| 12 | Save documents | Claude | drive_upload_file | Signed lease + Form 1583 to Drive (1. Company/) |$q$ IN content) > 0
    AND position($q$| drive_upload_file | Save documents to Drive |$q$ IN content) > 0
  RETURNING id
),
u9 AS (
  UPDATE sop_runbooks SET content = replace(replace(content, $q$| 18 | Save to Drive | Claude | drive_upload_file | EIN letter to Companies/{State}/{Company}/1. Company/EIN Letter.pdf |$q$, $q$| 18 | Save to storage | Claude | Storage page | EIN letter in the company's storage (Company folder) as EIN Letter.pdf |$q$), $q$| drive_upload_file | Save EIN letter to Drive |$q$, $q$| Storage page | Save EIN letter in the company's storage |$q$), updated_at = now()
  WHERE id = 'efb7db81-d540-4b7b-9e06-50c14bd07f19' AND
    position($q$| 18 | Save to Drive | Claude | drive_upload_file | EIN letter to Companies/{State}/{Company}/1. Company/EIN Letter.pdf |$q$ IN content) > 0
    AND position($q$| drive_upload_file | Save EIN letter to Drive |$q$ IN content) > 0
  RETURNING id
),
u10 AS (
  UPDATE sop_runbooks SET content = replace(replace(content, $q$| 48 | Save to Drive | Claude | drive_upload_file | ITIN letter to client Drive folder (ITIN/ or 2. Contacts/) |$q$, $q$| 48 | Save to storage | Claude | Storage page | ITIN letter in the person's storage (ITIN folder) |$q$), $q$| drive_upload_file | Save documents to Drive |$q$, $q$| Storage page | Save documents in the storage |$q$), updated_at = now()
  WHERE id = '4c012022-ae6d-4b36-9535-87b02957eecb' AND
    position($q$| 48 | Save to Drive | Claude | drive_upload_file | ITIN letter to client Drive folder (ITIN/ or 2. Contacts/) |$q$ IN content) > 0
    AND position($q$| drive_upload_file | Save documents to Drive |$q$ IN content) > 0
  RETURNING id
),
u11 AS (
  UPDATE sop_runbooks SET content = replace(replace(content, $q$| 13 | Save to Drive | Claude | drive_upload_file | Companies/{State}/{Company Name}/Compliance/RA Renewal {year}.pdf |$q$, $q$| 13 | Save to storage | Claude | Storage page | RA Renewal {year}.pdf in the company's storage (Compliance) |$q$), $q$| drive_upload_file | Save Harbor confirmation to Drive |$q$, $q$| Storage page | Save Harbor confirmation in the company's storage |$q$), updated_at = now()
  WHERE id = '0f534069-1103-43c5-a7c9-fe2d3924e6f4' AND
    position($q$| 13 | Save to Drive | Claude | drive_upload_file | Companies/{State}/{Company Name}/Compliance/RA Renewal {year}.pdf |$q$ IN content) > 0
    AND position($q$| drive_upload_file | Save Harbor confirmation to Drive |$q$ IN content) > 0
  RETURNING id
),
u12 AS (
  UPDATE sop_runbooks SET content = replace(replace(content, $q$| 15 | Save to Drive | Claude | drive_upload_file | Companies/{State}/{Company Name}/Compliance/Annual Report {year}.pdf |$q$, $q$| 15 | Save to storage | Claude | Storage page | Annual Report {year}.pdf in the company's storage (Compliance) |$q$), $q$| drive_upload_file | Save state confirmation to Drive |$q$, $q$| Storage page | Save state confirmation in the company's storage |$q$), updated_at = now()
  WHERE id = '91b1bd12-9d38-4aba-afe3-103329e5330a' AND
    position($q$| 15 | Save to Drive | Claude | drive_upload_file | Companies/{State}/{Company Name}/Compliance/Annual Report {year}.pdf |$q$ IN content) > 0
    AND position($q$| drive_upload_file | Save state confirmation to Drive |$q$ IN content) > 0
  RETURNING id
),
u13 AS (
  UPDATE sop_runbooks SET content = replace(replace(content, $q$### 5. Rename Drive folder if needed$q$, $q$### 5. Rename the company folder if needed$q$), $q$``drive_rename(file_id = "<drive_folder_id>", new_name = "<Company> - <Owner>")``$q$, $q$Rename it from the Storage page: ``<Company> - <Owner>``$q$), updated_at = now()
  WHERE id = '9ea1e78a-d984-4463-b960-ce144556e98d' AND
    position($q$### 5. Rename Drive folder if needed$q$ IN content) > 0
    AND position($q$``drive_rename(file_id = "<drive_folder_id>", new_name = "<Company> - <Owner>")``$q$ IN content) > 0
  RETURNING id
)
SELECT 'sop 1aef7643-a978-497c-a06a-03325193bba3' AS row_id, 13 AS edits_expected, (SELECT count(*) FROM u1) AS rows_updated
UNION ALL
SELECT 'kb d4ae79f4-732d-43dd-8ce5-aca739b3dc80' AS row_id, 2 AS edits_expected, (SELECT count(*) FROM u2) AS rows_updated
UNION ALL
SELECT 'kb 370347b6-cfa7-486e-a757-e2acce70e15d' AS row_id, 2 AS edits_expected, (SELECT count(*) FROM u3) AS rows_updated
UNION ALL
SELECT 'kb d8a1a0f6-d238-4466-bb39-fafd4e8e7c38' AS row_id, 1 AS edits_expected, (SELECT count(*) FROM u4) AS rows_updated
UNION ALL
SELECT 'kb 095f8a5f-6c01-4830-9c00-2a3abbcc38ae' AS row_id, 1 AS edits_expected, (SELECT count(*) FROM u5) AS rows_updated
UNION ALL
SELECT 'kb ae721725-946d-443d-a0ed-3bba42a61f9d' AS row_id, 5 AS edits_expected, (SELECT count(*) FROM u6) AS rows_updated
UNION ALL
SELECT 'sop 0e278dc1-af9b-4767-8991-f77ce4567365' AS row_id, 2 AS edits_expected, (SELECT count(*) FROM u7) AS rows_updated
UNION ALL
SELECT 'sop 95a19ea3-1a0f-429b-9e43-f938a10e2cf3' AS row_id, 2 AS edits_expected, (SELECT count(*) FROM u8) AS rows_updated
UNION ALL
SELECT 'sop efb7db81-d540-4b7b-9e06-50c14bd07f19' AS row_id, 2 AS edits_expected, (SELECT count(*) FROM u9) AS rows_updated
UNION ALL
SELECT 'sop 4c012022-ae6d-4b36-9535-87b02957eecb' AS row_id, 2 AS edits_expected, (SELECT count(*) FROM u10) AS rows_updated
UNION ALL
SELECT 'sop 0f534069-1103-43c5-a7c9-fe2d3924e6f4' AS row_id, 2 AS edits_expected, (SELECT count(*) FROM u11) AS rows_updated
UNION ALL
SELECT 'sop 91b1bd12-9d38-4aba-afe3-103329e5330a' AS row_id, 2 AS edits_expected, (SELECT count(*) FROM u12) AS rows_updated
UNION ALL
SELECT 'sop 9ea1e78a-d984-4463-b960-ce144556e98d' AS row_id, 2 AS edits_expected, (SELECT count(*) FROM u13) AS rows_updated;
