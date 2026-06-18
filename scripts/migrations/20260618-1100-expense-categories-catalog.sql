-- Expense-category buckets as a FLEXIBLE, SHARED catalog (2026-06-18, Antonio).
-- The tax-financials review groups the client's spending into accountant
-- buckets (Software, Travel, Meals, ...). These must NOT be a hardcoded list:
-- when a client adds a new bucket it is MEMORIZED and offered to everyone next
-- time. That is exactly the catalog framework (R106) — one definition row +
-- one entry per bucket; new buckets are just new active entries (admin_can_add_rows=true).
-- The AI suggests a bucket from the live list; the review UI lets the client
-- pick an existing one or add a new one (deduped by slug).
-- Bucket labels are ENGLISH ONLY (Antonio, 2026-06-18) — no label_it.

INSERT INTO public.catalog_definitions (id, display_name, description, admin_can_add_rows)
SELECT 'expense_categories', 'Expense Categories (Tax Financials)',
  'Accountant buckets for grouping a client''s business spending on the tax-financials review (Software, Travel, Meals, ...). Shared + client-extensible: a bucket added by one client is offered to all. English only. metadata: sort_order, seeded(bool).',
  true
WHERE NOT EXISTS (SELECT 1 FROM public.catalog_definitions WHERE id = 'expense_categories');

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
SELECT 'expense_categories', v.slug, v.display_name, 'active', v.metadata::jsonb
FROM (VALUES
  ('software_saas',          'Software & SaaS',            '{"sort_order":10,"seeded":true}'),
  ('advertising_marketing',  'Advertising & Marketing',    '{"sort_order":20,"seeded":true}'),
  ('professional_services',  'Professional Services',      '{"sort_order":30,"seeded":true}'),
  ('contractors_freelance',  'Contractors & Freelancers',  '{"sort_order":40,"seeded":true}'),
  ('travel',                 'Travel',                     '{"sort_order":50,"seeded":true}'),
  ('meals_entertainment',    'Meals & Entertainment',      '{"sort_order":60,"seeded":true}'),
  ('fuel_auto',              'Fuel & Auto',                '{"sort_order":70,"seeded":true}'),
  ('groceries_retail',       'Groceries & Retail',         '{"sort_order":80,"seeded":true}'),
  ('shipping_logistics',     'Shipping & Logistics',       '{"sort_order":90,"seeded":true}'),
  ('office_equipment',       'Office & Equipment',         '{"sort_order":100,"seeded":true}'),
  ('utilities_telecom',      'Utilities & Telecom',        '{"sort_order":110,"seeded":true}'),
  ('bank_platform_fees',     'Bank & Platform Fees',       '{"sort_order":120,"seeded":true}'),
  ('cost_of_goods',          'Cost of Goods / Inventory',  '{"sort_order":130,"seeded":true}'),
  ('other',                  'Other',                      '{"sort_order":999,"seeded":true}')
) AS v(slug, display_name, metadata)
WHERE NOT EXISTS (
  SELECT 1 FROM public.catalog_entries c WHERE c.catalog_id = 'expense_categories' AND c.slug = v.slug
);

-- Strip any Italian label from rows seeded by an earlier run of this migration
-- (idempotent — no-op once labels are gone).
UPDATE public.catalog_entries
SET metadata = metadata - 'label_it'
WHERE catalog_id = 'expense_categories' AND metadata ? 'label_it';
