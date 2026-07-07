-- S1 — Learned statement-format mappings (2026-07-07, tri-role reviewed plan).
-- Origin: the Dynamiq incident — Mercury's newer export variant missed the
-- hand-coded signature (header says "Category", parser expected "Mercury
-- Category") → the generic parser stored bank_name='Bank' and took the
-- "Original Currency" column as the row currency over USD-SETTLED amounts
-- (double conversion). Formats become DATA, not code: the AI proposes COLUMN
-- ROLES once per format, a deterministic verifier accepts or quarantines, and
-- the verified mapping replays forever, keyed by the header fingerprint.
--
-- fingerprint = the normalized header itself (trimmed, lowercased, joined
-- with '|') — human-readable, no crypto dependency, uniquely identifying.
-- status: proposed (awaiting staff confirm) | verified_auto (zero-ambiguity,
-- hard checks passed) | staff_confirmed | rejected.

CREATE TABLE IF NOT EXISTS statement_format_mappings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint  text NOT NULL UNIQUE,
  delimiter    text NOT NULL DEFAULT ',',
  mapping      jsonb NOT NULL,
  status       text NOT NULL CHECK (status IN ('proposed', 'verified_auto', 'staff_confirmed', 'rejected')),
  bank_label   text NOT NULL,
  /** Up to 5 sample rows (rendered through the mapping) shown in the confirm UI. */
  sample       jsonb,
  /** Where the proposal came from: 'ai' | 'heuristic' | 'staff' | 'migration'. */
  proposed_by  text NOT NULL,
  /** File that first surfaced this format (context for staff review). */
  source_file  text,
  hits         integer NOT NULL DEFAULT 0,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE statement_format_mappings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE statement_format_mappings IS
  'Learned bank-statement CSV formats: header fingerprint → column-role mapping. AI proposes roles ONCE per format (never row values); deterministic verifier auto-accepts only at zero ambiguity, else staff confirms one tap; rows always parse deterministically through the stored mapping. RLS ON, no policy — service-role only.';

-- SEED: Mercury transactions export, "Category/GL Code" variant (the exact
-- format from the Dynamiq incident — learned the hard way, deterministic from
-- day one). Semantics per the CPA review: Amount is USD-SETTLED (currency
-- fixed USD; "Original Currency" is display metadata only, NEVER the row
-- currency); account identity from "Source Account"; only Sent rows are real.
INSERT INTO statement_format_mappings (fingerprint, delimiter, mapping, status, bank_label, proposed_by, source_file, created_by)
VALUES (
  'date (utc)|description|amount|status|source account|bank description|reference|note|last four digits|name on card|category|gl code|timestamp|original currency|check number|tags',
  ',',
  '{
    "version": 1,
    "bank_label": "Mercury",
    "date": { "col": 0, "order": "mdy" },
    "description_cols": [1, 5],
    "counterparty_col": 5,
    "amount": { "mode": "signed", "col": 2, "positive_is": "in" },
    "currency": { "mode": "settled_fixed_with_original", "value": "USD", "original_col": 13 },
    "account": { "mode": "column", "col": 4 },
    "balance_col": null,
    "status": { "col": 3, "include": ["sent"] },
    "ref_extra_cols": [4, 12]
  }'::jsonb,
  'staff_confirmed',
  'Mercury',
  'migration',
  'statement_mercury_2024.csv (Dynamiq incident 2026-07-07)',
  'migration:20260707-1200'
)
ON CONFLICT (fingerprint) DO NOTHING;
