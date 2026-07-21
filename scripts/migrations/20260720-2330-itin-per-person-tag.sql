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
