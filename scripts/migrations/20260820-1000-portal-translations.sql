-- migration:20260820-1000-portal-translations.sql
-- ============================================================================
-- PORTAL TRANSLATIONS — storage foundation for "pick any language, portal
-- auto-translates" (dev job 12cab351, Part 1 of the client-portal
-- translation project). Design passed a 5-reviewer council pass (senior
-- engineer, AI architect, bug hunter, project director, system counselor)
-- before this file was written; every column below exists because a
-- specific review finding required it, not by default.
--
-- WHAT THIS TABLE IS NOT: it does not hold English. English is, and stays,
-- whatever the application code already defines for a given key (the
-- migrated central dictionary, wizard field labels, etc. — later milestones
-- of this same job). This table holds ONLY the non-English translations of
-- those keys, generated once per (language, key) and reused forever.
--
-- WHAT THIS TABLE MUST NEVER HOLD, BY DESIGN (Antonio's explicit ruling,
-- 2026-08-20): any legally-meaningful text — signed documents, tax filings,
-- the Operating Agreement's own content, or the consent/disclaimer checkbox
-- wording found embedded inside ordinary wizard field labels. Those never
-- get a row here; the migration scripts that populate this table (later
-- milestones) must skip them by name, not rely on a runtime check against
-- this table to catch them after the fact.
--
-- RACE SAFETY (bug-hunter + senior-engineer finding): two clients requesting
-- the same never-before-seen (language, key) at once must not both trigger a
-- paid translation call. The UNIQUE constraint below is the actual guard —
-- the app inserts a 'pending' row via INSERT ... ON CONFLICT (language_code,
-- key) DO NOTHING; only the caller whose insert affected a row is the one
-- who should fire the translation call. Do not build a check-then-insert
-- race around this constraint; the earlier plan's citation of the
-- invoice-number generator's retry-on-conflict pattern was WRONG — that
-- generator uses mandatory-retry-until-success semantics, not
-- ON-CONFLICT-DO-NOTHING, and this table needs the latter (see
-- lib/portal/invoice-number.ts's own comment for the pattern it actually
-- uses, which is NOT this one).
--
-- STUCK-ROW RECOVERY (bug-hunter finding): a row sitting in 'generating'
-- with no update for several minutes means the translation job died
-- (timeout, crash) with nobody watching. generating_started_at is what a
-- later cron-style sweep resets to 'pending' for retry — same shape as the
-- Hermes bridge's own stuck-'processing'-row recovery (R108, CLAUDE.md).
--
-- VERIFIED VS NEEDS_REVIEW (senior-engineer + AI-architect finding — this
-- fixes a real contradiction in an earlier draft of the plan): the
-- pre-existing, human-written English/Italian text being migrated in from
-- lib/portal/i18n.ts and friends is verified=true and must NEVER be
-- silently overwritten by machine translation, ever — including when its
-- English source text is later edited. On a source-text edit, a verified
-- row is flagged needs_review=true and keeps serving its (now possibly
-- stale) translated_text until a human clears the flag; only an
-- unverified (verified=false, i.e. machine-generated, never
-- human-reviewed) row may be silently re-translated on a source change.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.portal_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Target language. Deliberately NOT a CHECK-constrained enum — the entire
  -- point of this table is that a new language is addable without a schema
  -- change or code deploy. Real validation against a genuine BCP-47/
  -- ISO-639-1 list (not "any string a client types") happens at the API
  -- layer that triggers generation (a later milestone), never here.
  language_code text NOT NULL,

  -- Matches an existing lib/portal/i18n.ts dictionary key where one already
  -- exists (e.g. 'nav.myCompany'). Content migrated in from the other three
  -- hardcoded patterns (wizard field labels, the tax-form dictionary, the
  -- scattered inline ternaries) gets a namespaced key minted at migration
  -- time (later milestone), e.g. 'wizard.field.owner_first_name.label'.
  key text NOT NULL,

  translated_text text NOT NULL,

  -- The English wording this row was translated FROM, captured at
  -- translation time. Lets a human read exactly what was translated without
  -- cross-referencing the live source, and is what source_text_hash hashes.
  source_text text NOT NULL,
  source_text_hash text NOT NULL,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generating', 'done')),

  verified boolean NOT NULL DEFAULT false,
  needs_review boolean NOT NULL DEFAULT false,

  generating_started_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT portal_translations_language_key UNIQUE (language_code, key)
);

-- The generation worker's own polling query (later milestone): find rows
-- stuck in flight to retry or recover.
CREATE INDEX IF NOT EXISTS idx_portal_translations_in_flight
  ON public.portal_translations (status)
  WHERE status IN ('pending', 'generating');

-- Server-only, same pattern as every other purely-internal table here
-- (recurring_invoice_templates, payer_client_map): no anon/authenticated
-- grants are added. The portal's own translation lookup happens through
-- server-side Next.js code (supabaseAdmin), never a direct browser-to-
-- Postgres read — clients never query this table themselves.
ALTER TABLE public.portal_translations ENABLE ROW LEVEL SECURITY;

-- ⛔ NO updated_at TRIGGER, DELIBERATELY — same reasoning as
-- payer_client_map and recurring_invoice_templates (2026-08-09/08-17):
-- public.update_updated_at() exists in PRODUCTION but NOT in sandbox, so
-- depending on it makes this table's DDL environment-specific. Application
-- code sets updated_at explicitly on every write.

COMMENT ON TABLE public.portal_translations IS
  'Non-English translations of the client portal''s static text, generated once per (language, key) via AI translation and reused forever afterward — never English itself, never legally-meaningful text (signed documents, tax filings, consent/disclaimer wording), which are excluded by the migration scripts that populate this table rather than by a runtime check here. verified=true rows (the pre-existing human-written EN/IT text) are never auto-overwritten by a source-text edit — see needs_review. Dev job 12cab351.';
