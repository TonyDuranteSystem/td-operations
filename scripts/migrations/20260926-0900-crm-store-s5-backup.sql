-- CRM Store — slice S5: the automatic ONE-WAY backup CRM store → Google Drive (master plan v4.5 §8.7,
-- §8.9 #5; decisions #10 #27 #36 #61 #62 #63; job 685467b5). SANDBOX FIRST. Dark: the kill switch
-- STORE_BACKUP_ENABLED is OFF by default and nothing is scheduled.
--
-- Antonio 2026-09-26: #62 the backup goes INTO THE EXISTING client Drive folders — it only adds and
-- updates its own copies there and NEVER renames, moves, overwrites or deletes an existing folder or
-- original (adopted items are fixed); #63 personal documents and trashed copies live in a SEPARATE
-- PRIVATE Shared Drive.
--
-- The database keeps STATE only (the Drive work is lib/crm-store/backup.ts):
--   · store_backup_state — per owner: lease (one worker), watermark (last event caught up to), failures
--     with back-off, the date the owner was switched to the store (the 6-month window, #10).
--   · store_backup_places — the fixed Drive folders the backup files into (state folders, "_In formation",
--     People, Unfiled, the protected areas) — one row per place, created once under a claim, never guessed.
--   · store_backup_record_ref — the only writer of Drive ids for the backup: 'backup' rows only. An
--     IMPORT row (Stage 2) is never modified: the imported Drive original is fixed.
--   · store_backup_gaps / store_backup_gap_counts — the completeness alarm.

BEGIN;

CREATE TABLE IF NOT EXISTS public.store_backup_state (
  owner_id          uuid PRIMARY KEY REFERENCES public.store_owners(id) ON DELETE RESTRICT,
  first_backup_at   timestamptz,
  last_success_at   timestamptz,
  last_event_id     bigint NOT NULL DEFAULT 0,
  last_full_check_at timestamptz,
  lease_token       uuid,
  lease_until       timestamptz,
  last_error        text,
  last_error_at     timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  switched_at       timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.store_backup_state ADD COLUMN IF NOT EXISTS switched_at timestamptz;
ALTER TABLE public.store_backup_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_backup_state FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.store_backup_places (
  place_key    text PRIMARY KEY,
  drive_id     text UNIQUE,
  claim_token  uuid,
  claim_until  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_backup_places_shape CHECK (drive_id IS NOT NULL OR claim_token IS NOT NULL)
);
ALTER TABLE public.store_backup_places ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_backup_places FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS store_external_refs_object_idx ON public.store_external_refs (object_kind, object_id);

-- ─────────────────────────────────────────────────────────────── places (fixed Drive folders)
-- Returns {drive_id} when the place exists; {claim} (a token) when THIS caller must create it now;
-- {busy} while another worker is creating it (the caller fails soft and retries next run).
CREATE OR REPLACE FUNCTION public.store_backup_place(p_key text, p_lease interval DEFAULT interval '5 minutes')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_token uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.store_backup_places (place_key, claim_token, claim_until) VALUES (p_key, v_token, now() + p_lease)
  ON CONFLICT (place_key) DO NOTHING;
  SELECT * INTO r FROM public.store_backup_places WHERE place_key = p_key FOR UPDATE;
  IF r.drive_id IS NOT NULL THEN RETURN jsonb_build_object('drive_id', r.drive_id); END IF;
  IF r.claim_token = v_token THEN RETURN jsonb_build_object('claim', v_token); END IF;
  IF r.claim_until < now() THEN
    UPDATE public.store_backup_places SET claim_token = v_token, claim_until = now() + p_lease, updated_at = now() WHERE place_key = p_key;
    RETURN jsonb_build_object('claim', v_token);
  END IF;
  RETURN jsonb_build_object('busy', true);
END $$;

CREATE OR REPLACE FUNCTION public.store_backup_place_set(p_key text, p_token uuid, p_drive_id text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.store_backup_places SET drive_id = p_drive_id, claim_token = NULL, claim_until = NULL, updated_at = now()
   WHERE place_key = p_key AND claim_token = p_token AND drive_id IS NULL;
  RETURN FOUND;
END $$;

-- A place whose Drive folder is gone (deleted by hand) is forgotten so the next run re-creates it —
-- only if it still points at that exact folder (never clears a place someone else just fixed).
CREATE OR REPLACE FUNCTION public.store_backup_place_reset(p_key text, p_drive_id text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.store_backup_places WHERE place_key = p_key AND drive_id = p_drive_id;
  RETURN FOUND;
END $$;

-- ─────────────────────────────────────────────────────────────── lease: one worker per owner
-- Takes the owner lock first so no content change can still be in flight below the watermark.
-- A previous run whose lease ran out without finishing (killed) counts as a failure.
CREATE OR REPLACE FUNCTION public.store_backup_claim(p_owner_id uuid, p_lease interval DEFAULT interval '10 minutes')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  s record;
  v_token uuid := gen_random_uuid();
  v_upto bigint;
BEGIN
  PERFORM public.store_lock_owner(p_owner_id);
  INSERT INTO public.store_backup_state (owner_id) VALUES (p_owner_id) ON CONFLICT (owner_id) DO NOTHING;
  SELECT * INTO s FROM public.store_backup_state WHERE owner_id = p_owner_id FOR UPDATE;
  IF s.lease_until IS NOT NULL AND s.lease_until > now() THEN
    RETURN jsonb_build_object('claimed', false, 'busy_until', s.lease_until);
  END IF;
  IF s.lease_token IS NOT NULL THEN   -- the last run never finished (killed by the time limit)
    UPDATE public.store_backup_state SET consecutive_failures = consecutive_failures + 1,
           last_error = 'the previous backup run did not finish (stopped by the time limit)', last_error_at = now()
     WHERE owner_id = p_owner_id;
  END IF;
  SELECT coalesce(max(id), 0) INTO v_upto FROM public.store_events WHERE owner_id = p_owner_id;
  UPDATE public.store_backup_state SET lease_token = v_token, lease_until = now() + p_lease, updated_at = now()
   WHERE owner_id = p_owner_id;
  RETURN jsonb_build_object('claimed', true, 'token', v_token, 'up_to_event', v_upto,
                            'full_check_due', s.last_full_check_at IS NULL OR s.last_full_check_at < now() - interval '24 hours');
END $$;

-- Finish a run. ok: the watermark moves to where the run started. deferred (stopped cleanly before the
-- time limit, work saved): no watermark move, not a failure. Otherwise a failure (back-off grows).
DROP FUNCTION IF EXISTS public.store_backup_finish(uuid, uuid, boolean, bigint, text, boolean);
CREATE OR REPLACE FUNCTION public.store_backup_finish(p_owner_id uuid, p_token uuid, p_outcome text, p_up_to_event bigint,
                                                     p_error text DEFAULT NULL, p_full_check boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF p_outcome NOT IN ('ok','deferred','failed') THEN RAISE EXCEPTION 'store backup: unknown outcome %', p_outcome; END IF;
  UPDATE public.store_backup_state SET
         lease_token = NULL, lease_until = NULL, updated_at = now(),
         first_backup_at = CASE WHEN p_outcome = 'ok' THEN coalesce(first_backup_at, now()) ELSE first_backup_at END,
         last_success_at = CASE WHEN p_outcome = 'ok' THEN now() ELSE last_success_at END,
         last_event_id   = CASE WHEN p_outcome = 'ok' THEN greatest(last_event_id, p_up_to_event) ELSE last_event_id END,
         last_full_check_at = CASE WHEN p_outcome = 'ok' AND p_full_check THEN now() ELSE last_full_check_at END,
         last_error      = CASE WHEN p_outcome = 'failed' THEN left(p_error, 2000) WHEN p_outcome = 'ok' THEN NULL ELSE last_error END,
         last_error_at   = CASE WHEN p_outcome = 'failed' THEN now() ELSE last_error_at END,
         consecutive_failures = CASE WHEN p_outcome = 'ok' THEN 0 WHEN p_outcome = 'failed' THEN consecutive_failures + 1 ELSE consecutive_failures END
   WHERE owner_id = p_owner_id AND lease_token = p_token;
  RETURN FOUND;
END $$;

-- An error that happens before a run can even start (e.g. missing configuration) is still recorded.
CREATE OR REPLACE FUNCTION public.store_backup_note_error(p_owner_id uuid, p_error text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.store_backup_state (owner_id, last_error, last_error_at, consecutive_failures)
  VALUES (p_owner_id, left(p_error, 2000), now(), 1)
  ON CONFLICT (owner_id) DO UPDATE SET last_error = left(p_error, 2000), last_error_at = now(),
         consecutive_failures = store_backup_state.consecutive_failures + 1, updated_at = now()
$$;

-- Owners that need a run, real changes first; a failing owner waits (2^failures minutes, max 24h).
CREATE OR REPLACE FUNCTION public.store_backup_dirty_owners(p_full_check_every interval DEFAULT interval '24 hours', p_limit integer DEFAULT 50)
RETURNS TABLE (owner_id uuid, reason text) LANGUAGE sql STABLE AS $$
  SELECT id, reason FROM (
    SELECT o.id,
           CASE WHEN s.owner_id IS NULL OR s.last_success_at IS NULL THEN 'never'
                WHEN EXISTS (SELECT 1 FROM public.store_events e WHERE e.owner_id = o.id AND e.id > s.last_event_id) THEN 'changed'
                ELSE 'check' END AS reason,
           s.last_success_at
      FROM public.store_owners o
      LEFT JOIN public.store_backup_state s ON s.owner_id = o.id
     WHERE EXISTS (SELECT 1 FROM public.store_files f WHERE f.owner_id = o.id)
       AND (s.lease_until IS NULL OR s.lease_until <= now())
       AND (s.consecutive_failures IS NULL OR s.consecutive_failures = 0 OR s.last_error_at IS NULL
            OR s.last_error_at < now() - least(make_interval(mins => power(2, least(s.consecutive_failures, 11))::int), interval '24 hours'))
       AND ( s.owner_id IS NULL OR s.last_success_at IS NULL
          OR EXISTS (SELECT 1 FROM public.store_events e WHERE e.owner_id = o.id AND e.id > s.last_event_id)
          OR s.last_full_check_at IS NULL OR s.last_full_check_at < now() - p_full_check_every )
  ) d
  ORDER BY CASE reason WHEN 'changed' THEN 0 WHEN 'never' THEN 1 ELSE 2 END, last_success_at NULLS FIRST
  LIMIT p_limit
$$;

-- ─────────────────────────────────────────────────────────────── the backup's Drive ids
-- Upsert THIS object's 'backup' reference. Import references are never touched here.
CREATE OR REPLACE FUNCTION public.store_backup_record_ref(p_object_kind text, p_object_id uuid, p_external_id text,
                                                         p_sha256 text, p_drive_path jsonb, p_status text DEFAULT 'ok')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.store_external_refs (object_kind, object_id, provider, direction, external_id, status, backed_up_sha256, drive_path, last_checked_at)
  VALUES (p_object_kind, p_object_id, 'gdrive', 'backup', p_external_id, p_status, p_sha256, coalesce(p_drive_path, '{}'::jsonb), now())
  ON CONFLICT (object_kind, object_id, provider, direction) DO UPDATE
     SET external_id = EXCLUDED.external_id,
         backed_up_sha256 = coalesce(EXCLUDED.backed_up_sha256, store_external_refs.backed_up_sha256),
         drive_path = store_external_refs.drive_path || EXCLUDED.drive_path,
         status = EXCLUDED.status, last_checked_at = now(), updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ─────────────────────────────────────────────────────────────── the 6-month window (#10)
-- Stage 1 stamps the day an owner is switched to the store; the window is counted from THAT day.
CREATE OR REPLACE FUNCTION public.store_backup_mark_switched(p_owner_id uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.store_backup_state (owner_id, switched_at) VALUES (p_owner_id, now())
  ON CONFLICT (owner_id) DO UPDATE SET switched_at = coalesce(store_backup_state.switched_at, now()), updated_at = now()
$$;

DROP FUNCTION IF EXISTS public.store_backup_window_ended(integer);
CREATE OR REPLACE FUNCTION public.store_backup_window_ended(p_months integer DEFAULT 6)
RETURNS TABLE (owner_id uuid, switched_at timestamptz) LANGUAGE sql STABLE AS $$
  SELECT owner_id, switched_at FROM public.store_backup_state
   WHERE switched_at IS NOT NULL AND switched_at < now() - make_interval(months => p_months)
$$;

-- ─────────────────────────────────────────────────────────────── completeness alarm
-- A file counts as backed up when its BACKUP copy holds the current bytes in the right area, or (for an
-- imported file never changed since) its imported Drive original holds exactly those bytes.
CREATE OR REPLACE FUNCTION public.store_backup_file_ok(p_file_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE f.state
    WHEN 'live' THEN EXISTS (SELECT 1 FROM public.store_external_refs r
                              WHERE r.object_kind = 'file' AND r.object_id = f.id AND r.provider = 'gdrive' AND r.status = 'ok'
                                AND r.backed_up_sha256 = v.sha256
                                AND ((r.direction = 'backup' AND r.drive_path->>'area' = 'live') OR r.direction = 'import'))
    WHEN 'trashed' THEN EXISTS (SELECT 1 FROM public.store_external_refs r
                                 WHERE r.object_kind = 'file' AND r.object_id = f.id AND r.provider = 'gdrive' AND r.status = 'ok'
                                   AND ((r.direction = 'backup' AND r.drive_path->>'area' = 'protected') OR r.direction = 'import'))
    ELSE true END
    FROM public.store_files f LEFT JOIN public.store_file_versions v ON v.id = f.current_version_id
   WHERE f.id = p_file_id
$$;

DROP FUNCTION IF EXISTS public.store_backup_gaps(interval, integer);
-- kind: missing_file / protected_missing / no_bytes (a live file without a saved version) /
-- owner_failing (3+ failed runs) / owner_late (changes older than p_late not yet backed up).
CREATE OR REPLACE FUNCTION public.store_backup_gaps(p_late interval DEFAULT interval '6 hours', p_limit_per_kind integer DEFAULT 100)
RETURNS TABLE (kind text, owner_id uuid, file_id uuid, detail text) LANGUAGE sql STABLE AS $$
  (SELECT 'owner_failing', s.owner_id, NULL::uuid, s.last_error FROM public.store_backup_state s
    WHERE s.consecutive_failures >= 3 ORDER BY s.last_error_at DESC LIMIT p_limit_per_kind)
  UNION ALL
  (SELECT 'owner_late', s.owner_id, NULL::uuid, 'changes waiting since ' || min(e.occurred_at)::text
     FROM public.store_backup_state s JOIN public.store_events e ON e.owner_id = s.owner_id AND e.id > s.last_event_id
    GROUP BY s.owner_id HAVING min(e.occurred_at) < now() - p_late LIMIT p_limit_per_kind)
  UNION ALL
  (SELECT 'no_bytes', f.owner_id, f.id, f.name FROM public.store_files f
    WHERE f.state = 'live' AND f.current_version_id IS NULL LIMIT p_limit_per_kind)
  UNION ALL
  (SELECT CASE f.state WHEN 'live' THEN 'missing_file' ELSE 'protected_missing' END, f.owner_id, f.id, f.name
     FROM public.store_files f
    WHERE f.state IN ('live','trashed') AND f.current_version_id IS NOT NULL AND NOT public.store_backup_file_ok(f.id)
    LIMIT p_limit_per_kind)
$$;

CREATE OR REPLACE FUNCTION public.store_backup_gap_counts(p_late interval DEFAULT interval '6 hours')
RETURNS TABLE (kind text, n bigint) LANGUAGE sql STABLE AS $$
  SELECT 'missing_file', count(*) FROM public.store_files f
   WHERE f.state = 'live' AND f.current_version_id IS NOT NULL AND NOT public.store_backup_file_ok(f.id)
  UNION ALL SELECT 'protected_missing', count(*) FROM public.store_files f
   WHERE f.state = 'trashed' AND NOT public.store_backup_file_ok(f.id)
  UNION ALL SELECT 'no_bytes', count(*) FROM public.store_files f WHERE f.state = 'live' AND f.current_version_id IS NULL
  UNION ALL SELECT 'owner_failing', count(*) FROM public.store_backup_state s WHERE s.consecutive_failures >= 3
  UNION ALL SELECT 'owner_late', count(*) FROM (
    SELECT s.owner_id FROM public.store_backup_state s JOIN public.store_events e ON e.owner_id = s.owner_id AND e.id > s.last_event_id
     GROUP BY s.owner_id HAVING min(e.occurred_at) < now() - p_late) x
$$;

REVOKE ALL ON FUNCTION public.store_backup_place(text, interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_place_set(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_place_reset(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_claim(uuid, interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_finish(uuid, uuid, text, bigint, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_note_error(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_dirty_owners(interval, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_record_ref(text, uuid, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_mark_switched(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_window_ended(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_file_ok(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_gaps(interval, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_gap_counts(interval) FROM PUBLIC, anon, authenticated;

COMMIT;
