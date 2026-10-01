BEGIN;
CREATE TEMP TABLE r(test text, ok boolean, info text);
DO $$
DECLARE a uuid; b uuid; c uuid; d uuid; e uuid; sa text; sb text; sc text; sd text; n integer; got text; oldest text; newer text; x jsonb; lid uuid;
BEGIN
  SELECT id INTO a FROM (SELECT id FROM accounts WHERE suite_number IS NOT NULL AND account_type='Client' AND status='Active' AND EXISTS (SELECT 1 FROM lease_agreements l WHERE l.account_id = accounts.id AND l.suite_number = accounts.suite_number) ORDER BY id) t OFFSET 0 LIMIT 1;
  SELECT id INTO b FROM (SELECT id FROM accounts WHERE suite_number IS NOT NULL AND account_type='Client' AND status='Active' AND EXISTS (SELECT 1 FROM lease_agreements l WHERE l.account_id = accounts.id AND l.suite_number = accounts.suite_number) ORDER BY id) t OFFSET 1 LIMIT 1;
  SELECT id INTO c FROM (SELECT id FROM accounts WHERE suite_number IS NOT NULL AND account_type='Client' AND status='Active' AND EXISTS (SELECT 1 FROM lease_agreements l WHERE l.account_id = accounts.id AND l.suite_number = accounts.suite_number) ORDER BY id) t OFFSET 2 LIMIT 1;
  SELECT id INTO d FROM (SELECT id FROM accounts WHERE suite_number IS NOT NULL AND account_type='Client' AND status='Active' AND EXISTS (SELECT 1 FROM lease_agreements l WHERE l.account_id = accounts.id AND l.suite_number = accounts.suite_number) ORDER BY id) t OFFSET 3 LIMIT 1;
  SELECT suite_number INTO sa FROM accounts WHERE id=a; SELECT suite_number INTO sb FROM accounts WHERE id=b; SELECT suite_number INTO sc FROM accounts WHERE id=c; SELECT suite_number INTO sd FROM accounts WHERE id=d;

  -- A: no lease in force -> released the moment it is Closed
  PERFORM set_config('app.suite_admin','on',true);
  DELETE FROM lease_agreements WHERE account_id=a;
  PERFORM set_config('app.suite_admin','',true);
  UPDATE accounts SET status='Closed' WHERE id=a;
  INSERT INTO r VALUES ('R1 a closed company with no lease in force releases its suite at once', (SELECT suite_number FROM accounts WHERE id=a) IS NULL AND EXISTS (SELECT 1 FROM suite_pool WHERE suite_number=sa AND released_from_account=a) AND EXISTS (SELECT 1 FROM suite_audit_log WHERE action='released_to_pool' AND account_id=a), sa);

  -- B: a signed lease still in force -> NOT released
  PERFORM set_config('app.suite_admin','on',true);
  UPDATE lease_agreements SET status='signed', term_end_date = current_date + 30 WHERE account_id=b;
  PERFORM set_config('app.suite_admin','',true);
  UPDATE accounts SET status='Closed' WHERE id=b;
  INSERT INTO r VALUES ('R2 a closed company whose lease is still in force KEEPS its suite', (SELECT suite_number FROM accounts WHERE id=b)=sb AND NOT EXISTS (SELECT 1 FROM suite_pool WHERE suite_number=sb), sb);

  -- R3/R4: the lease ends later -> the daily sweep releases it
  PERFORM set_config('app.suite_admin','on',true);
  UPDATE lease_agreements SET term_end_date = current_date - 1 WHERE account_id=b;
  PERFORM set_config('app.suite_admin','',true);
  n := release_ended_suites('test');
  INSERT INTO r VALUES ('R3 the sweep releases it once the lease term has ended', n >= 1 AND (SELECT suite_number FROM accounts WHERE id=b) IS NULL AND EXISTS (SELECT 1 FROM suite_pool WHERE suite_number=sb), n::text);

  -- C: temporary states never release
  PERFORM set_config('app.suite_admin','on',true);
  DELETE FROM lease_agreements WHERE account_id=c;
  PERFORM set_config('app.suite_admin','',true);
  UPDATE accounts SET status='Suspended' WHERE id=c;
  UPDATE accounts SET status='Offboarding' WHERE id=c;
  UPDATE accounts SET status='Delinquent' WHERE id=c;
  INSERT INTO r VALUES ('R4 Suspended / Offboarding / Delinquent never release the suite', (SELECT suite_number FROM accounts WHERE id=c)=sc, sc);
  n := release_ended_suites('test');
  INSERT INTO r VALUES ('R5 the sweep does not touch them either', (SELECT suite_number FROM accounts WHERE id=c)=sc, sc);

  -- D: closed with a lease in force; deleting that lease (owner action) frees it at once
  PERFORM set_config('app.suite_admin','on',true);
  UPDATE lease_agreements SET status='signed', term_end_date = current_date + 60 WHERE account_id=d;
  PERFORM set_config('app.suite_admin','',true);
  UPDATE accounts SET status='Closed' WHERE id=d;
  SELECT l.id INTO lid FROM lease_agreements l WHERE l.account_id=d LIMIT 1;
  WHILE lid IS NOT NULL LOOP
    x := admin_delete_lease(lid, 'test', 'test');
    SELECT l.id INTO lid FROM lease_agreements l WHERE l.account_id=d LIMIT 1;
  END LOOP;
  INSERT INTO r VALUES ('R6 deleting the last lease of a closed company frees its suite at once', (SELECT suite_number FROM accounts WHERE id=d) IS NULL AND EXISTS (SELECT 1 FROM suite_pool WHERE suite_number=sd), sd);

  -- oldest released number goes first
  UPDATE suite_pool SET released_at = now() - interval '5 days' WHERE suite_number = sa;
  UPDATE suite_pool SET released_at = now() - interval '1 day' WHERE suite_number = sb;
  UPDATE suite_pool SET released_at = now() WHERE suite_number = sd;
  SELECT suite_number INTO e FROM accounts WHERE false;  -- no-op
  got := allocate_company_suite((SELECT id FROM accounts WHERE suite_number IS NULL AND account_type='Client' AND status='Active' AND id NOT IN (a,b,c,d) LIMIT 1), NULL, 'test');
  INSERT INTO r VALUES ('R7 the next new company gets the OLDEST released number first', got = sa, sa||' expected, got '||got);
  INSERT INTO r VALUES ('R8 a number taken from the pool leaves the pool', NOT EXISTS (SELECT 1 FROM suite_pool WHERE suite_number=sa), '');

  -- a pool number can also be placed by hand (history check skips the pool)
  BEGIN
    PERFORM assign_specific_company_suite((SELECT id FROM accounts WHERE suite_number IS NULL AND account_type='Client' AND status='Active' AND id NOT IN (a,b,c,d) LIMIT 1), sb, 'test');
    INSERT INTO r VALUES ('R9 a released number can be placed on another company by hand', true, sb);
    INSERT INTO r VALUES ('R9b ... and then it is no longer in the pool', NOT EXISTS (SELECT 1 FROM suite_pool WHERE suite_number = sb), sb);
  EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES ('R9 a released number can be placed on another company by hand', false, SQLERRM); END;

  -- a reserved-then-cancelled number goes back to the pool
  got := allocate_company_suite(NULL, gen_random_uuid(), 'test');
  x := to_jsonb(got);
  INSERT INTO r VALUES ('R10 a number held by a company is never handed out again (not from the pool either)', got <> sb AND NOT EXISTS (SELECT 1 FROM suite_pool WHERE suite_number = got), got||' (placed by hand earlier: '||sb||')');
  PERFORM release_suite_reservation((SELECT delivery_id FROM suite_reservations WHERE suite_number=got), 'test');
  INSERT INTO r VALUES ('R11 releasing a reservation puts the number back in the pool', EXISTS (SELECT 1 FROM suite_pool WHERE suite_number = got), got);

  -- reactivated company (Closed -> Active, suite gone): Issue suite gives it a number, no error
  BEGIN
    UPDATE accounts SET status='Active' WHERE id=a;
    got := allocate_company_suite(a, NULL, 'test');
    INSERT INTO r VALUES ('R12 a reactivated company can be issued a suite again', got IS NOT NULL AND got <> sa, got);
  EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES ('R12 a reactivated company can be issued a suite again', false, SQLERRM); END;
  -- a STALE pool row (number already held) is dropped and never handed out
  INSERT INTO suite_pool (suite_number, released_at, reason) VALUES (sc, now() - interval '30 days', 'stale test') ON CONFLICT DO NOTHING;
  got := allocate_company_suite((SELECT id FROM accounts WHERE suite_number IS NULL AND account_type='Client' AND status='Active' AND id NOT IN (a,b,c,d) LIMIT 1), NULL, 'test');
  INSERT INTO r VALUES ('R13 a stale pool row for a held number is never handed out, and is removed', got <> sc AND NOT EXISTS (SELECT 1 FROM suite_pool WHERE suite_number = sc), got||' vs held '||sc);
END $$;
SELECT test, ok, info FROM r ORDER BY test;
