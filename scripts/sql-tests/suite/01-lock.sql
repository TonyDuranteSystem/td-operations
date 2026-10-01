BEGIN;
CREATE TEMP TABLE r(test text, ok boolean, info text);
DO $$
DECLARE a1 uuid; a2 uuid; a3 uuid; s1 text; s2 text; s3 text; d uuid := gen_random_uuid(); r1 text; r2 text; lid uuid; lsuite text; j jsonb; mx int;
BEGIN
  SELECT id INTO a1 FROM accounts WHERE suite_number IS NULL AND status='Active' AND account_type='Client' ORDER BY id LIMIT 1;
  SELECT id INTO a2 FROM accounts WHERE suite_number IS NULL AND status='Active' AND account_type='Client' ORDER BY id OFFSET 1 LIMIT 1;
  SELECT id INTO a3 FROM accounts WHERE suite_number IS NULL AND status='Active' AND account_type='Client' ORDER BY id OFFSET 2 LIMIT 1;

  SELECT max(td_suite_num(suite_number)) INTO mx FROM accounts;
  s1 := allocate_company_suite(a1, NULL, 'test');
  INSERT INTO r VALUES ('T1 allocator puts suite on company', (SELECT suite_number FROM accounts WHERE id=a1) = s1, s1);
  INSERT INTO r VALUES ('T1b new number is above all existing', td_suite_num(s1) > COALESCE(mx,100), s1||' vs max '||COALESCE(mx,0));
  INSERT INTO r VALUES ('T2 allocator is idempotent', allocate_company_suite(a1, NULL, 'test') = s1, s1);
  s2 := allocate_company_suite(a2, NULL, 'test');
  INSERT INTO r VALUES ('T3 second company gets the next number', td_suite_num(s2) = td_suite_num(s1)+1, s1||' -> '||s2);

  BEGIN UPDATE accounts SET suite_number='3D-999' WHERE id=a1; INSERT INTO r VALUES ('T4 cannot change a locked suite', false, 'changed!');
  EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('T4 cannot change a locked suite', true, left(SQLERRM,80)); END;
  BEGIN UPDATE accounts SET suite_number=NULL WHERE id=a1; INSERT INTO r VALUES ('T5 cannot remove a locked suite', false, 'removed!');
  EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('T5 cannot remove a locked suite', true, left(SQLERRM,80)); END;
  BEGIN UPDATE accounts SET suite_number='3D-777' WHERE id=a3; INSERT INTO r VALUES ('T6 cannot invent a number by hand', false, 'invented!');
  EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('T6 cannot invent a number by hand', true, left(SQLERRM,80)); END;
  BEGIN UPDATE accounts SET suite_number=s1 WHERE id=a3; INSERT INTO r VALUES ('T6b two companies cannot share a suite', false, 'shared!');
  EXCEPTION WHEN check_violation OR unique_violation THEN INSERT INTO r VALUES ('T6b two companies cannot share a suite', true, left(SQLERRM,80)); END;
  BEGIN UPDATE accounts SET suite_number='318' WHERE id=a3; INSERT INTO r VALUES ('T6c bad format refused', false, 'accepted!');
  EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('T6c bad format refused', true, left(SQLERRM,80)); END;

  -- reservation before the company exists
  r1 := allocate_company_suite(NULL, d, 'test');
  r2 := allocate_company_suite(NULL, d, 'test');
  INSERT INTO r VALUES ('T7 reservation is stable per delivery', r1 = r2 AND td_suite_num(r1) = td_suite_num(s2)+1, r1||' / '||r2);
  s3 := allocate_company_suite(a3, d, 'test');
  INSERT INTO r VALUES ('T8 reservation moves onto the company', s3 = r1 AND (SELECT suite_number FROM accounts WHERE id=a3)=r1 AND NOT EXISTS (SELECT 1 FROM suite_reservations WHERE delivery_id=d), s3);
  d := gen_random_uuid();
  r1 := allocate_company_suite(NULL, d, 'test');
  PERFORM release_suite_reservation(d, 'test');
  r2 := allocate_company_suite(NULL, gen_random_uuid(), 'test');
  INSERT INTO r VALUES ('T9 a released reservation goes back to the pool and is handed out next', r2 = r1, r1||' released, next '||r2);

  j := admin_change_company_suite(a2, NULL, 'test release', 'test');
  INSERT INTO r VALUES ('T10 admin can release with a reason', (SELECT suite_number FROM accounts WHERE id=a2) IS NULL, j::text);
  BEGIN PERFORM admin_change_company_suite(a1, '3D-998', '', 'test'); INSERT INTO r VALUES ('T11 admin change needs a reason', false, 'no reason accepted');
  EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES ('T11 admin change needs a reason', true, left(SQLERRM,60)); END;

  -- leases: use a real signed lease whose suite equals its company's suite
  SELECT l.id, l.suite_number INTO lid, lsuite FROM lease_agreements l JOIN accounts a ON a.id=l.account_id AND a.suite_number=l.suite_number WHERE l.status='signed' LIMIT 1;
  IF lid IS NULL THEN INSERT INTO r VALUES ('T12 (no matching signed lease in sandbox)', true, 'skipped');
  ELSE
    BEGIN UPDATE lease_agreements SET suite_number='3D-997' WHERE id=lid; INSERT INTO r VALUES ('T12 signed lease suite cannot change', false, 'changed!');
    EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('T12 signed lease suite cannot change', true, left(SQLERRM,80)); END;
    BEGIN UPDATE lease_agreements SET tenant_company='Some Person' WHERE id=lid; INSERT INTO r VALUES ('T13 tenant cannot be a person', false, 'changed!');
    EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('T13 tenant cannot be a person', true, left(SQLERRM,80)); END;
    BEGIN DELETE FROM lease_agreements WHERE id=lid; INSERT INTO r VALUES ('T14 signed lease cannot be deleted directly', false, 'deleted!');
    EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('T14 signed lease cannot be deleted directly', true, left(SQLERRM,80)); END;
    j := admin_delete_lease(lid, 'test', 'test');
    INSERT INTO r VALUES ('T15 admin delete works and logs a copy', NOT EXISTS (SELECT 1 FROM lease_agreements WHERE id=lid) AND EXISTS (SELECT 1 FROM suite_audit_log WHERE action='lease_deleted' AND account_id=(j->>'account_id')::uuid), j::text);
  END IF;
END $$;
SELECT test, ok, info FROM r ORDER BY test;
