-- =======================================================================
-- Step 5 observability for tax_returns (R093 follow-up to Titan TR incident)
--
-- PROBLEM
--   tax_returns.data_received was flipped to true for TITAN REAL ESTATE (row
--   5b18dfd4) with no matching tax_return_submissions row and no
--   data_received_date. No entry in action_log -> silent drift. Client
--   emailed support 2026-04-18 + 2026-04-21 asking basic tax-liability
--   questions; we thought data was in.
--
-- WHY A DB TRIGGER (not just an MCP wrapper)
--   action_log is populated ONLY by the application path (lib/mcp/action-log.ts)
--   through MCP tools (crm_update_record, execute_sql, ...). Any write from
--   outside that path (Supabase Studio, psql, seed scripts, Edge Functions,
--   future cron jobs, or code that forgets to call logAction) bypasses
--   logging entirely. A DB-level trigger makes audit coverage universal.
--
-- SCOPE
--   Only the workflow-critical columns are audited to avoid noise:
--     link_sent, data_received, sent_to_india, extension_filed, status,
--     paid, deal_created. Timestamp twins (link_sent_date, ...) are implicit.
--
-- CONSISTENCY VIEW
--   v_tax_return_data_received_anomalies surfaces rows where data_received
--   contradicts the evidence (no submission row, no upload, null
--   data_received_date). Intended for a weekly cron / audit dashboard.
-- =======================================================================

-- 1. Trigger function -----------------------------------------------------
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
    -- Log insert with the interesting columns
    v_details := jsonb_build_object(
      'op',            'insert',
      'account_id',    NEW.account_id,
      'tax_year',      NEW.tax_year,
      'return_type',   NEW.return_type,
      'status',        NEW.status,
      'data_received', NEW.data_received,
      'link_sent',     NEW.link_sent,
      'sent_to_india', NEW.sent_to_india,
      'extension_filed', NEW.extension_filed,
      'paid',          NEW.paid,
      'db_user',       session_user
    );
    v_summary := format('tax_returns INSERT (year=%s, status=%s)', NEW.tax_year, NEW.status);

    INSERT INTO public.action_log
      (actor, action_type, table_name, record_id, account_id, summary, details)
    VALUES
      ('db-trigger', 'insert', 'tax_returns', NEW.id, NEW.account_id, v_summary, v_details);

    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Compare each watched field, record only changes
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
    IF NEW.sent_to_india IS DISTINCT FROM OLD.sent_to_india THEN
      v_changed := array_append(v_changed, 'sent_to_india');
      v_old := v_old || jsonb_build_object('sent_to_india', OLD.sent_to_india);
      v_new := v_new || jsonb_build_object('sent_to_india', NEW.sent_to_india);
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

    -- Nothing interesting changed — do not log
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

-- 2. Triggers -------------------------------------------------------------
DROP TRIGGER IF EXISTS tax_returns_audit_iud ON public.tax_returns;
CREATE TRIGGER tax_returns_audit_iud
AFTER INSERT OR UPDATE OR DELETE ON public.tax_returns
FOR EACH ROW
EXECUTE FUNCTION public.trg_tax_returns_audit();

-- 3. Consistency view -----------------------------------------------------
-- Rows where data_received=true is not supported by evidence:
--   - no tax_return_submissions row OR no submitted_data, AND
--   - no data_received_date stamped
-- Worth triaging before the next client touches the preparer.
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
  tr.sent_to_india,
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

-- End ---------------------------------------------------------------------
