/**
 * The fixed lists the CRM Store writes into its database columns — ONE place, so the code↔database contract
 * (lib/db-contract.ts CONSTRAINT_CONTRACTS) can verify that every value the code can write is one the CHECK
 * constraints accept. Each list mirrors the CHECK in the migration named beside it; the contract check FAILS if
 * a value here is missing from the database (and warns on a database value the code never writes).
 */

/** store_owners.kind — 20260927-1000-crm-store-structure.sql */
export const STORE_OWNER_KINDS = ["company", "person", "formation", "unfiled", "business", "private"] as const
/** store_owners.lifecycle_override — foundation-s1 */
export const STORE_LIFECYCLE_OVERRIDES = ["in_formation", "in_onboarding", "archived"] as const
/** store_files.state — foundation-s1 */
export const STORE_FILE_STATES = ["live", "trashed", "purged"] as const
/** store_files.filing_status — foundation-s1 */
export const STORE_FILING_STATUSES = ["none", "draft", "filed", "amended"] as const
/** store_file_facts.source and store_file_tags.source — foundation-s1 */
export const STORE_ASSERTION_SOURCES = ["human", "rule", "ai"] as const
/** store_file_subjects.subject_kind — foundation-s1 */
export const STORE_SUBJECT_KINDS = ["person", "company"] as const
/** store_external_refs.direction — foundation-s1 */
export const STORE_REF_DIRECTIONS = ["import", "backup"] as const
/** store_external_refs.object_kind — foundation-s1 */
export const STORE_REF_OBJECT_KINDS = ["folder", "file", "file_version"] as const
/** store_exit_invitations.status — s3-access */
export const STORE_EXIT_INVITATION_STATUSES = ["queued", "sent", "cancelled"] as const
/** store_import_runs.mode — 20260929-1400-crm-store-study-copy.sql */
export const IMPORT_RUN_MODES = ["move", "copy"] as const
/** store_import_runs.status — 20260929-1000-crm-store-drive-import-claim.sql */
export const IMPORT_RUN_STATUSES = ["scanning", "moving", "undoing", "done", "incomplete", "failed", "rolled_back"] as const
/** store_import_items.source — 20260929-0900-crm-store-drive-import.sql */
export const IMPORT_ITEM_SOURCES = ["drive", "storage"] as const
/** store_import_items.status — 20260929-1000-crm-store-drive-import-claim.sql */
export const IMPORT_ITEM_STATUSES = ["pending", "working", "done", "merged", "skipped", "failed"] as const
