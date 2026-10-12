-- Drive cutover Phase 4 (dev job ad09ea91): the backup's work list and completeness alarm only look at storages that are
-- actually backed up. A hidden "study copy" (study_only) is never backed up (its company still lives in Drive) and the firm's
-- Business area / a staff member's private My files are not backed up yet (decision #94) — but until now
--   * store_backup_dirty_owners listed EVERY storage with files (production: ~525 study copies), so a real company's backup
--     could wait behind hundreds of jobs that only answer "disabled";
--   * the gap alarm counted every file of a study copy as a "missing_file".
-- Same signatures as before (CREATE OR REPLACE). No data is changed.

BEGIN;

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
     WHERE NOT o.study_only AND o.kind NOT IN ('business','private')
       AND EXISTS (SELECT 1 FROM public.store_files f WHERE f.owner_id = o.id)
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

CREATE OR REPLACE FUNCTION public.store_backup_gaps(p_late interval DEFAULT interval '6 hours', p_limit_per_kind integer DEFAULT 100)
RETURNS TABLE (kind text, owner_id uuid, file_id uuid, detail text) LANGUAGE sql STABLE AS $$
  (SELECT 'owner_failing', s.owner_id, NULL::uuid, s.last_error FROM public.store_backup_state s
    WHERE s.consecutive_failures >= 3 ORDER BY s.last_error_at DESC LIMIT p_limit_per_kind)
  UNION ALL
  (SELECT 'owner_late', s.owner_id, NULL::uuid, 'changes waiting since ' || min(e.occurred_at)::text
     FROM public.store_backup_state s JOIN public.store_events e ON e.owner_id = s.owner_id AND e.id > s.last_event_id
    WHERE EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = s.owner_id AND NOT o.study_only AND o.kind NOT IN ('business','private'))
    GROUP BY s.owner_id HAVING min(e.occurred_at) < now() - p_late LIMIT p_limit_per_kind)
  UNION ALL
  (SELECT 'no_bytes', f.owner_id, f.id, f.name FROM public.store_files f
    WHERE f.state = 'live' AND f.current_version_id IS NULL
      AND EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = f.owner_id AND NOT o.study_only AND o.kind NOT IN ('business','private'))
    LIMIT p_limit_per_kind)
  UNION ALL
  (SELECT CASE f.state WHEN 'live' THEN 'missing_file' ELSE 'protected_missing' END, f.owner_id, f.id, f.name
     FROM public.store_files f
    WHERE f.state IN ('live','trashed') AND f.current_version_id IS NOT NULL AND NOT public.store_backup_file_ok(f.id)
      AND EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = f.owner_id AND NOT o.study_only AND o.kind NOT IN ('business','private'))
    LIMIT p_limit_per_kind)
$$;

CREATE OR REPLACE FUNCTION public.store_backup_gap_counts(p_late interval DEFAULT interval '6 hours')
RETURNS TABLE (kind text, n bigint) LANGUAGE sql STABLE AS $$
  SELECT 'missing_file', count(*) FROM public.store_files f
   WHERE f.state = 'live' AND f.current_version_id IS NOT NULL AND NOT public.store_backup_file_ok(f.id)
     AND EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = f.owner_id AND NOT o.study_only AND o.kind NOT IN ('business','private'))
  UNION ALL SELECT 'protected_missing', count(*) FROM public.store_files f
   WHERE f.state = 'trashed' AND NOT public.store_backup_file_ok(f.id)
     AND EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = f.owner_id AND NOT o.study_only AND o.kind NOT IN ('business','private'))
  UNION ALL SELECT 'no_bytes', count(*) FROM public.store_files f WHERE f.state = 'live' AND f.current_version_id IS NULL
     AND EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = f.owner_id AND NOT o.study_only AND o.kind NOT IN ('business','private'))
  UNION ALL SELECT 'owner_failing', count(*) FROM public.store_backup_state s WHERE s.consecutive_failures >= 3
  UNION ALL SELECT 'owner_late', count(*) FROM (
    SELECT s.owner_id FROM public.store_backup_state s JOIN public.store_events e ON e.owner_id = s.owner_id AND e.id > s.last_event_id
     WHERE EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = s.owner_id AND NOT o.study_only AND o.kind NOT IN ('business','private'))
     GROUP BY s.owner_id HAVING min(e.occurred_at) < now() - p_late) x
$$;

REVOKE ALL ON FUNCTION public.store_backup_dirty_owners(interval, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_gaps(interval, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_backup_gap_counts(interval) FROM PUBLIC, anon, authenticated;

COMMIT;
