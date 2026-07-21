-- ############################################################################
-- ## DEPLOYMENT ORDER IS MANDATORY — READ BEFORE APPLYING
-- ##
-- ##   1. SHIP THE CODE FIRST.
-- ##   2. THEN apply 20260720-2300 (this unique index).
-- ##   3. THEN apply 20260720-2330 (the per_person catalog tag).
-- ##
-- ## WHY THE ORDER MATTERS (Project Director, 2026-07-20):
-- ##  * Index BEFORE code: the old createItinDeliveriesFromWizard has no
-- ##    try/catch around createSD, so a 23505 from this index escapes
-- ##    uncaught and the formation-setup job FAILS and retries. You would
-- ##    turn a portal display bug into broken new-client setup.
-- ##  * Code WITHOUT the tag: getPerPersonServiceTypes() returns [], so the
-- ##    activation cap, the shortfall warning and the reactivate guard all
-- ##    silently no-op. Safe, but half the protection is switched off — do
-- ##    not stop after step 1.
-- ##
-- ## BEFORE APPLYING THIS INDEX, RE-RUN THE PRE-CHECK ON LIVE DATA:
-- ##   SELECT contact_id, count(*) FROM service_deliveries
-- ##   WHERE service_type='ITIN' AND status='active' AND contact_id IS NOT NULL
-- ##   GROUP BY contact_id HAVING count(*) > 1;
-- ## It must return ZERO rows. It did on 2026-07-20, but production moves —
-- ## if a duplicate has appeared since, the index build FAILS and you are left
-- ## half-deployed.
-- ############################################################################

-- Tag ITIN as a PER-PERSON service (Antonio, 2026-07-20).
--
-- Business rule, verbatim: "a person can't apply for two ITINs. The ITIN is one
-- for a person." A person receives exactly one ITIN in their life.
--
-- Consequence for the offer model: an offer line "ITIN ×2" ALWAYS means two
-- ITINs for two DIFFERENT PEOPLE (verified: the only such offer ever activated,
-- adam-mihaly-pter-nemeskri-2026, produced two ITIN service deliveries on two
-- different contacts — Adam Mihaly and Peter Marton Nemeskeri). It never means
-- two ITINs for the buyer. Therefore activate-service's quantity loop, which
-- creates N units of a service on ONE contact, is wrong by construction for
-- this service and must refuse rather than stack or silently drop units.
--
-- Why a TAG and not `if (service_type === 'ITIN')` in the loop: activate-service
-- already carries ITIN special-cases, and the next per-person service (ITIN
-- Renewal, an individual tax return) would reproduce the same bug from scratch.
-- Read by getPerPersonServiceTypes() in lib/services/index.ts, exactly like the
-- existing `start_at_wizard` tag — no new machinery.
--
-- Idempotent: only appends the tag when absent.

UPDATE catalog_entries
SET tags = tags || '["per_person"]'::jsonb,
    updated_at = now()
WHERE catalog_id = 'services'
  AND slug = 'itin'
  AND NOT (tags @> '["per_person"]'::jsonb);
