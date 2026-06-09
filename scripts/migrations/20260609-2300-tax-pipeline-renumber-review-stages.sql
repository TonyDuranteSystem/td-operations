-- 20260609-2300-tax-pipeline-renumber-review-stages.sql
-- Slice 1 Part 3 — Tax Return pipeline: ×10 gap-renumber + 6 new review-lifecycle stages
-- + client/board display metadata + service_deliveries.stage_order re-sync.
-- MIGRATION ONLY — no code changes.
--
-- Decisions (Antonio, 2026-06-09):
--   • client_label ONLY for the client-facing relabels — stage_name is NOT renamed.
--     (Renaming would break code that hardcodes the SD stage names 'Preparation' /
--      'TR Completed' / 'TR Filed': lib/operations/tax-return-sd-bridge.ts map targets,
--      lib/operations/service-delivery.ts:151/310, app/api/crm/admin-actions/contact-actions:174/249.)
--   • "2nd Installment Paid" added as a NEW stage at order 35.
--   • auto_advance = FALSE and notify_client_email = FALSE on ALL Tax Return stages
--     (spec §2 line 27; aligns the DB with instructions.ts:312 + crm.ts:71 which already
--      treat Tax Return as manual-advance). The explicit installment advance uses
--      advanceStageIfAt(), which gates by stage NAME and is unaffected by stage_order.
--   • client_label = spec §2 client-facing stage NAME. The longer §2 "Client sees"
--     sentences are NOT loaded (─ §9 lists client_label, not client_description ─);
--     add to client_description in a later slice if desired.
--
-- IDEMPOTENT & single-transaction-safe (no enum changes → no SQLSTATE 55P04):
--   • STEP 2 ×10 renumber is guarded by NOT EXISTS(stage_order > 9) — re-running is a no-op.
--   • inserts use ON CONFLICT (service_type, stage_order) DO NOTHING.
--   • metadata UPDATEs and the SD re-sync are naturally idempotent.
--
-- ⚠️ ORPHAN service_deliveries (Tax Return) — flagged for Antonio, NOT auto-fixed.
--    The STEP 5 re-sync keys on stage_name, so these (no matching pipeline stage) are left
--    untouched, keeping their current stage_order (NULL):
--      stage 'In Progress' (status Active):
--        03366231-1a5e-44ec-9392-b7609b643345
--        d99ed6f1-9a29-4b60-9a47-918160dbbe69      (account 597af4fa-df7a-4200-816b-7375e82390b5)
--      stage NULL (status cancelled, 2026-03-20 batch):
--        a3e3b8b6-5499-4c4d-b857-253422c62ebb
--        e8c0dee3-0a81-4492-b943-17854e23f689
--        c2df61bf-07c1-41ec-922e-459f70034d14
--        8da4a351-ff36-49a6-a9d3-a3509c16ba05
--        3f40354d-8c75-4e00-8e73-700d48548136
--        6ce4c567-2e4d-4a91-9cc4-ae39cd2499e8


-- ─── STEP 1 — sync sandbox to prod's legacy intake stages. No-op if already present. ───
-- Guard by stage NAME, not stage_order. A stage_order-only ON CONFLICT is NOT idempotent
-- across a full DOUBLE-RUN: after STEP 2 renumbers -1→-10 the -1 slot frees up, so a second
-- run would re-insert a DUPLICATE 'Company Data Pending' at -1 (the ×10 guard then skips it).
-- The NAME guard inserts only when the stage name does not already exist for Tax Return.
INSERT INTO pipeline_stages
  (service_type, stage_order, stage_name, auto_advance, requires_approval, notify_client_email, auto_actions, auto_tasks)
SELECT v.service_type, v.stage_order, v.stage_name, true, false, false, '[]'::jsonb, '[]'::jsonb
FROM (VALUES
  ('Tax Return'::text, -1, 'Company Data Pending'::text),
  ('Tax Return'::text,  0, 'Paid - Awaiting Data'::text)
) AS v(service_type, stage_order, stage_name)
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages ps
  WHERE ps.service_type = v.service_type AND ps.stage_name = v.stage_name
);

-- ─── STEP 2 — ×10 gap-renumber existing Tax Return stages (guarded → idempotent) ───
-- -1→-10, 0→0, 1→10, 2→20, … 9→90. Single UPDATE; new range [10..90] is disjoint from
-- the old range [-1..9] (only 0→0 overlaps, unchanged), so no transient unique collision.
UPDATE pipeline_stages
SET stage_order = stage_order * 10
WHERE service_type = 'Tax Return'
  AND NOT EXISTS (
    SELECT 1 FROM pipeline_stages p2
    WHERE p2.service_type = 'Tax Return' AND p2.stage_order > 9
  );

-- ─── STEP 3 — insert the 6 new lifecycle stages with full display metadata ───
INSERT INTO pipeline_stages
  (service_type, stage_order, stage_name,            client_label,           icon,  stale_days, auto_advance, client_visible, board_visible, notify_client_email, requires_approval, auto_actions, auto_tasks)
VALUES
  ('Tax Return', 35, '2nd Installment Paid', '2nd Installment Paid', '💰',  NULL, false, true, true, false, false, '[]'::jsonb, '[]'::jsonb),
  ('Tax Return', 45, 'Data Submitted',       'Data Submitted',       '📝',  3,    false, true, true, false, false, '[]'::jsonb, '[]'::jsonb),
  ('Tax Return', 46, 'Under Review',         'Under Review',         '🔍',  3,    false, true, true, false, false, '[]'::jsonb, '[]'::jsonb),
  ('Tax Return', 47, 'Revision Requested',   'Revision Requested',   '⚠️',  7,    false, true, true, false, false, '[]'::jsonb, '[]'::jsonb),
  ('Tax Return', 48, 'Approved',             'Approved',             '✅',  7,    false, true, true, false, false, '[]'::jsonb, '[]'::jsonb),
  ('Tax Return', 49, 'Confirmed',            'Confirmed',            '🔒',  NULL, false, true, true, false, false, '[]'::jsonb, '[]'::jsonb)
ON CONFLICT (service_type, stage_order) DO NOTHING;

-- ─── STEP 4 — display metadata on existing stages + force manual-advance / no auto-email ───
UPDATE pipeline_stages SET auto_advance = false, notify_client_email = false
WHERE service_type = 'Tax Return';

UPDATE pipeline_stages SET client_label='1st Installment Paid',         icon='💰' WHERE service_type='Tax Return' AND stage_name='1st Installment Paid';
UPDATE pipeline_stages SET client_label='Extension Filed',             icon='📄' WHERE service_type='Tax Return' AND stage_name='Extension Filed';
UPDATE pipeline_stages SET client_label='Waiting for 2nd Installment', icon='⏳' WHERE service_type='Tax Return' AND stage_name='Awaiting 2nd Payment';
UPDATE pipeline_stages SET client_label='Wizard Available',            icon='📨' WHERE service_type='Tax Return' AND stage_name='Wizard Available';
UPDATE pipeline_stages SET client_label='With Accountant',             icon='📊' WHERE service_type='Tax Return' AND stage_name='Preparation';
UPDATE pipeline_stages SET client_label='Ready to Sign',               icon='✍️' WHERE service_type='Tax Return' AND stage_name='TR Completed';
UPDATE pipeline_stages SET client_label='Filed',                       icon='📬' WHERE service_type='Tax Return' AND stage_name='TR Filed';

-- ─── STEP 5 — re-sync service_deliveries.stage_order to the renumbered pipeline (by name) ───
-- Also repairs pre-existing drift (Data Received had stage_order 3 / 5 / NULL, Preparation 5).
-- Orphan SDs ('In Progress', NULL) don't match a stage_name → left untouched (see header).
UPDATE service_deliveries sd
SET stage_order = ps.stage_order
FROM pipeline_stages ps
WHERE sd.service_type = 'Tax Return'
  AND ps.service_type = 'Tax Return'
  AND sd.stage = ps.stage_name
  AND sd.stage_order IS DISTINCT FROM ps.stage_order;
