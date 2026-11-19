-- UNDO for 20261115-1700-booking-links-paid.sql (dev job 74432428).
-- REFUSES while any link has been paid: paid_session_id is the only place that says which Stripe payment a link took, and dropping the column would lose it.
-- Plain DROP COLUMN (no CASCADE): a column something still depends on makes this fail instead of silently dropping the dependant.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.booking_links WHERE paid_session_id IS NOT NULL) THEN
    RAISE EXCEPTION 'UNDO refused: at least one booking link has been paid (paid_session_id is set). Dropping the columns would lose which payment it was.';
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_booking_links_paid_open;
DROP INDEX IF EXISTS public.uq_booking_links_stripe_session;
DROP INDEX IF EXISTS public.uq_booking_links_pay_code;

ALTER TABLE public.booking_links
  DROP COLUMN IF EXISTS not_charging_at,
  DROP COLUMN IF EXISTS paid_at,
  DROP COLUMN IF EXISTS paid_session_id,
  DROP COLUMN IF EXISTS sent_count,
  DROP COLUMN IF EXISTS sent_at,
  DROP COLUMN IF EXISTS session_claim_at,
  DROP COLUMN IF EXISTS session_expires_at,
  DROP COLUMN IF EXISTS stripe_session_id,
  DROP COLUMN IF EXISTS pay_code,
  DROP COLUMN IF EXISTS pay_mode,
  DROP COLUMN IF EXISTS pay_label,
  DROP COLUMN IF EXISTS pay_currency,
  DROP COLUMN IF EXISTS pay_amount_cents;

COMMIT;

SELECT count(*) AS remaining_pay_columns FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'booking_links' AND column_name LIKE 'pay\_%' ESCAPE '\';
