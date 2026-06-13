-- itin_expiring_digits: tracks which ITIN middle digits the IRS declares expiring each year.
-- Staff seeds a new row each year when IRS publishes the batch expiration schedule.
CREATE TABLE IF NOT EXISTS itin_expiring_digits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year integer NOT NULL,
  middle_digits text[] NOT NULL,
  source_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (year)
);

-- Seed 2026 data: IRS batch expiration — all ITINs with middle digits 70-88 must be renewed
INSERT INTO itin_expiring_digits (year, middle_digits, source_url, notes)
VALUES (
  2026,
  ARRAY['70','71','72','73','74','75','76','77','78','79','80','81','82','83','84','85','86','87','88'],
  'https://www.irs.gov/individuals/itin-expiration-faqs',
  'IRS batch expiration schedule for 2026 — ITINs with these middle digits expire if not filed on 2023, 2024, or 2025 tax returns'
)
ON CONFLICT (year) DO NOTHING;
