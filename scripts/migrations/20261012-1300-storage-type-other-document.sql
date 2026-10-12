-- Drive cutover Phase 2 (dev job ad09ea91): a plain, NOT staff-only document type for client-visible documents that
-- have no more specific type (signed contracts, e-sign documents, Form 8832, generated certificates, DBA documents,
-- intercompany agreements, ordinary staff/client uploads).
--
-- Why: the storage treats a file with NO type as closed (never shown to a client, never shareable — see
-- staffOnlyStorePointers in lib/crm-store/document-pointer.ts), so a client-visible document saved to the new storage
-- needs a catalogued, non-staff-only type or the client gets "Document file not found". Staff can still re-type any file.
-- Data only (a catalog row); idempotent.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, tags, capabilities, metadata)
SELECT 'storage_document_types', 'other_document', 'Other document', 'active', '[]'::jsonb, '{}'::jsonb,
       jsonb_build_object(
         'personal', false,
         'proof_of_filing', false,
         'suggested_folder', '1. Company',
         'default_published', false,
         'freeze_when_filed', false,
         'default_folder_kind', 'company',
         'draft_never_visible', false
       )
WHERE NOT EXISTS (
  SELECT 1 FROM catalog_entries WHERE catalog_id = 'storage_document_types' AND slug = 'other_document'
);
