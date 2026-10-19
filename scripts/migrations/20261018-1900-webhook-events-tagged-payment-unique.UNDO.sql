-- Undo for 20261018-1900: drops the one-row-per-tagged-Stripe-session guard (a redelivered marketing payment could then be recorded twice).
DROP INDEX IF EXISTS public.uq_webhook_events_tagged_stripe_session;
