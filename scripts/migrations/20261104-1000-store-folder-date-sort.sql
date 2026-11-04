-- Storage: "Sort by date" button on a folder (dev job 1f4645b6, 2026-11-04). ONE nullable column remembers the choice
-- (grouping / month label / order / custom pattern) per folder. No default, no CHECK (the values are validated in code),
-- no trigger change: the Mac change feed only logs name / parent changes, so saving the choice tells Finder nothing.
ALTER TABLE public.store_folders ADD COLUMN IF NOT EXISTS date_sort jsonb;
