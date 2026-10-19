-- TD Marketing — "Connect Meta" button (dev job 9aec66fa, Slice 1c). SANDBOX FIRST; production only on Antonio's go, pasted to him in chat.
-- Additive: ONE new table, nothing existing is touched. Server only (RLS on, no policy).
--   marketing_meta_connection  the Facebook Page's access key, stored ENCRYPTED (AES-256-GCM, key derived from the Meta app secret), one row per Page.
-- The admin page's "Connect Meta" button writes it; the lead intake reads it (and falls back to the Vercel setting when there is no row).
-- Requires 20261017-1900 and 20261018-0110 (the standing lock function). Undo: 20261019-2000-marketing-meta-connection.UNDO.sql.
DO $$
BEGIN
  IF to_regprocedure('public.marketing_lock_all_tables()') IS NULL THEN
    RAISE EXCEPTION 'Run 20261018-0110-marketing-p1-db-lock.sql FIRST: marketing_lock_all_tables() is missing.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketing_meta_connection (
  page_id      text PRIMARY KEY,                       -- the Facebook Page this key belongs to
  page_name    text,
  page_key_enc text NOT NULL,                          -- v1.<iv>.<tag>.<ciphertext>, never the plain key
  user_id      text,                                   -- the person whose login produced it (Meta user id)
  user_name    text,
  long_lived   boolean NOT NULL DEFAULT false,         -- made from a long-lasting personal key (does not expire on a clock)
  connected_by text,                                   -- the admin who pressed the button
  obtained_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE marketing_meta_connection ENABLE ROW LEVEL SECURITY;

SELECT public.marketing_lock_all_tables();
