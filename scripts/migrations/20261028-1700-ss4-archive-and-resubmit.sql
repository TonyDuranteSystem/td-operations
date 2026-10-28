-- SS-4 "Resubmit" (dev job 25e460aa): a rejected / wrong SS-4 is MOVED to an archive table and a corrected
-- one takes its place, in ONE all-or-nothing step.
--
-- Why a separate table (not a new status): the live table keeps "one SS-4 per company", which ~35 existing
-- lookups rely on. Moving the old row out means none of them change and none can ever see two rows.
-- Nothing points at ss4_applications with a foreign key (verified on production 2026-10-28).
--
-- The archive is INTERNAL ONLY (the SS-4 carries the responsible party's tax ID): RLS on, no policy,
-- no grant to anon / authenticated — only the service role (server code) reads it.

CREATE TABLE IF NOT EXISTS public.ss4_applications_archive (
  LIKE public.ss4_applications INCLUDING DEFAULTS
);

ALTER TABLE public.ss4_applications_archive
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS archived_by text,
  ADD COLUMN IF NOT EXISTS archive_reason text,
  ADD COLUMN IF NOT EXISTS replaced_by_id uuid,
  ADD COLUMN IF NOT EXISTS retired_document_ids uuid[];

-- id is the original row's id (so old links in logs / what's-new still identify it). NOT unique on token:
-- a token is only unique among LIVE rows.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ss4_applications_archive_pkey') THEN
    ALTER TABLE public.ss4_applications_archive ADD CONSTRAINT ss4_applications_archive_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ss4_archive_account_id ON public.ss4_applications_archive (account_id);

ALTER TABLE public.ss4_applications_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ss4_applications_archive FROM PUBLIC, anon, authenticated;

-- Move the old SS-4 into the archive and insert the new one, atomically.
--   p_old_id  the live SS-4 to retire
--   p_reason  why (required)
--   p_by      who (staff email / "mcp")
--   p_new     the new row's columns (only the keys supplied are inserted; table defaults fill the rest)
-- Returns the new SS-4's id. Any failure rolls the whole thing back — the old SS-4 stays exactly as it was.
CREATE OR REPLACE FUNCTION public.resubmit_ss4(p_old_id uuid, p_reason text, p_by text, p_new jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_old public.ss4_applications%ROWTYPE;
  v_new uuid;
  v_cols text;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to resubmit an SS-4';
  END IF;
  IF p_new IS NULL OR p_new = '{}'::jsonb THEN
    RAISE EXCEPTION 'The new SS-4 values are required';
  END IF;

  SELECT * INTO v_old FROM public.ss4_applications WHERE id = p_old_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SS-4 % not found (already archived?)', p_old_id;
  END IF;
  -- Re-checked HERE, under the row lock: the caller read the status a moment earlier, and "Re-send for signature" can re-open a signed
  -- SS-4 in place in between. Only an SS-4 the client already signed (or that was faxed) may be archived.
  IF v_old.status NOT IN ('signed', 'submitted', 'done', 'fax_failed') THEN
    RAISE EXCEPTION 'SS-4 % is "%" now - it is not signed, so it cannot be resubmitted. Reload and check its status.', p_old_id, v_old.status;
  END IF;

  INSERT INTO public.ss4_applications_archive
  SELECT r.*
  FROM jsonb_populate_record(
    NULL::public.ss4_applications_archive,
    to_jsonb(v_old) || jsonb_build_object('archived_at', now(), 'archived_by', p_by, 'archive_reason', btrim(p_reason))
  ) r;

  DELETE FROM public.ss4_applications WHERE id = p_old_id;

  SELECT string_agg(quote_ident(k), ', ') INTO v_cols FROM jsonb_object_keys(p_new) k;
  EXECUTE format(
    'INSERT INTO public.ss4_applications (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::public.ss4_applications, $1) RETURNING id',
    v_cols
  ) INTO v_new USING p_new;

  UPDATE public.ss4_applications_archive SET replaced_by_id = v_new WHERE id = p_old_id;
  RETURN v_new;
END
$fn$;

REVOKE ALL ON FUNCTION public.resubmit_ss4(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resubmit_ss4(uuid, text, text, jsonb) TO service_role;

-- Standing rule (marketing database lock): every migration that creates a table re-runs the lock at the end.
SELECT public.marketing_lock_all_tables();
