-- TD Marketing: payment links and the sales record (dev job 9aec66fa).
-- One row per payment link a seller creates from a lead. The 80/20 split in force at the moment the link is made is COPIED onto the row
-- (a later change of terms never rewrites a past sale). Money is whole cents + a currency; two currencies are never added together.
-- Requires 20261019-1000 (marketing_leads) and 20261017-1900 (marketing_teams, marketing_commission_terms).
DO $$
BEGIN
  IF to_regclass('public.marketing_leads') IS NULL OR to_regclass('public.marketing_commission_terms') IS NULL THEN
    RAISE EXCEPTION 'Run 20261017-1900-marketing-p0-settings.sql and 20261019-1000-marketing-leads.sql FIRST.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketing_sales (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id               uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE RESTRICT,
  lead_id               uuid NOT NULL REFERENCES marketing_leads(id) ON DELETE RESTRICT,
  kind                  text NOT NULL CHECK (length(btrim(kind)) > 0),            -- a key from the sale_kinds setting
  amount_cents          integer NOT NULL CHECK (amount_cents > 0),
  currency              text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  note                  text,
  status                text NOT NULL DEFAULT 'link_created'
                        CHECK (status IN ('link_created', 'paid', 'refunded', 'partly_refunded', 'failed', 'expired')),
  created_by            text NOT NULL,
  created_by_user_id    uuid,
  -- the terms copied when the link was made. NULL seller_pct = "terms not set" (e.g. upsell): Antonio applies terms later.
  term_id               uuid,
  seller_pct            numeric(5,2) CHECK (seller_pct IS NULL OR (seller_pct >= 0 AND seller_pct <= 100)),
  td_pct                numeric(5,2),
  term_basis            text,
  payee_account_id      uuid,
  seller_cents          integer CHECK (seller_cents IS NULL OR seller_cents >= 0),
  td_cents              integer CHECK (td_cents IS NULL OR td_cents >= 0),
  stripe_session_id     text,
  stripe_payment_intent text,
  checkout_url          text,
  link_expires_at       timestamptz,
  paid_at               timestamptz,
  paid_amount_cents     integer,
  refunded_at           timestamptz,
  refunded_cents        integer NOT NULL DEFAULT 0,
  needs_attention       text,                                                      -- plain-words flag for Antonio (e.g. a partial refund, an amount that differs)
  -- Antonio's payout to the seller's company
  paid_out_at           timestamptz,
  paid_out_reference    text,
  paid_out_by           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (seller_cents IS NULL OR td_cents IS NULL OR seller_cents + td_cents = amount_cents)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_sales_session ON marketing_sales (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_sales_pi   ON marketing_sales (stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_sales_team ON marketing_sales (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_sales_lead ON marketing_sales (lead_id);

ALTER TABLE marketing_sales ENABLE ROW LEVEL SECURITY;

-- Every migration that creates a table ends with the standing lock (tests/unit/migrations-marketing-lock.test.ts enforces it).
SELECT public.marketing_lock_all_tables();
