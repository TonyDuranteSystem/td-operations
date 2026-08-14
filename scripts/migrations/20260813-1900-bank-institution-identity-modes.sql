-- Identity build step 1 (card 4a39e0fd queue, sysdoc pnl-bank-account-identity-plan §A).
-- The institution registry becomes REAL CATALOG DATA: every bank_export_guides
-- row carries an identity_mode, and the six seed-only institutions become rows —
-- so staff can add or reclassify an institution from /catalog without a deploy.
--
-- identity_mode semantics (Antonio's three-bucket rule):
--   account_number — US/traditional banks + US fintechs: the client-provided
--                    account number discriminates (a client can hold two).
--   currency       — multi-currency services (one profile, many balances):
--                    the currency discriminates; no number asked.
--   crypto         — exchanges: the asset/currency discriminates.
--
-- match_terms are ADDITIVE here (never removed) and copied from the reviewed
-- code seed so the catalog is the superset. Aliases must be UNAMBIGUOUS full
-- names — the resolver matches exact-normalized, never substring/fuzzy.

-- 1. Stamp identity_mode + widen match_terms on the eight existing rows.
UPDATE catalog_entries SET metadata = metadata
  || jsonb_build_object('identity_mode', 'account_number')
  || jsonb_build_object('match_terms', '["chase","chase bank","chase bank na","chase bank n a","jpmorgan","jp morgan","jpmorgan chase","jp morgan chase","jpmorgan chase bank","jpmorgan chase bank na","jpmorgan chase bank n a"]'::jsonb)
  WHERE catalog_id='bank_export_guides' AND slug='chase';
UPDATE catalog_entries SET metadata = metadata
  || jsonb_build_object('identity_mode', 'account_number')
  || jsonb_build_object('match_terms', '["mercury","mercury bank"]'::jsonb)
  WHERE catalog_id='bank_export_guides' AND slug='mercury';
UPDATE catalog_entries SET metadata = metadata
  || jsonb_build_object('identity_mode', 'account_number')
  || jsonb_build_object('match_terms', '["relay","relay financial"]'::jsonb)
  WHERE catalog_id='bank_export_guides' AND slug='relay';
UPDATE catalog_entries SET metadata = metadata
  || jsonb_build_object('identity_mode', 'account_number')
  || jsonb_build_object('match_terms', '["slash","slash financial","slash financial inc"]'::jsonb)
  WHERE catalog_id='bank_export_guides' AND slug='slash';
UPDATE catalog_entries SET metadata = metadata
  || jsonb_build_object('identity_mode', 'account_number')
  || jsonb_build_object('match_terms', '["paypal","pay pal"]'::jsonb)
  WHERE catalog_id='bank_export_guides' AND slug='paypal';
UPDATE catalog_entries SET metadata = metadata
  || jsonb_build_object('identity_mode', 'currency')
  || jsonb_build_object('match_terms', '["wise","transferwise","wise us inc"]'::jsonb)
  WHERE catalog_id='bank_export_guides' AND slug='wise';
UPDATE catalog_entries SET metadata = metadata
  || jsonb_build_object('identity_mode', 'currency')
  || jsonb_build_object('match_terms', '["airwallex"]'::jsonb)
  WHERE catalog_id='bank_export_guides' AND slug='airwallex';
UPDATE catalog_entries SET metadata = metadata
  || jsonb_build_object('identity_mode', 'currency')
  || jsonb_build_object('match_terms', '["revolut","revolut business"]'::jsonb)
  WHERE catalog_id='bank_export_guides' AND slug='revolut';

-- 2. The six institutions that existed only in the code seed become rows.
--    (No export-guide steps yet — the wizard's guide panel simply has nothing
--    to show for them until someone writes steps; identity works regardless.)
INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('bank_export_guides', 'bank-of-america', 'Bank of America', 'active',
   '{"identity_mode":"account_number","match_terms":["bank of america","bank of america na","bank of america n a","bofa"]}'::jsonb),
  ('bank_export_guides', 'wells-fargo', 'Wells Fargo', 'active',
   '{"identity_mode":"account_number","match_terms":["wells fargo","wells fargo bank","wells fargo bank na","wells fargo bank n a"]}'::jsonb),
  ('bank_export_guides', 'brex', 'Brex', 'active',
   '{"identity_mode":"account_number","match_terms":["brex"]}'::jsonb),
  ('bank_export_guides', 'payoneer', 'Payoneer', 'active',
   '{"identity_mode":"currency","match_terms":["payoneer"]}'::jsonb),
  ('bank_export_guides', 'kraken', 'Kraken', 'active',
   '{"identity_mode":"crypto","match_terms":["kraken","payward","payward interactive","payward interactive inc","kraken payward interactive inc"]}'::jsonb),
  ('bank_export_guides', 'coinbase', 'Coinbase', 'active',
   '{"identity_mode":"crypto","match_terms":["coinbase"]}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE SET
  metadata = catalog_entries.metadata || EXCLUDED.metadata,
  status = EXCLUDED.status;
