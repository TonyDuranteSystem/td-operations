-- ============================================================================
-- PAYER LEARNING — the taught link between "who the bank says sent this" and
-- "which client it is for".
--
-- Dev jobs: ae8b8bb1 (the misrouted EUR1,250) / c0a61e44 (WS-C). Design approved
-- by Antonio 2026-08-09, including the amendments below.
--
-- WHY IT EXISTS. The deposit router can only recognise a client payment from
-- evidence the bank happens to carry, and measurement showed the sources that
-- matter carry almost nothing: Airwallex gives a payer NAME and a reference that
-- differs every transaction; the Plaid-backed feeds leave the counterparty empty
-- on all but 28 of 276 rows and the payer field empty on every one; Stripe rows
-- carry no customer id at all. Only Mercury's own API is dependable (a
-- counterparty id on 136 of 136). So a name rule can never close the gap —
-- "WM International LLC" reduces to ZERO usable words, "Oh My Crea" is
-- bank-truncated, "Relation Box" is bank-reworded, and Alessandro's call was paid
-- on Lamberto's card, a payer whose name is CORRECTLY not the client's.
--
-- A human already knows all four. This table remembers what they tell us.
--
-- ── SHAPE: A PAYER MAPS TO A SET OF CLIENTS, ONE ROW PER CLIENT ──────────────
-- Each row is ONE deliberate human confirmation. Teaching "this payer pays for
-- client X" says nothing about any other client. Grounded in real production
-- data, not theory: William's descriptor legitimately pays BOTH his own company
-- and InkMedia, owned by someone else entirely (the 6 Jul wire of $2,150 settled
-- $1,150 of InkMedia's invoice and $1,000 of WM International's in one go). Five
-- more third-party payers behave the same way. So a second client appearing
-- behind a payer is NORMAL — it must never auto-block and never auto-retire; it
-- needs a second confirmation, which is a second row.
--
-- ── WHAT THIS TABLE MUST NEVER BE ────────────────────────────────────────────
-- It NEVER settles money. A taught payer identifies the client and scopes the
-- candidates; when no open invoice fits, the deposit still goes to a human. That
-- is doubly required here precisely because a payer legitimately spans unrelated
-- owners, so "who sent it" can never imply "which invoice".
--
-- ── REVERSIBILITY ────────────────────────────────────────────────────────────
-- Removal is a soft delete (`removed_at`), because it must NOT re-file history:
-- past rows stay exactly where they are and move only through triage. Keeping the
-- row also preserves who taught it and when, which is the audit trail for a
-- mapping that later turns out wrong.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.payer_client_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which feed source this payer identity came from. A descriptor is only
  -- meaningful within the bank that wrote it.
  source text NOT NULL,

  -- HOW the payer is identified. `counterparty_id` is a stable id the source
  -- provided (only Mercury's API supplies one today). `descriptor` is the
  -- normalised payer text — weaker, but it is all the other sources give, and it
  -- is what a human is actually looking at when they teach it.
  key_type text NOT NULL CHECK (key_type IN ('descriptor', 'counterparty_id')),

  -- The normalised key used for lookup (lower-cased, whitespace-collapsed).
  key_value text NOT NULL,

  -- The payer EXACTLY as the bank wrote it, kept for display so staff recognise
  -- what they taught. Never used for matching.
  display_payer text,

  -- The client this payer pays for. Exactly one of the two is set: a company, or
  -- a person who has no company record. Both nullable columns rather than one
  -- polymorphic id, so the foreign keys stay real.
  account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  CONSTRAINT payer_client_map_one_subject CHECK (
    (account_id IS NOT NULL AND contact_id IS NULL)
    OR (account_id IS NULL AND contact_id IS NOT NULL)
  ),

  -- Provenance. There is no "system" value on purpose: a row exists ONLY because
  -- a person clicked. Seeded proposals are shown for confirmation, never written.
  taught_by text NOT NULL,
  taught_at timestamptz NOT NULL DEFAULT now(),
  -- Free text for how it was learned, e.g. "confirmed from the bank feed" or
  -- "confirmed from a PAYMENT RULE note on the account".
  taught_via text,

  removed_at timestamptz,
  removed_by text,

  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live mapping per (payer, client). Two PARTIAL indexes rather than one over
-- COALESCE, so each foreign key stays independently indexed.
--
-- ⛔ CONSEQUENCE FOR CALLERS, learned the hard way on the members table: a PARTIAL
-- unique index cannot back an upsert's ON CONFLICT (Postgres raises 42P10). Do
-- NOT reach for upsert here — read, then insert or revive the soft-deleted row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payer_client_map_account
  ON public.payer_client_map (source, key_type, key_value, account_id)
  WHERE removed_at IS NULL AND account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payer_client_map_contact
  ON public.payer_client_map (source, key_type, key_value, contact_id)
  WHERE removed_at IS NULL AND contact_id IS NOT NULL;

-- The lookup the router performs on every unrecognised deposit: given a source
-- and a key, who does this payer pay for?
CREATE INDEX IF NOT EXISTS idx_payer_client_map_lookup
  ON public.payer_client_map (source, key_type, key_value)
  WHERE removed_at IS NULL;

-- The reverse view a staff screen needs: everything taught for one client.
CREATE INDEX IF NOT EXISTS idx_payer_client_map_account_id
  ON public.payer_client_map (account_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payer_client_map_contact_id
  ON public.payer_client_map (contact_id) WHERE removed_at IS NULL;

-- Server-only, like every other staff-facing table here: no anon/authenticated
-- grants are added, so it is reachable exclusively through service-role code.
ALTER TABLE public.payer_client_map ENABLE ROW LEVEL SECURITY;

-- ⛔ NO updated_at TRIGGER, DELIBERATELY. `public.update_updated_at()` exists in
-- PRODUCTION but NOT in sandbox (verified 2026-08-09: the migration failed there
-- on exactly that). Depending on it would make this table's DDL environment-
-- specific, and creating the function in sandbox to match would widen a drift
-- rather than close it. The only writers of this table are the payer-learning
-- helpers, and they set `updated_at` explicitly.

COMMENT ON TABLE public.payer_client_map IS
  'Taught payer identity -> client. One row per deliberate human confirmation; a payer may map to SEVERAL clients (third-party payers are normal here). Identifies and scopes only — never settles money. Removal is a soft delete and never re-files history. Dev jobs ae8b8bb1 / c0a61e44.';
