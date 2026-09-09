-- IRS shipment tracking (ITIN "Submitted to IRS" -> "IRS Processing"), dev job 7c3ef909.
-- Antonio: staff enter the tracking number for the package mailed to the IRS; a daily
-- cron then checks ShipStation for real delivery status and tells the client automatically
-- once it's confirmed, instead of staff checking the carrier site by hand.
--
-- Dedicated table, not columns on service_deliveries -- this data is a refreshed cache
-- (rewritten on every daily check for 7-11+ weeks), not a one-time fact, matching this
-- codebase's existing pattern for a live external-integration cache tied 1:1 to one record
-- (staff_alert_state, staff_notes -- see their RLS lockdown, copied exactly below).
--
-- created_at doubles as the immutable "how long has this really been open" clock: it is
-- set once at INSERT and never touched again by any later correction, so a staff fix (or
-- the 3-case backfill) can never accidentally reset the "stuck for 150 days" safety net.
-- Every other per-check field is a plain cache, freely overwritten.
--
-- status stores ShipStation's own tracking_status verbatim (unknown/in_transit/error/
-- delivered) for a MATCHED label, or the distinct sentinel 'not_found' when ShipStation
-- has no label at all for this number -- the two must never be conflated (a matched label
-- reading "unknown" is a real, found label; "not_found" means no label exists at all).
--
-- no_match_alerted_at and stuck_alerted_at are deliberately TWO separate flags, not one
-- shared flag -- an already-resolved "wrong number" alert must never permanently suppress
-- the unrelated "this has been stuck a very long time" safety net for the same case later.

CREATE TABLE IF NOT EXISTS public.irs_shipment_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_delivery_id uuid NOT NULL UNIQUE REFERENCES public.service_deliveries(id) ON DELETE CASCADE,
  courier text,
  tracking_number text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  status text,
  checked_at timestamptz,
  matched_ship_date date,
  consecutive_delivered_checks integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  consecutive_unmatched_checks integer NOT NULL DEFAULT 0,
  no_match_alerted_at timestamptz,
  stuck_alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS irs_shipment_tracking_number_idx
  ON public.irs_shipment_tracking (tracking_number);

CREATE INDEX IF NOT EXISTS irs_shipment_tracking_pending_idx
  ON public.irs_shipment_tracking (tracking_number)
  WHERE delivered_at IS NULL;

-- Same lockdown as staff_alert_state / staff_notes: RLS enabled, NO policy -- a direct
-- anon/authenticated PostgREST call sees nothing. Only the service-role client behind
-- requireStaffRoute() (the API route) and the cron's own service-role client ever touch it.
ALTER TABLE public.irs_shipment_tracking ENABLE ROW LEVEL SECURITY;

-- Catalog-driven trigger flag (mirrors notify_client_chat's shape) + the client-facing
-- confirmed-delivered message text. Both nullable/off by default -- adding a second
-- service later that wants this is a data change, not a code change.
ALTER TABLE public.pipeline_stages
  ADD COLUMN IF NOT EXISTS tracking_check_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tracking_delivered_message text;

-- Deliberately left OFF here (false) even though this migration also wires up the capture
-- UI below -- turning the daily check itself on is a separate go/no-go, made when the real
-- ShipStation credential is generated and the cron is registered on the schedule. Staff can
-- already enter/correct tracking numbers with the flag off; nothing checks them yet.
UPDATE public.pipeline_stages
SET tracking_delivered_message = 'Good news — the IRS has received your ITIN application.'
WHERE service_type = 'ITIN' AND stage_name = 'IRS Processing';

-- "Submitted to IRS" already carries client_chat_topic='ITIN' (2026-09-08 migration).
-- "IRS Processing" doesn't yet -- without this, the delivered-confirmed message would land
-- in a different (or no) topic than the rest of this client's ITIN conversation.
UPDATE public.pipeline_stages
SET client_chat_topic = 'ITIN'
WHERE service_type = 'ITIN' AND stage_name = 'IRS Processing';

-- Capture UI: append the tracking-entry component to BOTH stages (not just "Submitted to
-- IRS") so the 3 real cases already sitting in "IRS Processing" today have a screen to be
-- backfilled from their existing mailing-receipt scan -- not a one-off script. Appending
-- to the end of the array (not inserting at a specific position) is deliberate: simplest
-- correct way to extend a JSONB array in SQL, and where it renders on the page does not
-- affect whether the feature works.
-- Component type must already be registered in lib/flows/stage-layout.ts's whitelist and
-- components/flows/stage-renderer.tsx's switch BEFORE this row is read, or the renderer
-- silently drops it (no error, the screen just never appears) -- confirmed both are part
-- of this same change.
UPDATE public.pipeline_stages
SET stage_layout = jsonb_set(
  stage_layout,
  '{components}',
  (stage_layout->'components') || '[{"type": "irs_tracking_entry"}]'::jsonb
)
WHERE service_type = 'ITIN' AND stage_name = 'Submitted to IRS'
  AND NOT (stage_layout->'components' @> '[{"type": "irs_tracking_entry"}]');

UPDATE public.pipeline_stages
SET stage_layout = jsonb_set(
  stage_layout,
  '{components}',
  (stage_layout->'components') || '[{"type": "irs_tracking_entry"}]'::jsonb
)
WHERE service_type = 'ITIN' AND stage_name = 'IRS Processing'
  AND NOT (stage_layout->'components' @> '[{"type": "irs_tracking_entry"}]');
