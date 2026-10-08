-- N1a C3 — "Open services" page: mark the tax-return service card as "hidden from Open services" (dev job be7da01a).
--
-- The new read-only page (/calendar/open-services) lists every open job EXCEPT those whose service card says they live
-- on another page. Renewals are already marked by C0 (closes_only_by_filing). Tax returns get the same kind of mark:
--   metadata.hidden_from_open_services = true
--   metadata.delivery_service_type     = the job name, set ONLY where it is empty (so a job not linked to its card is
--                                         still recognised; some are not — 12 of 233 tax jobs on production on 2026-10-07)
-- Nothing else reads these keys: delivery_service_type is read only by the renewal-close rule, which ALSO requires
-- closes_only_by_filing on the same card, so setting it on a tax card cannot change what can be closed.
--
-- Production has the 'tax_return' card and NO 'tax_return_one_time' card (and no such jobs); sandbox has both. Each
-- is handled if present. A one-time tax job created later on production with no card would NOT be hidden — the
-- acceptance count at the end compares jobs matched by the flag with ALL open jobs whose type starts with "Tax Return".
--
-- Safety: all or nothing (one transaction); idempotent (a second run changes nothing); every change is logged in
-- catalog_decision_log WITH its before-state, so the UNDO restores exactly what this wrote; recorded in
-- service_settings_history under the actor "open-services-hidden-flag-2026-10-07". No temp tables (they fail on a
-- re-run in the Supabase editor).
--
-- Run this BEFORE (or after) the code is deployed — nothing live reads the new keys; the page that does is off until
-- the setting open_services_audience is changed.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  r           record;
  v_before    jsonb;
  v_after     jsonb;
  v_changed   int := 0;
  v_open_tax  int;
  v_open_hit  int;
BEGIN
  PERFORM set_config('request.headers', '{"x-td-actor":"open-services-hidden-flag-2026-10-07"}', true);

  -- Preconditions (fail loud): the tax card exists, and the two renewal cards still carry the C0 setting.
  IF NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'services' AND slug = 'tax_return') THEN
    RAISE EXCEPTION 'open-services flag: the tax_return service card was not found — nothing changed';
  END IF;
  IF (SELECT count(*) FROM public.catalog_entries
       WHERE catalog_id = 'services' AND slug IN ('state_ra_renewal', 'state_annual_report')
         AND metadata->>'closes_only_by_filing' = 'true') <> 2 THEN
    RAISE EXCEPTION 'open-services flag: the two renewal cards no longer both carry closes_only_by_filing — nothing changed';
  END IF;

  FOR r IN
    SELECT id, slug, metadata FROM public.catalog_entries
     WHERE catalog_id = 'services' AND slug IN ('tax_return', 'tax_return_one_time')
     ORDER BY slug
  LOOP
    v_before := COALESCE(r.metadata, '{}'::jsonb);
    v_after  := v_before || jsonb_build_object('hidden_from_open_services', true);
    IF COALESCE(v_before->>'delivery_service_type', '') = '' THEN
      v_after := v_after || jsonb_build_object(
        'delivery_service_type',
        CASE r.slug WHEN 'tax_return' THEN 'Tax Return' ELSE 'Tax Return One-Time' END);
    END IF;

    IF v_after IS DISTINCT FROM v_before THEN
      UPDATE public.catalog_entries SET metadata = v_after, updated_at = now() WHERE id = r.id;
      INSERT INTO public.catalog_decision_log (catalog_entry_id, catalog_id, action, actor_kind, reason, before_state, after_state)
      VALUES (r.id, 'services', 'metadata_changed', 'migration',
              'open-services hidden flag (N1a C3, 20261007-0100-open-services-hidden-flag.sql)',
              jsonb_build_object('slug', r.slug, 'metadata', v_before),
              jsonb_build_object('slug', r.slug, 'metadata', v_after));
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  -- Post-checks (fail loud): the tax card carries both keys now, the renewal cards are intact, and the flag reaches
  -- every open "Tax Return…" job (matched by the card link or by the job type recorded on the card).
  IF NOT EXISTS (SELECT 1 FROM public.catalog_entries
                  WHERE catalog_id = 'services' AND slug = 'tax_return'
                    AND metadata->>'hidden_from_open_services' = 'true'
                    AND COALESCE(metadata->>'delivery_service_type', '') <> '') THEN
    RAISE EXCEPTION 'open-services flag: the tax_return card does not carry both keys after the update — rolled back';
  END IF;
  IF (SELECT count(*) FROM public.catalog_entries
       WHERE catalog_id = 'services' AND slug IN ('state_ra_renewal', 'state_annual_report')
         AND metadata->>'closes_only_by_filing' = 'true') <> 2 THEN
    RAISE EXCEPTION 'open-services flag: a renewal card changed unexpectedly — rolled back';
  END IF;

  SELECT count(*) INTO v_open_tax
    FROM public.service_deliveries sd
   WHERE sd.service_type ILIKE 'Tax Return%'
     AND COALESCE(lower(sd.status), 'active') NOT IN ('completed', 'cancelled', 'canceled', 'inactive');

  SELECT count(*) INTO v_open_hit
    FROM public.service_deliveries sd
   WHERE sd.service_type ILIKE 'Tax Return%'
     AND COALESCE(lower(sd.status), 'active') NOT IN ('completed', 'cancelled', 'canceled', 'inactive')
     AND EXISTS (SELECT 1 FROM public.catalog_entries ce
                  WHERE ce.catalog_id = 'services' AND ce.metadata->>'hidden_from_open_services' = 'true'
                    AND (ce.id = sd.service_type_entry_id OR ce.metadata->>'delivery_service_type' = sd.service_type));

  IF v_open_hit <> v_open_tax THEN
    RAISE EXCEPTION 'open-services flag: % open Tax Return job(s) are NOT reached by the flag (of %) — rolled back. Add their job type to the card first.',
      v_open_tax - v_open_hit, v_open_tax;
  END IF;

  RAISE NOTICE 'open-services flag applied: % card(s) changed; % open Tax Return job(s), all hidden.', v_changed, v_open_tax;
END $$;

COMMIT;

-- Read-back: what the cards look like now, and how many open jobs each flag hides.
SELECT ce.slug,
       ce.metadata->>'hidden_from_open_services' AS hidden_from_open_services,
       ce.metadata->>'delivery_service_type'     AS delivery_service_type,
       ce.metadata->>'closes_only_by_filing'     AS closes_only_by_filing,
       (SELECT count(*) FROM public.service_deliveries sd
         WHERE COALESCE(lower(sd.status), 'active') NOT IN ('completed', 'cancelled', 'canceled', 'inactive')
           AND (ce.id = sd.service_type_entry_id OR ce.metadata->>'delivery_service_type' = sd.service_type)) AS open_jobs_matched
  FROM public.catalog_entries ce
 WHERE ce.catalog_id = 'services'
   AND (ce.metadata->>'hidden_from_open_services' = 'true' OR ce.metadata->>'closes_only_by_filing' = 'true')
 ORDER BY ce.slug;
