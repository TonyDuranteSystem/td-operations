-- N0b (dev job f907220c, Antonio-approved plan v3 2026-09-30): record WHICH version of the
-- contract text every offer was sent with, and which version each client signed.
-- See lib/offers/contract-version.ts (CURRENT_CONTRACT_VERSION must equal the default below).
--
-- Additive and safe to run BEFORE the code (nothing reads these columns until the code ships).
-- Idempotent.

-- 1. Every offer carries the version it was sent with. The DEFAULT stamps every new offer on
--    every insert path (CRM, MCP, tax quote, revisions) with no code change.
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS contract_version text;
ALTER TABLE public.offers ALTER COLUMN contract_version SET DEFAULT '2026-09-30';

-- 2. Existing offers: those already signed were signed against OLDER text — mark them
--    'pre-versioning' (their signed PDF is the record). Every other existing offer would be
--    signed today against today's text, so it gets the current version.
UPDATE public.offers SET contract_version = 'pre-versioning'
WHERE contract_version IS NULL AND status IN ('signed', 'completed');
UPDATE public.offers SET contract_version = '2026-09-30'
WHERE contract_version IS NULL;

COMMENT ON COLUMN public.offers.contract_version IS
  'Version of the contract TEXT this offer was sent with (N0b, 2026-09-30). ''pre-versioning'' = signed before versions existed. NOT the offer revision number (that is offers.version).';

-- 3. Every signature records the version the client actually signed.
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS contract_version text;
COMMENT ON COLUMN public.contracts.contract_version IS
  'Version of the contract TEXT the client signed, written by the server at signing (N0b, 2026-09-30). NULL = signed before versions existed.';

-- Check
SELECT contract_version, status, count(*) FROM public.offers GROUP BY 1, 2 ORDER BY 1, 2;
