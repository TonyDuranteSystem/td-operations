-- Admin Push Subscriptions — stores web push endpoints for CRM admin users
-- Already executed on 2026-03-30

CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_push_subs_user ON admin_push_subscriptions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_push_subs_unique ON admin_push_subscriptions(user_id, endpoint);
ALTER TABLE admin_push_subscriptions ENABLE ROW LEVEL SECURITY;
