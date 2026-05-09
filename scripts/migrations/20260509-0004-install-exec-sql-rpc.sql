-- 20260509-0004-install-exec-sql-rpc.sql
-- Installs the exec_sql RPC in sandbox so the sandbox MCP execute_sql tool
-- works the same way it works in production.
--
-- Background: production has a SECURITY DEFINER function public.exec_sql(text)
-- that PostgREST exposes as the RPC backing mcp__td-ops-sandbox__execute_sql.
-- It was created manually in production and never captured as a migration, so
-- sandbox was provisioned without it. PostgREST returns PGRST202
-- ("Could not find the function public.exec_sql") for every MCP SQL call in
-- sandbox.
--
-- Source captured verbatim from production via pg_get_functiondef on
-- 2026-05-08. Owner: postgres. Grants: EXECUTE to postgres + service_role
-- (matches production exactly; postgres is the implicit owner).

CREATE OR REPLACE FUNCTION public.exec_sql(sql_query text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  result json;
  trimmed text;
  is_mutation boolean;
BEGIN
  trimmed := upper(trim(sql_query));
  is_mutation := trimmed LIKE 'INSERT%' OR trimmed LIKE 'UPDATE%' OR trimmed LIKE 'DELETE%' OR trimmed LIKE 'WITH%'
    OR trimmed LIKE 'CREATE%' OR trimmed LIKE 'ALTER%';

  IF is_mutation THEN
    BEGIN
      EXECUTE 'SELECT coalesce(json_agg(row_to_json(t)), ''[]''::json) FROM (' || sql_query || ') t'
        INTO result;
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        EXECUTE sql_query;
        RETURN json_build_object('success', true, 'message', 'Mutation executed successfully');
      EXCEPTION WHEN OTHERS THEN
        RETURN json_build_object('error', SQLERRM, 'detail', SQLSTATE);
      END;
    END;
  ELSE
    EXECUTE 'SELECT coalesce(json_agg(row_to_json(t)), ''[]''::json) FROM (' || sql_query || ') t'
      INTO result;
    RETURN result;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('error', SQLERRM, 'detail', SQLSTATE);
END;
$function$;

REVOKE ALL ON FUNCTION public.exec_sql(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;

NOTIFY pgrst, 'reload schema';
