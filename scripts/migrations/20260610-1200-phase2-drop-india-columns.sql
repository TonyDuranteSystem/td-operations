-- Phase 2: Drop legacy india_* columns from tax_returns
-- Companion to 20260609-rename-sent-to-india.sql (Phase 1).
--
-- Phase 1 added the new accountant_* columns alongside the old india_* ones,
-- copied the data, and cut over all code. Phase 2 drops the legacy columns now
-- that no code path reads or writes them.
--
-- Columns dropped:
--   india_status           (USER-DEFINED / india_status enum)
--   sent_to_india          (boolean)
--   sent_to_india_date     (date)
--   india_follow_up_count  (integer)
--
-- Enum dropped:
--   india_status  (values: Not Sent, Sent - Pending, In Progress, Completed, Filed)
--   (accountant_status enum carries the same values and is kept)
--
-- Trigger updated:
--   trg_tax_returns_audit watches sent_to_india → switch to sent_to_accountant
--
-- Consistency view updated:
--   v_tax_return_data_received_anomalies projected sent_to_india → drop that column

-- 1. Drop view that references sent_to_india (must precede column drop) ------
DROP VIEW IF EXISTS public.v_tax_return_data_received_anomalies;

-- 2. Drop legacy columns -----------------------------------------------------
ALTER TABLE public.tax_returns
  DROP COLUMN IF EXISTS india_status,
  DROP COLUMN IF EXISTS sent_to_india,
  DROP COLUMN IF EXISTS sent_to_india_date,
  DROP COLUMN IF EXISTS india_follow_up_count;

-- 3. Drop legacy enum --------------------------------------------------------
DROP TYPE IF EXISTS public.india_status;

-- 4. Recreate trigger function watching sent_to_accountant instead of sent_to_india
CREATE OR REPLACE FUNCTION public.trg_tax_returns_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed text[] := ARRAY[]::text[];
  v_old     jsonb  := '{}'::jsonb;
  v_new     jsonb  := '{}'::jsonb;
  v_details jsonb;
  v_summary text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_details := jsonb_build_object(
      'op',                 'insert',
      'account_id',         NEW.account_id,
      'tax_year',           NEW.tax_year,
      'return_type',        NEW.return_type,
      'status',             NEW.status,
      'data_received',      NEW.data_received,
      'link_sent',          NEW.link_sent,
      'sent_to_accountant', NEW.sent_to_accountant,
      'extension_filed',    NEW.extension_filed,
      'paid',               NEW.paid,
      'db_user',            session_user
    );
    v_summary := format('tax_returns INSERT (year=%s, status=%s)', NEW.tax_year, NEW.status);

    INSERT INTO public.action_log
      (actor, action_type, table_name, record_id, account_id, summary, details)
    VALUES
      ('db-trigger', 'insert', 'tax_returns', NEW.id, NEW.account_id, v_summary, v_details);

    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.link_sent IS DISTINCT FROM OLD.link_sent THEN
      v_changed := array_append(v_changed, 'link_sent');
      v_old := v_old || jsonb_build_object('link_sent', OLD.link_sent);
      v_new := v_new || jsonb_build_object('link_sent', NEW.link_sent);
    END IF;
    IF NEW.data_received IS DISTINCT FROM OLD.data_received THEN
      v_changed := array_append(v_changed, 'data_received');
      v_old := v_old || jsonb_build_object('data_received', OLD.data_received);
      v_new := v_new || jsonb_build_object('data_received', NEW.data_received);
    END IF;
    IF NEW.sent_to_accountant IS DISTINCT FROM OLD.sent_to_accountant THEN
      v_changed := array_append(v_changed, 'sent_to_accountant');
      v_old := v_old || jsonb_build_object('sent_to_accountant', OLD.sent_to_accountant);
      v_new := v_new || jsonb_build_object('sent_to_accountant', NEW.sent_to_accountant);
    END IF;
    IF NEW.extension_filed IS DISTINCT FROM OLD.extension_filed THEN
      v_changed := array_append(v_changed, 'extension_filed');
      v_old := v_old || jsonb_build_object('extension_filed', OLD.extension_filed);
      v_new := v_new || jsonb_build_object('extension_filed', NEW.extension_filed);
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      v_changed := array_append(v_changed, 'status');
      v_old := v_old || jsonb_build_object('status', OLD.status);
      v_new := v_new || jsonb_build_object('status', NEW.status);
    END IF;
    IF NEW.paid IS DISTINCT FROM OLD.paid THEN
      v_changed := array_append(v_changed, 'paid');
      v_old := v_old || jsonb_build_object('paid', OLD.paid);
      v_new := v_new || jsonb_build_object('paid', NEW.paid);
    END IF;
    IF NEW.deal_created IS DISTINCT FROM OLD.deal_created THEN
      v_changed := array_append(v_changed, 'deal_created');
      v_old := v_old || jsonb_build_object('deal_created', OLD.deal_created);
      v_new := v_new || jsonb_build_object('deal_created', NEW.deal_created);
    END IF;

    IF array_length(v_changed, 1) IS NULL THEN
      RETURN NEW;
    END IF;

    v_details := jsonb_build_object(
      'op',             'update',
      'fields_changed', to_jsonb(v_changed),
      'old_values',     v_old,
      'new_values',     v_new,
      'tax_year',       NEW.tax_year,
      'db_user',        session_user
    );
    v_summary := format(
      'tax_returns UPDATE (year=%s): %s',
      NEW.tax_year,
      array_to_string(v_changed, ', ')
    );

    INSERT INTO public.action_log
      (actor, action_type, table_name, record_id, account_id, summary, details)
    VALUES
      ('db-trigger', 'update', 'tax_returns', NEW.id, NEW.account_id, v_summary, v_details);

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    v_details := jsonb_build_object(
      'op',            'delete',
      'account_id',    OLD.account_id,
      'tax_year',      OLD.tax_year,
      'status',        OLD.status,
      'data_received', OLD.data_received,
      'link_sent',     OLD.link_sent,
      'db_user',       session_user
    );
    v_summary := format('tax_returns DELETE (year=%s, status=%s)', OLD.tax_year, OLD.status);

    INSERT INTO public.action_log
      (actor, action_type, table_name, record_id, account_id, summary, details)
    VALUES
      ('db-trigger', 'delete', 'tax_returns', OLD.id, OLD.account_id, v_summary, v_details);

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

-- 5. Recreate consistency view (drop sent_to_india projection) ---------------
CREATE OR REPLACE VIEW public.v_tax_return_data_received_anomalies AS
SELECT
  tr.id                        AS tax_return_id,
  tr.account_id,
  a.company_name,
  tr.tax_year,
  tr.return_type,
  tr.status,
  tr.paid,
  tr.link_sent,
  tr.link_sent_date,
  tr.data_received,
  tr.data_received_date,
  tr.sent_to_accountant,
  tr.extension_filed,
  trs.id IS NOT NULL            AS has_submission_row,
  trs.submitted_data IS NOT NULL AS has_submitted_data,
  trs.completed_at              AS submission_completed_at,
  tr.updated_at                 AS tax_return_updated_at
FROM public.tax_returns tr
LEFT JOIN public.accounts a
  ON a.id = tr.account_id
LEFT JOIN public.tax_return_submissions trs
  ON trs.account_id = tr.account_id
 AND trs.tax_year   = tr.tax_year
WHERE tr.data_received = true
  AND (
       trs.id IS NULL
    OR trs.submitted_data IS NULL
    OR tr.data_received_date IS NULL
  );

COMMENT ON VIEW public.v_tax_return_data_received_anomalies IS
  'Rows where tax_returns.data_received=true but the evidence (tax_return_submissions row + submitted_data + data_received_date) does not support it. Use in weekly audit cron. See Titan Real Estate 2026-04-21 incident.';
