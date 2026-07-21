-- Kill the duplicate-ITIN race (Marcell Bogyora, 2026-07-20).
--
-- Problem: createItinDeliveriesFromWizard (lib/operations/itin-from-wizard.ts)
-- creates a contact-scoped "ITIN" service_delivery for everyone who ticked
-- "needs ITIN" on a formation/onboarding wizard. Its app-level guard matched
-- `notes ILIKE '%<offer_token>%'`. On 2026-07-16 the submission-token shape
-- gained a per-subject suffix (lib/portal/submission-token.ts), so when Marcell
-- re-submitted his formation wizard on 07-20 the freshly-minted token was no
-- longer a substring of the notes written under the OLD shape. The guard missed
-- and a second ITIN SD was created — surfacing to the CLIENT as two conflicting
-- ITIN cards in the portal ("Completing ITIN wizard" alongside "Print, sign &
-- mail documents") and pointing the CRM workspace banner at the empty one.
--
-- The code guard now keys on the PERSON instead of the token. But a SELECT
-- followed by an INSERT is not atomic: two sibling jobs (the direct-fire worker
-- and the cron worker) can both pass the check and both insert — exactly the
-- race that produced Michele Cotti's duplicate FORMATION in June, which is
-- already fenced by uq_formation_sd_active_per_offer. ITIN had no equivalent.
--
-- Fix: a partial unique index making the DATABASE the authority — at most one
-- ACTIVE, contact-scoped ITIN per person. The losing INSERT throws 23505, which
-- itin-from-wizard catches and treats as "already exists".
--
-- Why this blocks nothing legitimate:
--   * A person gets exactly ONE ITIN in their life, so "one active ITIN per
--     contact" is the real-world rule, not just a technical guard.
--   * ITIN Renewal is a SEPARATE service_type — unaffected.
--   * Scoped to status='active', so cancelled/completed history is unconstrained
--     and a genuinely new application can be started after one is closed out.
--   * Scoped to contact_id IS NOT NULL: defensive/no-op. ITIN SDs are
--     contact-scoped by the Phase 1 rule and createSD REFUSES an ITIN it cannot
--     attach to a contact, so contact-less ITIN rows should not exist. (NULLs
--     are distinct in a unique index anyway; the clause documents the intent.)
--
-- SCOPE OF THIS INDEX vs THE APP GUARDS — do not "fix" one to match the other:
--   * This index constrains status='active' ONLY. It is the RACE backstop, and
--     it must not constrain historical rows.
--   * The LIFETIME rule is wider and lives in the application guards: a
--     `completed` ITIN also blocks a new one, because a person receives exactly
--     one ITIN in their life. See lib/operations/itin-from-wizard.ts and the
--     `per_person` catalog tag (getPerPersonServiceTypes in lib/services).
--
-- Verified before applying: zero contacts in production hold more than one
-- active ITIN SD, so the index builds cleanly.

CREATE UNIQUE INDEX IF NOT EXISTS uq_itin_sd_active_per_contact
  ON service_deliveries (contact_id)
  WHERE service_type = 'ITIN'
    AND status = 'active'
    AND contact_id IS NOT NULL;

COMMENT ON INDEX uq_itin_sd_active_per_contact IS
  'At most one ACTIVE contact-scoped ITIN service delivery per person. DB-level backstop for the read-then-insert race in createItinDeliveriesFromWizard (a person has exactly one ITIN; ITIN Renewal is a separate service_type). Added 2026-07-20 after the Marcell Bogyora duplicate.';
