-- Read-only SQL executor for the Hermes operating-agent (crm_query tool).
-- Postgres-ENFORCED read-only — defense in depth on top of the app-layer
-- validateSQL() rejection:
--   * credential/token tables are refused outright (Hermes never reads secrets).
--   * SET LOCAL transaction_read_only = on  → ANY write (INSERT/UPDATE/DELETE/
--     DDL, even via data-modifying CTE) raises, regardless of role.
--   * the sub-SELECT wrap forces the input to be a SELECT (a write here is a
--     syntax error).
--   * statement_timeout caps runtime; LIMIT 500 caps rows.
-- Returns a json array of rows, or {error, sqlstate} on any failure.
-- SANDBOX FIRST (ref xjcxlmlpeywtwkhstjlw). Promote to production only with
-- explicit approval.

CREATE OR REPLACE FUNCTION exec_sql_readonly(sql_query text)
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  result json;
BEGIN
  -- Credential/token tables are never readable by the agent.
  IF lower(sql_query) ~ '\y(hc_tokens|oauth_clients|oauth_codes|oauth_tokens|oauth_users|portal_welcome_tokens|qb_tokens)\y' THEN
    RETURN json_build_object('error', 'Access to credential/token tables is not permitted.');
  END IF;

  EXECUTE 'SET LOCAL transaction_read_only = on';
  EXECUTE 'SET LOCAL statement_timeout = ''8000ms''';
  EXECUTE 'SELECT coalesce(json_agg(t), ''[]''::json) FROM '
       || '(SELECT * FROM (' || sql_query || ') _hermes_inner LIMIT 500) t'
    INTO result;
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;
