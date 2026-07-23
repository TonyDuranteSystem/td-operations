-- ITIN "Client Signing" — the office address becomes a token, not a copy.
--
-- Data migration (DML). The staff waiting_notice on this stage stored the TD
-- office address as literal text, and that copy had ALREADY DRIFTED from the
-- constant in lib/td-address.ts: it read "11125 Park Blvd Suite 104-153,
-- Seminole, Florida 33772" (no comma before Suite, "Florida" spelled out) while
-- every code site read "11125 Park Blvd, Suite 104-153, Seminole, FL 33772".
-- Two copies of one fact, silently disagreeing, with nothing to catch it.
--
-- parseStageLayout (lib/flows/stage-layout.ts) now resolves {td_mailing_address}
-- from STAGE_LAYOUT_TOKENS at render, so the row carries a reference instead of
-- a copy and cannot drift again. Unknown tokens are left literal, so a rendering
-- gap is VISIBLE rather than a silently blank address — which matters here: this
-- is the stage where a client posts their original passport and wet-ink W-7.
--
-- Already applied by hand to production and sandbox on 2026-07-22; this file
-- exists so a fresh environment seeded from migrations gets the token too,
-- rather than the dead literal in 20260615-2100 (see its SUPERSEDED banner).
--
-- Idempotent: targets the waiting_notice at components[0] and only rewrites the
-- label. Everything else on the row — shipping_info, the advance button, the
-- viewer, the chat — is untouched.

UPDATE pipeline_stages
SET stage_layout = jsonb_set(
  stage_layout,
  '{components,0,label}',
  '"Mail to: {td_mailing_address}"'::jsonb
)
WHERE service_type = 'ITIN'
  AND stage_name = 'Client Signing'
  AND stage_layout->'components'->0->>'type' = 'waiting_notice';
