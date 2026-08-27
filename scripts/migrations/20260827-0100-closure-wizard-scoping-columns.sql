-- Two schema changes needed to close the wrong-company / multi-LLC gaps found
-- by the 4-reviewer post-build council on dev job fbbf4abe (senior-engineer,
-- ai-architect, bug-hunter, project-director — all four independently traced
-- the same root cause from different angles: the closure wizard has no way to
-- tell one company's closure apart from another's below the account level).
--
-- 1. wizard_progress.service_delivery_id — lets the closure wizard's saved
--    draft be scoped to the SPECIFIC pending closure record, not just to the
--    contact/account. Without this, a client with two closures in flight
--    (two untracked LLCs, or a managed company + an untracked one) has their
--    SECOND closure's draft silently load and overwrite the FIRST one's saved
--    answers, because resolveWizardProgressScope() had nothing more specific
--    than account_id/contact_id to key on.
--
-- 2. closure_submissions.last_processed_hash — lets the closure auto-chain
--    tell "the client corrected something and resubmitted" apart from "this
--    is an automatic retry of the exact same data" (the retry-duplicate-task
--    bug found once today's earlier ok:false fix made retries actually
--    happen). NULL means "never successfully processed yet".

ALTER TABLE wizard_progress ADD COLUMN IF NOT EXISTS service_delivery_id uuid REFERENCES service_deliveries(id);
CREATE INDEX IF NOT EXISTS idx_wizard_progress_service_delivery_id ON wizard_progress(service_delivery_id) WHERE service_delivery_id IS NOT NULL;

ALTER TABLE closure_submissions ADD COLUMN IF NOT EXISTS last_processed_hash text;
