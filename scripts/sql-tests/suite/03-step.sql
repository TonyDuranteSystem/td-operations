BEGIN;
CREATE TEMP TABLE r(test text, ok boolean, info text);
DO $$
DECLARE f uuid := gen_random_uuid(); o uuid := gen_random_uuid(); acct uuid; acct_suite uuid; s text; st jsonb; msg text; tmpl jsonb;
BEGIN
  SELECT to_jsonb(t) INTO tmpl FROM (SELECT * FROM service_deliveries LIMIT 1) t;
  -- a formation case at 'Wizard Submitted' (order 2), no company yet
  INSERT INTO service_deliveries SELECT (jsonb_populate_record(NULL::service_deliveries, tmpl || jsonb_build_object('id',f,'service_type','Company Formation','stage','Wizard Submitted','stage_order',2,'account_id',NULL,'status','active','is_test',false,'suite_waived_at',NULL))).*;
  st := suite_step_state(f);
  INSERT INTO r VALUES ('S1 a fresh case is NOT satisfied', (st->>'satisfied')::boolean = false, st::text);
  BEGIN UPDATE service_deliveries SET stage='Filed with State', stage_order=3 WHERE id=f; INSERT INTO r VALUES ('S2 cannot pass the gate without a decision', false, 'moved!');
  EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('S2 cannot pass the gate without a decision', true, left(SQLERRM,90)); END;
  BEGIN UPDATE service_deliveries SET stage='Articles Received', stage_order=4 WHERE id=f; INSERT INTO r VALUES ('S3 a forward JUMP cannot skip the gate', false, 'jumped!');
  EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('S3 a forward JUMP cannot skip the gate', true, 'blocked'); END;
  s := issue_delivery_suite(f, 'test');
  st := suite_step_state(f);
  INSERT INTO r VALUES ('S4 Issue reserves a suite on the delivery', (st->>'reserved_suite') = s AND (st->>'satisfied')::boolean, s);
  UPDATE service_deliveries SET stage='Filed with State', stage_order=3 WHERE id=f;
  INSERT INTO r VALUES ('S5 with a reservation the case can move on', (SELECT stage_order FROM service_deliveries WHERE id=f)=3, '');
  -- waiver path on another formation
  UPDATE service_deliveries SET stage='Wizard Submitted', stage_order=2 WHERE id=f;  -- step back is allowed (not a forward move)
  PERFORM waive_delivery_suite(f, 'one-time customer', 'test');
  st := suite_step_state(f);
  INSERT INTO r VALUES ('S6 waiving frees the reservation and records the reason', (st->>'waived')::boolean AND (st->>'reserved_suite') IS NULL AND (st->>'waived_reason')='one-time customer', st::text);
  UPDATE service_deliveries SET stage='Filed with State', stage_order=3 WHERE id=f;
  INSERT INTO r VALUES ('S7 a waived case can move on', (SELECT stage_order FROM service_deliveries WHERE id=f)=3, '');
  BEGIN PERFORM waive_delivery_suite(f, '  ', 'test'); INSERT INTO r VALUES ('S8 waiver needs a reason', false, 'accepted!');
  EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES ('S8 waiver needs a reason', SQLERRM ILIKE '%reason%', SQLERRM); END;
  s := issue_delivery_suite(f, 'test');
  INSERT INTO r VALUES ('S9 issuing after a waiver clears the waiver and reserves', (suite_step_state(f)->>'waived')::boolean = false AND (suite_step_state(f)->>'reserved_suite') = s, s);
  PERFORM unwaive_delivery_suite(f, 'test');

  -- onboarding case on an existing company without a suite
  SELECT id INTO acct FROM accounts WHERE suite_number IS NULL AND account_type='Client' LIMIT 1;
  INSERT INTO service_deliveries SELECT (jsonb_populate_record(NULL::service_deliveries, tmpl || jsonb_build_object('id',o,'service_type','Client Onboarding','stage','Review & CRM Setup','stage_order',2,'account_id',acct,'status','active','is_test',false,'suite_waived_at',NULL))).*;
  BEGIN UPDATE service_deliveries SET stage='Post-Review & Closing', stage_order=3 WHERE id=o; INSERT INTO r VALUES ('S10 onboarding cannot complete without the decision', false, 'moved!');
  EXCEPTION WHEN check_violation THEN INSERT INTO r VALUES ('S10 onboarding cannot complete without the decision', true, left(SQLERRM,90)); END;
  s := issue_delivery_suite(o, 'test');
  INSERT INTO r VALUES ('S11 onboarding Issue puts the suite straight on the company', (SELECT suite_number FROM accounts WHERE id=acct)=s, s);
  UPDATE service_deliveries SET stage='Post-Review & Closing', stage_order=3 WHERE id=o;
  INSERT INTO r VALUES ('S12 then onboarding can complete', (SELECT stage_order FROM service_deliveries WHERE id=o)=3, '');
  BEGIN PERFORM waive_delivery_suite(o, 'x', 'test'); INSERT INTO r VALUES ('S13 cannot waive a company that already has a suite', false, 'waived!');
  EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES ('S13 cannot waive a company that already has a suite', SQLERRM ILIKE '%nothing to waive%', SQLERRM); END;

  -- claim-only never issues
  SELECT id INTO acct_suite FROM accounts WHERE suite_number IS NULL AND account_type='Client' AND id <> acct LIMIT 1;
  INSERT INTO r VALUES ('S14 claim-only returns nothing when there is no reservation (never issues)', claim_company_suite(acct_suite, NULL, 'test') IS NULL AND (SELECT suite_number FROM accounts WHERE id=acct_suite) IS NULL, '');
  -- test deliveries are exempt from the gate
  INSERT INTO service_deliveries SELECT (jsonb_populate_record(NULL::service_deliveries, tmpl || jsonb_build_object('id',gen_random_uuid(),'service_type','Company Formation','stage','Wizard Submitted','stage_order',2,'account_id',NULL,'status','active','is_test',true,'suite_waived_at',NULL))).*;
  UPDATE service_deliveries SET stage='Filed with State', stage_order=3 WHERE service_type='Company Formation' AND is_test AND stage_order=2 AND account_id IS NULL AND stage='Wizard Submitted' AND id IN (SELECT id FROM service_deliveries ORDER BY created_at DESC LIMIT 1);
  INSERT INTO r VALUES ('S15 test deliveries are exempt', true, 'no error');
END $$;
SELECT test, ok, info FROM r ORDER BY test;
