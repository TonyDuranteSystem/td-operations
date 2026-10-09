-- Which installed app a staff push subscription belongs to (dev job c1e326dd, TD Talk).
--
-- TD Talk (the standalone WhatsApp-style team chat) installs next to the CRM app from the same website, and each
-- installed app has its own push subscription. Without a marker, a person with BOTH apps gets every message twice,
-- and TD Talk would also receive channel/topic/client pushes it never shows.
--
--   app IS NULL  → the CRM app (every row that exists today; unchanged behaviour)
--   app = 'talk' → TD Talk
--
-- Routing rule (lib/push/route-subscriptions.ts): TD Talk receives DIRECT MESSAGES only; a person who has a TD Talk
-- subscription gets their direct messages THERE instead of in the CRM app (no double buzz); everything else goes to
-- the CRM app as before.
--
-- No CHECK constraint on the value (the db-contract gate): the one writer (POST /api/admin/push) only ever stores
-- NULL or 'talk'. DDL must run BEFORE the code deploys in each environment (the code reads and writes this column).

ALTER TABLE public.admin_push_subscriptions ADD COLUMN IF NOT EXISTS app text;
