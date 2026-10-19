-- TD Marketing council fix (2026-10-18, dev job 9aec66fa). SANDBOX FIRST, then production by hand.
-- WHY: Stripe sometimes delivers the same event twice. For an ordinary client payment that is harmless (the rest of the handler
-- is idempotent), but a TAGGED marketing payment (payment_kind other than service_sale) is recorded ONLY as a webhook_events row,
-- and the marketing ledger reads that row — a second row would double-count Rocco's share.
-- WHAT: ONE row per Stripe session for tagged payments. A partial unique index, so the 29 existing duplicate groups of ordinary
-- events (verified on production, 0 tagged rows exist) are untouched and the index can be created safely.
-- The handler (app/api/webhooks/stripe/route.ts) treats a unique violation (23505) as "already recorded" and acknowledges it.
-- Idempotent. Undo: 20261018-1900-webhook-events-tagged-payment-unique.UNDO.sql.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_events_tagged_stripe_session
  ON public.webhook_events (source, external_id)
  WHERE source = 'stripe'
    AND external_id IS NOT NULL
    AND btrim(coalesce(payload -> 'metadata' ->> 'payment_kind', '')) <> ''
    AND lower(btrim(payload -> 'metadata' ->> 'payment_kind')) <> 'service_sale';
