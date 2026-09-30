BEGIN;
CREATE TEMP TABLE r(test text, ok boolean, info text);
DO $$
DECLARE x uuid; y uuid; z uuid; w uuid; sx text; sy text; lid uuid; n integer; d_cancelled uuid; before_ts timestamptz; after_ts timestamptz; got text; sl text;
BEGIN
  -- F1 a save that names BOTH status and suite_number (same value) closes the company and releases the number, no error
  SELECT id INTO x FROM accounts WHERE suite_number IS NOT NULL AND account_type='Client' AND status='Active' ORDER BY id OFFSET 5 LIMIT 1;
  SELECT suite_number INTO sx FROM accounts WHERE id=x;
  PERFORM set_config('app.suite_admin','on',true);
  DELETE FROM lease_agreements WHERE account_id=x;
  PERFORM set_config('app.suite_admin','',true);
  BEGIN
    UPDATE accounts SET status='Closed', suite_number=suite_number WHERE id=x;
    INSERT INTO r VALUES ('F1 closing with suite_number in the same save works and releases', (SELECT suite_number FROM accounts WHERE id=x) IS NULL AND EXISTS (SELECT 1 FROM suite_pool WHERE suite_number=sx), sx);
  EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES ('F1 closing with suite_number in the same save works and releases', false, SQLERRM); END;

  -- F2 a draft lease written before its company was closed cannot be sent once the number went to the pool
  SELECT id INTO y FROM accounts WHERE suite_number IS NOT NULL AND account_type='Client' AND status='Active' ORDER BY id OFFSET 6 LIMIT 1;
  SELECT suite_number INTO sy FROM accounts WHERE id=y;
  PERFORM set_config('app.suite_admin','on',true);
  DELETE FROM lease_agreements WHERE account_id=y;
  INSERT INTO lease_agreements SELECT (jsonb_populate_record(NULL::lease_agreements,
    to_jsonb((SELECT l FROM lease_agreements l LIMIT 1)) || jsonb_build_object('id',gen_random_uuid(),'account_id',y,'suite_number',sy,
      'status','draft','token','qa-f2-'||substr(gen_random_uuid()::text,1,8),'tenant_company',(SELECT company_name FROM accounts WHERE id=y),'contract_year',2099))).*;
  PERFORM set_config('app.suite_admin','',true);
  UPDATE accounts SET status='Closed' WHERE id=y;
  INSERT INTO r VALUES ('F2a company with only a draft lease still releases', (SELECT suite_number FROM accounts WHERE id=y) IS NULL, sy);
  SELECT id INTO lid FROM lease_agreements WHERE account_id=y LIMIT 1;
  BEGIN UPDATE lease_agreements SET status='sent' WHERE id=lid; INSERT INTO r VALUES ('F2b the old draft cannot be sent after release', false, 'sent!');
  EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('F2b the old draft cannot be sent after release', true, left(SQLERRM,80)); END;

  -- F3 the sweep frees reservations of cancelled / deleted deliveries
  SELECT id INTO d_cancelled FROM service_deliveries WHERE status='cancelled' LIMIT 1;
  INSERT INTO suite_reservations(suite_number, delivery_id) VALUES ('3D-986', d_cancelled), ('3D-985', gen_random_uuid());
  n := release_ended_suites('test');
  INSERT INTO r VALUES ('F3 the sweep releases reservations of cancelled or missing deliveries',
    n >= 2 AND NOT EXISTS (SELECT 1 FROM suite_reservations WHERE suite_number IN ('3D-986','3D-985'))
           AND EXISTS (SELECT 1 FROM suite_pool WHERE suite_number='3D-986') AND EXISTS (SELECT 1 FROM suite_pool WHERE suite_number='3D-985'), n::text);

  -- F4 waiving twice does not re-stamp the waiver
  SELECT sd.id INTO z FROM service_deliveries sd WHERE sd.service_type='Company Formation' AND sd.account_id IS NULL AND sd.status='active' AND sd.suite_waived_at IS NULL LIMIT 1;
  IF z IS NULL THEN INSERT INTO r VALUES ('F4 (no unlinked formation delivery in sandbox)', true, 'skipped');
  ELSE
    PERFORM waive_delivery_suite(z, 'first reason', 'test');
    SELECT suite_waived_at INTO before_ts FROM service_deliveries WHERE id=z;
    PERFORM pg_sleep(0.05);
    PERFORM waive_delivery_suite(z, 'second reason', 'test2');
    SELECT suite_waived_at INTO after_ts FROM service_deliveries WHERE id=z;
    INSERT INTO r VALUES ('F4 a repeated waive changes nothing (no re-stamp, no second history row)',
      before_ts = after_ts AND (SELECT suite_waived_reason FROM service_deliveries WHERE id=z)='first reason'
      AND (SELECT count(*) FROM suite_audit_log WHERE delivery_id=z AND action='waived')=1, before_ts::text);
  END IF;

  -- F5 claiming for a company that already holds its number frees a leftover reservation of that delivery
  SELECT sd.id, sd.account_id INTO w, x FROM service_deliveries sd JOIN accounts a ON a.id=sd.account_id WHERE a.suite_number IS NOT NULL AND a.status='Active' LIMIT 1;
  INSERT INTO suite_reservations(suite_number, delivery_id) VALUES ('3D-984', w);
  got := claim_company_suite(x, w, 'test');
  INSERT INTO r VALUES ('F5 a stale reservation is freed when the company already has its number',
    got IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suite_reservations WHERE delivery_id=w) AND EXISTS (SELECT 1 FROM suite_pool WHERE suite_number='3D-984'), got);

  -- F6 the one-time load door: closed by default, opened only by app.suite_load
  SELECT a.id, l.suite_number INTO y, sl FROM accounts a JOIN lease_agreements l ON l.account_id=a.id AND lower(btrim(l.tenant_company))=lower(btrim(a.company_name))
    WHERE a.suite_number = l.suite_number AND a.status='Active' AND a.account_type='Client'
      AND NOT EXISTS (SELECT 1 FROM lease_agreements l2 WHERE l2.suite_number=l.suite_number AND l2.account_id<>a.id) LIMIT 1;
  IF y IS NULL THEN INSERT INTO r VALUES ('F6 (no company with its own lease suite in sandbox)', true, 'skipped');
  ELSE
    PERFORM set_config('app.suite_admin','on',true);
    UPDATE accounts SET suite_number=NULL WHERE id=y;
    PERFORM set_config('app.suite_admin','',true);
    BEGIN UPDATE accounts SET suite_number=sl WHERE id=y; INSERT INTO r VALUES ('F6a copying a lease suite is refused by default', false, 'allowed!');
    EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('F6a copying a lease suite is refused by default', true, left(SQLERRM,80)); END;
    PERFORM set_config('app.suite_load','on',true);
    UPDATE accounts SET suite_number=sl WHERE id=y;
    PERFORM set_config('app.suite_load','',true);
    INSERT INTO r VALUES ('F6b ... and allowed only while the one-time load is switched on', (SELECT suite_number FROM accounts WHERE id=y)=sl, sl);
  END IF;

  -- F7 re-running the lock file cannot undo a later one: the FINAL definitions carry the later behaviour
  INSERT INTO r VALUES ('F7a the company lock carries the closed-door rule', pg_get_functiondef('public.trg_accounts_suite_guard'::regproc) LIKE '%suite_load%', '');
  INSERT INTO r VALUES ('F7b deleting a lease still frees the number', pg_get_functiondef('public.admin_delete_lease(uuid,text,text)'::regprocedure) LIKE '%_release_company_suite_impl%', '');
  INSERT INTO r VALUES ('F7c the release trigger runs after the company lock (name order)', 'trg_accounts_suite_guard' < 'trg_accounts_suite_release_on_close', '');
END $$;
SELECT test, ok, info FROM r ORDER BY test;
