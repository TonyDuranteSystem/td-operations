-- Backfill: link COMPLETED formation offers (account_id NULL) to their formed
-- account, so the portal "Set up your new company" banner clears for companies
-- that were materialized BEFORE the going-forward fix shipped
-- (materializeFormationCompany step 10d, fix/decision-note-visibility).
--
-- The banner (app/portal/page.tsx) shows for offers with
-- contract_type='formation' AND status='completed' AND account_id IS NULL,
-- keyed by client_email. Once a company is real, the offer must carry its
-- account_id or the banner shows forever.
--
-- Matching is RELATIONSHIP-based (not hardcoded ids), so this is safe to promote
-- to production verbatim. It disambiguates multi-company clients by going through
-- the specific service delivery that came from each offer.

-- 1. Primary: via the formation SD's source_offer_token (canonical, precise).
UPDATE offers o
SET account_id = sd.account_id, updated_at = now()
FROM service_deliveries sd
WHERE o.contract_type = 'formation'
  AND o.account_id IS NULL
  AND sd.source_offer_token = o.token
  AND sd.service_type = 'Company Formation'
  AND sd.account_id IS NOT NULL;

-- 2. Fallback: via the converted lead → that contact's formation SD account,
--    for offers whose SD carries no source_offer_token. Still precise (the lead
--    is unique to one formation), never a broad email match.
UPDATE offers o
SET account_id = sd.account_id, updated_at = now()
FROM leads l
JOIN service_deliveries sd
  ON sd.contact_id = l.converted_to_contact_id
 AND sd.service_type = 'Company Formation'
 AND sd.account_id IS NOT NULL
WHERE o.contract_type = 'formation'
  AND o.account_id IS NULL
  AND l.id = o.lead_id;
