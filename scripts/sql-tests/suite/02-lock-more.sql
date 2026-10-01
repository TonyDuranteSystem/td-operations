BEGIN;
CREATE TEMP TABLE r(test text, ok boolean, info text);
DO $$
DECLARE a uuid; ls text; got text; sdid uuid; sdacc uuid; res text; a2 uuid; lid uuid; r1 text; d uuid := gen_random_uuid(); e text;
BEGIN
  -- T16 a company holding a suite on its OWN lease but none on the company ADOPTS it (never a second number)
  SELECT a0.id, l.suite_number INTO a, ls FROM accounts a0 JOIN lease_agreements l ON l.account_id=a0.id AND lower(btrim(l.tenant_company))=lower(btrim(a0.company_name))
    WHERE a0.suite_number = l.suite_number AND a0.account_type='Client' AND NOT EXISTS (SELECT 1 FROM lease_agreements l2 WHERE l2.suite_number=l.suite_number AND l2.account_id<>a0.id) LIMIT 1;
  PERFORM set_config('app.suite_admin','on',true);
  UPDATE accounts SET suite_number=NULL WHERE id=a;
  PERFORM set_config('app.suite_admin','',true);
  got := allocate_company_suite(a, NULL, 'test');
  INSERT INTO r VALUES ('T16 allocator adopts the company''s own lease suite', got = ls, ls||' -> '||got);

  -- T17 a retry that does not know the delivery still finds the reservation of the delivery linked to the company
  SELECT sd.id, sd.account_id INTO sdid, sdacc FROM service_deliveries sd JOIN accounts ac ON ac.id=sd.account_id
    WHERE sd.account_id IS NOT NULL AND ac.suite_number IS NOT NULL AND ac.id <> a LIMIT 1;
  PERFORM set_config('app.suite_admin','on',true);
  UPDATE accounts SET suite_number=NULL WHERE id=sdacc;
  INSERT INTO suite_reservations(suite_number, delivery_id) VALUES ('3D-987', sdid);
  PERFORM set_config('app.suite_admin','',true);
  got := allocate_company_suite(sdacc, NULL, 'test');
  INSERT INTO r VALUES ('T17 retry claims the reservation of the linked delivery', got='3D-987' AND NOT EXISTS (SELECT 1 FROM suite_reservations WHERE delivery_id=sdid), got);

  -- T18 a released number is never handed to another company (place client / admin change)
  r1 := allocate_company_suite(NULL, d, 'test');
  PERFORM release_suite_reservation(d,'test');
  SELECT id INTO a2 FROM accounts WHERE suite_number IS NULL AND account_type='Client' AND id NOT IN (a, sdacc) LIMIT 1;
  BEGIN PERFORM assign_specific_company_suite(a2, r1, 'test'); INSERT INTO r VALUES ('T18 a released reservation number (in the pool) CAN be placed on another company', true, r1);
  EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES ('T18 a released reservation number (in the pool) CAN be placed on another company', false, SQLERRM); END;

  -- T19 cannot take the suite off a company that still has leases
  SELECT a0.id INTO a2 FROM accounts a0 WHERE a0.suite_number IS NOT NULL AND EXISTS (SELECT 1 FROM lease_agreements l WHERE l.account_id=a0.id) LIMIT 1;
  BEGIN PERFORM admin_change_company_suite(a2, NULL, 'test', 'test'); INSERT INTO r VALUES ('T19 suite cannot be removed while leases exist', false, 'removed!');
  EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES ('T19 suite cannot be removed while leases exist', SQLERRM ILIKE '%lease%', left(SQLERRM,90)); END;

  -- T20 a sent/viewed lease cannot be stepped back to draft (would unlock deletion)
  SELECT id INTO lid FROM lease_agreements WHERE status IN ('viewed','sent') LIMIT 1;
  IF lid IS NULL THEN INSERT INTO r VALUES ('T20 (no viewed lease in sandbox)', true, 'skipped');
  ELSE BEGIN UPDATE lease_agreements SET status='draft' WHERE id=lid; INSERT INTO r VALUES ('T20 a viewed/sent lease cannot be reset to draft', false, 'reset!');
       EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('T20 a viewed/sent lease cannot be reset to draft', true, left(SQLERRM,80)); END;
  END IF;
  -- T21 normal status progression still works when the lease carries its company's own suite (draft -> sent)
  SELECT l.id INTO lid FROM lease_agreements l JOIN accounts ac ON ac.id=l.account_id AND ac.suite_number=l.suite_number WHERE l.status='draft' LIMIT 1;
  IF lid IS NULL THEN INSERT INTO r VALUES ('T21 (no draft lease carrying its company suite in sandbox)', true, 'skipped');
  ELSE
    UPDATE lease_agreements SET status='sent' WHERE id=lid;
    INSERT INTO r VALUES ('T21 ordinary status change (draft to sent) still works', (SELECT status FROM lease_agreements WHERE id=lid)='sent', '');
  END IF;
  -- T22 a draft whose company holds NO suite (waived / released / never issued) cannot be sent to the client
  SELECT l.id INTO lid FROM lease_agreements l JOIN accounts ac ON ac.id=l.account_id WHERE l.status='draft' AND ac.suite_number IS NULL LIMIT 1;
  IF lid IS NULL THEN INSERT INTO r VALUES ('T22 (no draft lease of a suite-less company in sandbox)', true, 'skipped');
  ELSE BEGIN UPDATE lease_agreements SET status='sent' WHERE id=lid; INSERT INTO r VALUES ('T22 a draft of a suite-less company cannot be sent', false, 'sent!');
       EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('T22 a draft of a suite-less company cannot be sent', true, left(SQLERRM,80)); END;
  END IF;
END $$;
SELECT test, ok, info FROM r ORDER BY test;
