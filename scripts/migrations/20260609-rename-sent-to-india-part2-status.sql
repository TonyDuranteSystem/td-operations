-- 20260609-rename-sent-to-india-part2-status.sql  —  PART 2 of 2
-- Slice 0 — migrate the tax_returns.status enum value to the new label.
--
-- ⚠️ RUN THIS ONLY AFTER PART 1 (20260609-rename-sent-to-india.sql) HAS COMMITTED.
--    Part 1 adds the 'Sent to Accountant' label to the tax_return_status enum; that
--    ALTER TYPE ... ADD VALUE must be committed in its own transaction before this
--    UPDATE can reference the new label (Postgres SQLSTATE 55P04, "unsafe use of new
--    value ... must be committed before they can be used"). Because this lives in a
--    separate file it is run as a separate statement/transaction — which is exactly
--    what makes it legal.
--
-- The old 'Sent to India' label is NOT dropped (it stays in the enum, kept mapped
-- defensively in code). After this UPDATE, no row should carry 'Sent to India'.

UPDATE tax_returns SET status = 'Sent to Accountant' WHERE status = 'Sent to India';
