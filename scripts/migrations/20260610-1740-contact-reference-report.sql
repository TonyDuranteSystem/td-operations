-- Contact delete/merge support: a function that reports how many references a
-- contact has across EVERY FK column that points at contacts.id. Counts ALL of
-- them regardless of delete rule (CASCADE/SET NULL/NO ACTION) on purpose: a
-- contact is only treated as a safely hard-deletable "orphan" when it has ZERO
-- references anywhere. Anything else (even a CASCADE company-membership link)
-- must go through MERGE, which is non-destructive. This avoids the footgun where
-- a CASCADE FK (e.g. account_contacts in production) would let a hard delete
-- silently unlink a real client. Mirrors merge_contacts()'s dynamic
-- information_schema walk so it auto-covers every current and future FK.
--
-- Used by /api/crm/admin-actions/delete-contact: total_blocking 0 => safe hard
-- delete (a true orphan, e.g. the Michele Cotti duplicate); >0 => MERGE required.

CREATE OR REPLACE FUNCTION public.contact_reference_report(p_contact_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_fk        record;
  v_count     bigint;
  v_total     bigint := 0;
  v_breakdown jsonb := '{}'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = p_contact_id) THEN
    RAISE EXCEPTION 'contact_reference_report: contact % not found', p_contact_id;
  END IF;

  FOR v_fk IN
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'contacts' AND ccu.column_name = 'id'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', v_fk.table_name, v_fk.column_name)
      INTO v_count USING p_contact_id;
    IF v_count > 0 THEN
      v_breakdown := v_breakdown || jsonb_build_object(v_fk.table_name || '.' || v_fk.column_name, v_count);
      v_total := v_total + v_count;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('total_blocking', v_total, 'breakdown', v_breakdown);
END;
$function$;
