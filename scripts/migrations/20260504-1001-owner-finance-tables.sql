-- Migration: owner finance tables for /owner CRM section
-- Tables: owner_vendor_rules, bookkeeper_reviews, bookkeeper_review_items
-- Applied to sandbox first (R105), then production after Antonio approval.

-- Vendor memory: counterparty → auto-category rules
CREATE TABLE IF NOT EXISTS owner_vendor_rules (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_pattern TEXT NOT NULL,
  match_type           TEXT NOT NULL DEFAULT 'exact', -- 'exact' | 'contains' | 'regex'
  category             TEXT NOT NULL,
  subcategory          TEXT NOT NULL,
  is_related_party     BOOLEAN NOT NULL DEFAULT FALSE,
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owner_vendor_rules_pattern ON owner_vendor_rules(counterparty_pattern);

-- Annual bookkeeper review sessions
CREATE TABLE IF NOT EXISTS bookkeeper_reviews (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year              INTEGER NOT NULL,
  bookkeeper            TEXT,
  source_file_name      TEXT,
  source_file_drive_id  TEXT,
  status                TEXT NOT NULL DEFAULT 'open', -- 'open' | 'in_progress' | 'resolved' | 'sent'
  sent_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tax_year)
);

-- Individual review questions/flags within a session
CREATE TABLE IF NOT EXISTS bookkeeper_review_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id        UUID NOT NULL REFERENCES bookkeeper_reviews(id) ON DELETE CASCADE,
  section          TEXT NOT NULL, -- 'Bank & Credit Card' | 'Profit & Loss' | 'Balance Sheet'
  item_number      INTEGER,
  description      TEXT NOT NULL,
  amount           NUMERIC,
  transaction_date DATE,
  counterparty     TEXT,
  bank_account     TEXT,
  tx_id            UUID REFERENCES bank_transactions(id),
  status           TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'answered' | 'skipped'
  answer           TEXT,
  answer_category  TEXT,
  answered_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_review_items_review_id ON bookkeeper_review_items(review_id);
CREATE INDEX IF NOT EXISTS idx_review_items_status    ON bookkeeper_review_items(status);
