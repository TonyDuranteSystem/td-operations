-- CRM Store — slice S3 proofs: access, visibility and sending (master plan v4.5 §8.9 #3).
-- Throwaway fixtures inside a transaction, ROLLED BACK at the end. Any failed check raises.
-- Run AFTER the S1, S2 and S3 migrations. SANDBOX ONLY.
-- NOTE: inside one SQL expression the evaluation order is not guaranteed — every call with a side
-- effect is its own statement.

BEGIN;

DO $$
DECLARE
  a uuid; a_sm uuid; a_closed uuid; a_susp uuid; a_other uuid;
  p1 uuid; p2 uuid; pc uuid; prep uuid; pnew uuid; pbuy uuid; pout uuid; pstray uuid;
  o_a uuid; o_sm uuid; o_closed uuid; o_susp uuid; o_p1 uuid; o_f uuid; o_unf uuid;
  fa_co uuid; fa_tax uuid; fa_corr uuid; fp1 uuid; fp1_itin uuid; ff_co uuid; funf uuid; fsm uuid; fcl uuid; fsu uuid;
  sd_tax uuid; sd_form uuid; sd_other uuid; sr uuid; tm_docs uuid; tm_none uuid; u uuid; u2 uuid;
  f_ss4 uuid; f_ret uuid; f_signed uuid; f_k1 uuid; f_old uuid; f_b uuid; f_c uuid; f_hidden uuid; f_stage uuid;
  f_pass uuid; f_itin uuid; f_passco uuid; f_untyped uuid; f_form uuid; f_unf uuid; f_sm uuid; f_cl uuid; f_su uuid; f_mig uuid;
  r jsonb; n int;
BEGIN
  -- ── fixtures (fake names, rolled back)
  INSERT INTO accounts (company_name, status, entity_type) VALUES ('ZZ S3 Multi Co', 'Active', 'Multi Member LLC') RETURNING id INTO a;
  INSERT INTO accounts (company_name, status, entity_type) VALUES ('ZZ S3 Single Co', 'Active', 'Single Member LLC') RETURNING id INTO a_sm;
  INSERT INTO accounts (company_name, status) VALUES ('ZZ S3 Closed Co', 'Closed') RETURNING id INTO a_closed;
  INSERT INTO accounts (company_name, status) VALUES ('ZZ S3 Suspended Co', 'Suspended') RETURNING id INTO a_susp;
  INSERT INTO accounts (company_name, status) VALUES ('ZZ S3 Other Client', 'Active') RETURNING id INTO a_other;
  INSERT INTO contacts (full_name) VALUES ('ZZ S3 Owner One') RETURNING id INTO p1;
  INSERT INTO contacts (full_name) VALUES ('ZZ S3 Member Two') RETURNING id INTO p2;
  INSERT INTO contacts (full_name) VALUES ('ZZ S3 Consultant') RETURNING id INTO pc;
  INSERT INTO contacts (full_name) VALUES ('ZZ S3 Representative') RETURNING id INTO prep;
  INSERT INTO contacts (full_name) VALUES ('ZZ S3 New Member') RETURNING id INTO pnew;
  INSERT INTO contacts (full_name) VALUES ('ZZ S3 Formation Buyer') RETURNING id INTO pbuy;
  INSERT INTO contacts (full_name) VALUES ('ZZ S3 Outsider') RETURNING id INTO pout;
  INSERT INTO contacts (full_name) VALUES ('ZZ S3 Stray') RETURNING id INTO pstray;
  INSERT INTO account_contacts (account_id, contact_id, role) VALUES (a, p1, 'Owner'), (a, p2, 'Member'),
         (a, pc, 'Partner - Tax/NHR Consultant (Portugal)'), (a, prep, 'authorized_representative'), (a, pstray, NULL);
  INSERT INTO account_contacts (account_id, contact_id, role) VALUES (a_sm, p1, NULL), (a_sm, pc, 'Collaborator - Client Communications');
  INSERT INTO account_contacts (account_id, contact_id, role) VALUES (a_closed, p1, 'owner'), (a_susp, p1, 'owner');
  INSERT INTO members (account_id, member_type, full_name, contact_id, representative_name, representative_email)
       VALUES (a, 'individual', 'ZZ S3 Member Two', p2, 'ZZ Rep Free Text', 'Rep.FreeText@example.test');
  INSERT INTO service_deliveries (service_name, service_type, account_id, stage, status) VALUES ('Tax 2025', 'Tax Return', a, 'Tax Return Prepared', 'active') RETURNING id INTO sd_tax;
  INSERT INTO service_deliveries (service_name, service_type, contact_id, stage, status) VALUES ('Formation', 'Company Formation', pbuy, 'Filed with State', 'active') RETURNING id INTO sd_form;
  INSERT INTO service_deliveries (service_name, service_type, account_id, stage, status) VALUES ('Other tax', 'Tax Return', a_other, 'Completed', 'active') RETURNING id INTO sd_other;
  INSERT INTO signature_requests (token, document_name, pdf_storage_path, status, account_id, service_delivery_id)
       VALUES ('zz-s3-' || gen_random_uuid(), 'ZZ 1065 2025', 'zz/s3.pdf', 'awaiting_signature', a, sd_tax) RETURNING id INTO sr;
  SELECT id INTO u  FROM auth.users x WHERE NOT EXISTS (SELECT 1 FROM portal_team_members t WHERE t.auth_user_id = x.id) ORDER BY created_at LIMIT 1;
  SELECT id INTO u2 FROM auth.users x WHERE NOT EXISTS (SELECT 1 FROM portal_team_members t WHERE t.auth_user_id = x.id) AND x.id <> u ORDER BY created_at LIMIT 1;
  INSERT INTO portal_team_members (account_id, auth_user_id, username, display_name, capabilities)
       VALUES (a, u, 'zz-s3-docs', 'ZZ Teammate Docs', '{"documents":true}') RETURNING id INTO tm_docs;
  INSERT INTO portal_team_members (account_id, auth_user_id, username, display_name, capabilities)
       VALUES (a, u2, 'zz-s3-none', 'ZZ Teammate None', '{"invoices":true}') RETURNING id INTO tm_none;

  o_a := store_ensure_owner('company', a);             PERFORM store_apply_template(o_a, 'company_standard', 'ZZ S3 Multi Co');
  o_sm := store_ensure_owner('company', a_sm);         PERFORM store_apply_template(o_sm, 'company_standard', 'ZZ S3 Single Co');
  o_closed := store_ensure_owner('company', a_closed); PERFORM store_apply_template(o_closed, 'company_standard', 'ZZ S3 Closed Co');
  o_susp := store_ensure_owner('company', a_susp);     PERFORM store_apply_template(o_susp, 'company_standard', 'ZZ S3 Suspended Co');
  o_p1 := store_ensure_owner('person', p1);            PERFORM store_apply_template(o_p1, 'person_standard', 'ZZ S3 Owner One');
  o_f := store_ensure_owner('formation', sd_form);     PERFORM store_apply_template(o_f, 'company_standard', 'ZZ S3 Forming LLC');
  o_unf := store_ensure_owner('unfiled', NULL);        PERFORM store_apply_template(o_unf, 'unfiled_standard', 'Unfiled');
  SELECT id INTO fa_co   FROM store_folders WHERE owner_id = o_a AND kind = 'company';
  SELECT id INTO fa_tax  FROM store_folders WHERE owner_id = o_a AND kind = 'tax';
  SELECT id INTO fa_corr FROM store_folders WHERE owner_id = o_a AND kind = 'correspondence';
  SELECT id INTO fp1     FROM store_folders WHERE owner_id = o_p1 AND kind = 'personal';
  SELECT id INTO fp1_itin FROM store_folders WHERE owner_id = o_p1 AND kind = 'itin';
  SELECT id INTO ff_co   FROM store_folders WHERE owner_id = o_f AND kind = 'company';
  SELECT id INTO funf    FROM store_folders WHERE owner_id = o_unf ORDER BY parent_id NULLS LAST LIMIT 1;
  SELECT id INTO fsm FROM store_folders WHERE owner_id = o_sm AND kind = 'company';
  SELECT id INTO fcl FROM store_folders WHERE owner_id = o_closed AND kind = 'company';
  SELECT id INTO fsu FROM store_folders WHERE owner_id = o_susp AND kind = 'company';

  f_ss4 := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_co,'name','SS-4 signed.pdf','sha256',md5('ss4')||md5('ss4'),'bucket','crm-store','path','zz/ss4','size',1,
            'document_type','form_ss_4','published',true)))->>'file_id';
  -- the prepared return: a flow saves it with no status / no visibility → a hidden draft
  f_ret := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_tax,'name','1065 2025 prepared.pdf','sha256',md5('ret')||md5('ret'),'bucket','crm-store','path','zz/ret','size',1,
            'document_type','form_1065','period_year',2025,
            'links', jsonb_build_array(jsonb_build_object('kind','service_case','record_id',sd_tax,'stage','Completed'),
                                       jsonb_build_object('kind','signature_request','record_id',sr)))))->>'file_id';
  f_k1 := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_tax,'name','K-1 Member Two 2025.pdf','sha256',md5('k1')||md5('k1'),'bucket','crm-store','path','zz/k1','size',1,
            'document_type','tax_return','period_year',2025,'filing_status','filed','published',true,
            'subjects', jsonb_build_array(jsonb_build_object('kind','person','contact_id',p2,'role','owner_member')))))->>'file_id';
  f_hidden := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_corr,'name','migrated unpublished.pdf','sha256',md5('hid')||md5('hid'),'bucket','crm-store','path','zz/hid','size',1,
            'document_type','irs_notice','published',false)))->>'file_id';
  f_pass := (store_write(jsonb_build_object('owner_id',o_p1,'folder_id',fp1,'name','Passport Owner One.pdf','sha256',md5('pass')||md5('pass'),'bucket','crm-store','path','zz/pass','size',1,
            'document_type','passport','published',true)))->>'file_id';
  f_itin := (store_write(jsonb_build_object('owner_id',o_p1,'folder_id',fp1_itin,'name','ITIN letter.pdf','sha256',md5('itin')||md5('itin'),'bucket','crm-store','path','zz/itin','size',1,
            'document_type','itin_letter','published',true)))->>'file_id';
  f_passco := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_corr,'name','Passport Member Two (misfiled).pdf','sha256',md5('pco')||md5('pco'),'bucket','crm-store','path','zz/pco','size',1,
            'document_type','passport','published',true,
            'subjects', jsonb_build_array(jsonb_build_object('kind','person','contact_id',p2,'role','concerns')))))->>'file_id';
  f_untyped := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_corr,'name','scan 0042.pdf','sha256',md5('unt')||md5('unt'),'bucket','crm-store','path','zz/unt','size',1,'published',true)))->>'file_id';
  f_form := (store_write(jsonb_build_object('owner_id',o_f,'folder_id',ff_co,'name','Articles.pdf','sha256',md5('art')||md5('art'),'bucket','crm-store','path','zz/art','size',1,
            'document_type','articles_of_organization','links', jsonb_build_array(jsonb_build_object('kind','service_case','record_id',sd_form)))))->>'file_id';
  f_unf := (store_write(jsonb_build_object('owner_id',o_unf,'folder_id',funf,'name','IRS letter.pdf','sha256',md5('unf')||md5('unf'),'bucket','crm-store','path','zz/unf','size',1,'published',true)))->>'file_id';
  f_sm := (store_write(jsonb_build_object('owner_id',o_sm,'folder_id',fsm,'name','OA single.pdf','sha256',md5('sm')||md5('sm'),'bucket','crm-store','path','zz/sm','size',1,'document_type','operating_agreement','published',true)))->>'file_id';
  f_cl := (store_write(jsonb_build_object('owner_id',o_closed,'folder_id',fcl,'name','Closed co doc.pdf','sha256',md5('cl')||md5('cl'),'bucket','crm-store','path','zz/cl','size',1,'document_type','operating_agreement','published',true)))->>'file_id';
  f_su := (store_write(jsonb_build_object('owner_id',o_susp,'folder_id',fsu,'name','Suspended co doc.pdf','sha256',md5('su')||md5('su'),'bucket','crm-store','path','zz/su','size',1,'document_type','operating_agreement','published',true)))->>'file_id';

  -- ── 1. personal files: only their person — by id, listing, send; unknown type fails closed
  IF store_file_access(f_pass, p2, NULL) <> 'not_the_person' THEN RAISE EXCEPTION 'CHECK 1 FAILED: co-member opened a passport'; END IF;
  IF store_file_access(f_pass, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 1 FAILED: owner cannot open own passport'; END IF;
  IF store_file_access(f_itin, p2, NULL) <> 'not_the_person' THEN RAISE EXCEPTION 'CHECK 1 FAILED: co-member opened an ITIN letter'; END IF;
  IF store_file_access(f_passco, p1, NULL) <> 'not_the_person' THEN RAISE EXCEPTION 'CHECK 1 FAILED: personal doc under the company reached another member'; END IF;
  IF store_file_access(f_passco, p2, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 1 FAILED: the person it concerns cannot open it'; END IF;
  IF store_file_access(f_untyped, p1, NULL) <> 'not_the_person' OR store_file_access(f_untyped, NULL, tm_docs) <> 'personal_not_for_teammates' THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: a file with no type was shown to members/teammates (must fail closed)';
  END IF;
  IF EXISTS (SELECT 1 FROM store_visible_files(p2, NULL, NULL) WHERE file_id IN (f_pass, f_itin)) THEN RAISE EXCEPTION 'CHECK 1 FAILED: listing shows another person''s personal file'; END IF;
  IF store_send_check(f_pass, 'company_members', jsonb_build_object('contact_id', p2), NULL) <> 'personal_not_allowed'
     OR store_send_check(f_pass, 'own_person', jsonb_build_object('contact_id', p2), NULL) <> 'not_the_person'
     OR store_send_check(f_pass, 'representative', jsonb_build_object('email','rep.freetext@example.test'), NULL) <> 'personal_not_allowed'
     OR store_send_check(f_pass, 'own_person', jsonb_build_object('contact_id', p1), NULL) <> 'ok' THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: passport send rules';
  END IF;
  PERFORM store_record_view(f_pass, p2, NULL);
  IF NOT EXISTS (SELECT 1 FROM store_events WHERE event = 'view_refused' AND file_id = f_pass) THEN RAISE EXCEPTION 'CHECK 1 FAILED: refused personal view not recorded'; END IF;
  PERFORM store_record_view(f_pass, p1, NULL);
  PERFORM store_record_view(f_ss4, p1, NULL);
  IF NOT EXISTS (SELECT 1 FROM store_events WHERE event = 'viewed' AND file_id = f_pass)
     OR EXISTS (SELECT 1 FROM store_events WHERE event IN ('viewed','view_refused') AND file_id = f_ss4) THEN RAISE EXCEPTION 'CHECK 1 FAILED: view logging'; END IF;
  RAISE NOTICE 'CHECK 1 passed — personal files only to their person (id, listing, send); untyped files fail closed; personal views and refused attempts recorded';

  -- ── 2. sends: authority / accountant / bank with a reason; staff-internal; outside-rules sends still recorded
  IF store_send_check(f_ss4, 'tax_authority', jsonb_build_object(), NULL) <> 'reason_required' THEN RAISE EXCEPTION 'CHECK 2 FAILED: IRS send without a reason'; END IF;
  r := store_record_send(f_ss4, 'tax_authority', jsonb_build_object('fax','+1-855-641-6935'), 'SS-4 to IRS for EIN', NULL, 'fax');
  IF r->>'code' <> 'ok' THEN RAISE EXCEPTION 'CHECK 2 FAILED: SS-4 fax %', r; END IF;
  r := store_record_send(f_k1, 'accountant', jsonb_build_object('email','accountant@example.test'), '2025 package', NULL, 'email');
  IF r->>'code' <> 'ok' THEN RAISE EXCEPTION 'CHECK 2 FAILED: K-1 package %', r; END IF;
  r := store_record_send(f_pass, 'bank', jsonb_build_object('email','kyc@bank.example.test'), 'bank account opening KYC', NULL, 'email');
  IF r->>'code' <> 'ok' THEN RAISE EXCEPTION 'CHECK 2 FAILED: passport to bank %', r; END IF;
  IF store_send_check(f_pass, 'staff_internal', jsonb_build_object(), NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 2 FAILED: staff-internal send refused'; END IF;
  IF store_send_check(f_pass, 'service_provider', jsonb_build_object('email','cmra@example.test'), 'USPS 1583') <> 'ok' THEN RAISE EXCEPTION 'CHECK 2 FAILED: CMRA send refused'; END IF;
  r := store_record_send(f_pass, 'other', jsonb_build_object('email','x@example.test'), 'why not', NULL, 'email');
  IF r->>'code' <> 'personal_not_allowed' OR NOT EXISTS (SELECT 1 FROM store_events WHERE id = (r->>'event_id')::bigint AND event = 'sent_outside_rules') THEN
    RAISE EXCEPTION 'CHECK 2 FAILED: a send outside the rules was not recorded as such %', r;
  END IF;
  IF store_send_check(f_unf, 'own_person', jsonb_build_object('contact_id', p1), NULL) <> 'unfiled_must_be_classified' THEN RAISE EXCEPTION 'CHECK 2 FAILED: unfiled file sendable'; END IF;
  RAISE NOTICE 'CHECK 2 passed — IRS / accountant / bank / CMRA sends need a reason and are recorded; staff-internal allowed; outside-rules sends recorded, not lost';

  -- ── 3. the prepared return stays hidden forever (as today); the SIGNED COPY is its own visible file
  IF (SELECT filing_status FROM store_files WHERE id = f_ret) <> 'draft' OR (SELECT published FROM store_files WHERE id = f_ret) THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: prepared return did not start as a hidden draft';
  END IF;
  IF (SELECT stage_at_creation FROM store_record_links WHERE file_id = f_ret AND link_kind = 'service_case') <> 'Tax Return Prepared' THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: link stage taken from the caller, not from the real service case';
  END IF;
  UPDATE signature_requests SET status = 'signed', signed_at = now() WHERE id = sr;
  IF store_file_access(f_ret, p1, NULL) <> 'not_client_visible' THEN RAISE EXCEPTION 'CHECK 3 FAILED: signing exposed the unsigned draft'; END IF;
  BEGIN
    PERFORM store_set_published(f_ret, true, NULL);
    RAISE EXCEPTION 'CHECK 3 FAILED: a hidden-draft type could be published';
  EXCEPTION WHEN check_violation THEN NULL; END;
  f_signed := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_tax,'name','1065 2025 - Signed.pdf','sha256',md5('sig')||md5('sig'),'bucket','crm-store','path','zz/sig','size',1,
               'document_type','form_1065','period_year',2025,'filing_status','filed','published',true,
               'links', jsonb_build_array(jsonb_build_object('kind','signature_request','record_id',sr)))))->>'file_id';
  IF store_file_access(f_signed, p1, NULL) <> 'ok' OR store_file_access(f_signed, p2, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 3 FAILED: signed copy not visible to members'; END IF;
  IF store_file_access(f_ss4, p2, NULL) <> 'ok' OR store_file_access(f_k1, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 3 FAILED: SS-4 / K-1 not visible to all members (#38/#39/#45)'; END IF;
  RAISE NOTICE 'CHECK 3 passed — prepared return stays a hidden draft even after signing and cannot be published; the signed copy is visible to every member; SS-4 and K-1 too';

  -- ── 4. teammates, consultants, representatives, single-member owner, stray links
  IF store_file_access(f_ss4, NULL, tm_docs) <> 'ok' THEN RAISE EXCEPTION 'CHECK 4 FAILED: teammate with documents permission refused'; END IF;
  IF store_file_access(f_passco, NULL, tm_docs) <> 'personal_not_for_teammates' THEN RAISE EXCEPTION 'CHECK 4 FAILED: teammate saw a personal file'; END IF;
  IF store_file_access(f_ss4, NULL, tm_none) <> 'teammate_no_documents' THEN RAISE EXCEPTION 'CHECK 4 FAILED: teammate without documents permission allowed'; END IF;
  UPDATE portal_team_members SET status = 'revoked' WHERE id = tm_docs;
  IF store_file_access(f_ss4, NULL, tm_docs) <> 'no_access' THEN RAISE EXCEPTION 'CHECK 4 FAILED: revoked teammate allowed'; END IF;
  IF store_file_access(f_ss4, pc, NULL) <> 'no_company_access' THEN RAISE EXCEPTION 'CHECK 4 FAILED: consultant allowed (#44)'; END IF;
  IF store_file_access(f_ss4, prep, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 4 FAILED: authorized representative refused (#44)'; END IF;
  IF store_file_access(f_ss4, pout, NULL) <> 'no_company_access' THEN RAISE EXCEPTION 'CHECK 4 FAILED: outsider allowed'; END IF;
  IF store_file_access(f_sm, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 4 FAILED: single-member owner (role-less) locked out by a collaborator link'; END IF;
  IF store_file_access(f_sm, pc, NULL) <> 'no_company_access' THEN RAISE EXCEPTION 'CHECK 4 FAILED: collaborator on the SMLLC allowed'; END IF;
  IF store_file_access(f_ss4, pstray, NULL) <> 'no_company_access' THEN RAISE EXCEPTION 'CHECK 4 FAILED: stray role-less link on a multi-member company promoted to owner'; END IF;
  IF store_send_check(f_ss4, 'representative', jsonb_build_object('email','rep.freetext@example.test'), NULL) <> 'ok'
     OR store_send_check(f_ss4, 'representative', jsonb_build_object('contact_id', prep), NULL) <> 'ok'
     OR store_send_check(f_ss4, 'representative', jsonb_build_object('email','stranger@example.test'), NULL) <> 'not_a_representative' THEN
    RAISE EXCEPTION 'CHECK 4 FAILED: representative send rules';
  END IF;
  IF store_file_access(f_ss4, p1, tm_none) <> 'viewer_required' OR store_file_access(f_ss4, NULL, NULL) <> 'viewer_required' THEN RAISE EXCEPTION 'CHECK 4 FAILED: ambiguous viewer accepted'; END IF;
  RAISE NOTICE 'CHECK 4 passed — teammates only with documents permission, never personal; consultant/collaborator/outsider/stray refused; representative + SMLLC owner allowed';

  -- ── 5. a member leaves: one-week window + queued invitation, then nothing; their representative too; reopen
  r := store_end_membership(a, p2, NULL, 'left the company');
  IF r->>'status' <> 'ended' OR (r->>'invitation_id') IS NULL THEN RAISE EXCEPTION 'CHECK 5 FAILED: %', r; END IF;
  IF store_file_access(f_k1, p2, NULL) <> 'ok_leaving' OR store_file_access(f_ss4, p2, NULL) <> 'ok_leaving' THEN RAISE EXCEPTION 'CHECK 5 FAILED: leaver lost access inside the window'; END IF;
  IF NOT EXISTS (SELECT 1 FROM store_pending_exit_invitations(100) WHERE contact_id = p2) THEN RAISE EXCEPTION 'CHECK 5 FAILED: invitation not pending'; END IF;
  IF (SELECT end_date FROM members WHERE account_id = a AND contact_id = p2) IS DISTINCT FROM (now() AT TIME ZONE 'America/New_York')::date THEN RAISE EXCEPTION 'CHECK 5 FAILED: members row not end-dated (TD time zone)'; END IF;
  IF EXISTS (SELECT 1 FROM store_company_contacts(a) WHERE contact_id = p2) THEN RAISE EXCEPTION 'CHECK 5 FAILED: leaver still in Contacts'; END IF;
  IF store_send_check(f_ss4, 'company_members', jsonb_build_object('contact_id', p2), NULL) <> 'not_in_company' THEN RAISE EXCEPTION 'CHECK 5 FAILED: leaver still a company-member recipient'; END IF;
  IF store_send_check(f_ss4, 'representative', jsonb_build_object('email','rep.freetext@example.test'), NULL) <> 'not_a_representative' THEN
    RAISE EXCEPTION 'CHECK 5 FAILED: a departed member''s representative can still receive company files';
  END IF;
  IF (store_end_membership(a, p2, NULL, NULL))->>'status' <> 'already_ended' THEN RAISE EXCEPTION 'CHECK 5 FAILED: end not idempotent'; END IF;
  UPDATE account_contacts SET access_until = now() - interval '1 second' WHERE account_id = a AND contact_id = p2;   -- a week later
  IF store_file_access(f_k1, p2, NULL) <> 'no_company_access' OR store_file_access(f_passco, p2, NULL) <> 'no_company_access' THEN
    RAISE EXCEPTION 'CHECK 5 FAILED: leaver kept access after the window (incl. own K-1 — no exception, #45)';
  END IF;
  IF EXISTS (SELECT 1 FROM store_pending_exit_invitations(100) WHERE contact_id = p2) THEN RAISE EXCEPTION 'CHECK 5 FAILED: expired invitation still pending'; END IF;
  r := store_reopen_membership(a, p2, NULL, 'ended by mistake');
  IF r->>'status' <> 'reopened' THEN RAISE EXCEPTION 'CHECK 5 FAILED: reopen %', r; END IF;
  IF store_file_access(f_ss4, p2, NULL) <> 'ok' OR (SELECT end_date FROM members WHERE account_id = a AND contact_id = p2) IS NOT NULL THEN RAISE EXCEPTION 'CHECK 5 FAILED: reopen did not restore'; END IF;
  -- a consultant "leaving" never had access → no invitation
  r := store_end_membership(a, pc, NULL, NULL);
  IF (r->>'invitation_id') IS NOT NULL THEN RAISE EXCEPTION 'CHECK 5 FAILED: consultant got a download invitation'; END IF;
  RAISE NOTICE 'CHECK 5 passed — leaver: window + pending invitation, then nothing (representative too); reopen restores; no invitation for someone who had no access';

  -- ── 6. revoke: at once, membership kept, no invitation; reopen never undoes a revoke; restore lifts it
  SELECT count(*) INTO n FROM store_exit_invitations WHERE contact_id = p1;
  r := store_revoke_access(a, p1, NULL, 'lost phone');
  IF r->>'status' <> 'revoked' OR store_file_access(f_ss4, p1, NULL) <> 'no_company_access' THEN RAISE EXCEPTION 'CHECK 6 FAILED: revoke %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM store_company_contacts(a) WHERE contact_id = p1) THEN RAISE EXCEPTION 'CHECK 6 FAILED: revoke ended the membership'; END IF;
  IF (SELECT count(*) FROM store_exit_invitations WHERE contact_id = p1) <> n THEN RAISE EXCEPTION 'CHECK 6 FAILED: revoke queued an invitation'; END IF;
  IF store_file_access(f_pass, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 6 FAILED: revoking company access hid the person''s own passport'; END IF;
  r := store_end_membership(a, p1, NULL, NULL);
  IF (r->>'invitation_id') IS NOT NULL THEN RAISE EXCEPTION 'CHECK 6 FAILED: a revoked person got an invitation on leaving'; END IF;
  r := store_reopen_membership(a, p1, NULL, 'mistake');
  IF (r->>'still_revoked')::boolean IS NOT TRUE OR store_file_access(f_ss4, p1, NULL) <> 'no_company_access' THEN
    RAISE EXCEPTION 'CHECK 6 FAILED: reopening a membership undid a revoke %', r;
  END IF;
  r := store_restore_access(a, p1, NULL, NULL);
  IF r->>'status' <> 'restored' OR store_file_access(f_ss4, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 6 FAILED: restore %', r; END IF;
  RAISE NOTICE 'CHECK 6 passed — revoke ends access at once, keeps the membership, queues nothing, survives a reopen; restore lifts it';

  -- ── 7. a new member sees the company's earlier files
  INSERT INTO account_contacts (account_id, contact_id, role) VALUES (a, pnew, 'member');
  IF store_file_access(f_k1, pnew, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 7 FAILED: new member cannot see earlier files (#42)'; END IF;
  RAISE NOTICE 'CHECK 7 passed — a new member sees earlier company files';

  -- ── 8. amendments: A ← B ← C; only the newest VISIBLE one shows; checks on what can be superseded
  f_old := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_tax,'name','1065 2024 filed.pdf','sha256',md5('old')||md5('old'),'bucket','crm-store','path','zz/old','size',1,
            'document_type','form_1065','period_year',2024,'filing_status','filed','published',true)))->>'file_id';
  f_b := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_tax,'name','1065 2024 amended 1.pdf','sha256',md5('b')||md5('b'),'bucket','crm-store','path','zz/b','size',1,
          'document_type','form_1065','period_year',2024,'supersedes_file_id',f_old)))->>'file_id';
  IF store_file_access(f_old, p1, NULL) <> 'ok' OR store_file_access(f_b, p1, NULL) <> 'not_client_visible' THEN RAISE EXCEPTION 'CHECK 8 FAILED: a draft amendment hid the original'; END IF;
  PERFORM store_set_filing_status(f_b, 'amended', NULL);
  PERFORM store_set_published(f_b, true, NULL);
  IF store_file_access(f_old, p1, NULL) <> 'not_client_visible' OR store_file_access(f_b, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 8 FAILED: first amendment did not replace the original'; END IF;
  f_c := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_tax,'name','1065 2024 amended 2.pdf','sha256',md5('c')||md5('c'),'bucket','crm-store','path','zz/c','size',1,
          'document_type','form_1065','period_year',2024,'filing_status','amended','published',true,'supersedes_file_id',f_b)))->>'file_id';
  IF store_file_access(f_old, p1, NULL) <> 'not_client_visible' OR store_file_access(f_b, p1, NULL) <> 'not_client_visible' OR store_file_access(f_c, p1, NULL) <> 'ok' THEN
    RAISE EXCEPTION 'CHECK 8 FAILED: A←B←C: the original came back or the wrong one shows';
  END IF;
  BEGIN
    PERFORM store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_tax,'name','bad amend.pdf','sha256',md5('bad')||md5('bad'),'bucket','crm-store','path','zz/bad','size',1,
            'document_type','form_1120','period_year',2024,'supersedes_file_id',f_c));
    RAISE EXCEPTION 'CHECK 8 FAILED: an amendment of a different type was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'CHECK 8 FAILED%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE store_files SET supersedes_file_id = f_c WHERE id = f_old;
    RAISE EXCEPTION 'CHECK 8 FAILED: supersedes link could be edited (loop risk)';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM store_set_filing_status(f_c, 'draft', NULL);
    RAISE EXCEPTION 'CHECK 8 FAILED: filing status moved backwards';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'CHECK 8 FAILED%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'CHECK 8 passed — A←B←C shows only the newest visible amendment; wrong-type amendments, link edits and backward status moves refused';

  -- ── 9. the switch always works: a file shown by its client-safe stage can be hidden; unpublished stays hidden
  f_stage := (store_write(jsonb_build_object('owner_id',o_f,'folder_id',ff_co,'name','Filed state receipt.pdf','sha256',md5('stg')||md5('stg'),'bucket','crm-store','path','zz/stg','size',1,
              'document_type','articles_of_organization','links', jsonb_build_array(jsonb_build_object('kind','service_case','record_id',sd_form)))))->>'file_id';
  IF NOT (SELECT published FROM store_files WHERE id = f_stage) OR store_file_access(f_stage, pbuy, NULL) <> 'ok' THEN
    RAISE EXCEPTION 'CHECK 9 FAILED: file created in a client-safe stage not shown';
  END IF;
  PERFORM store_set_published(f_stage, false, NULL);
  IF store_file_access(f_stage, pbuy, NULL) <> 'not_client_visible' THEN RAISE EXCEPTION 'CHECK 9 FAILED: unpublish did not hide a stage-visible file'; END IF;
  IF store_file_access(f_hidden, p1, NULL) <> 'not_client_visible' THEN RAISE EXCEPTION 'CHECK 9 FAILED: unpublished file visible'; END IF;
  IF NOT store_set_published(f_hidden, true, NULL) THEN RAISE EXCEPTION 'CHECK 9 FAILED: publish returned no change'; END IF;
  IF store_file_access(f_hidden, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 9 FAILED: published file not visible'; END IF;
  IF store_set_published(f_hidden, true, NULL) THEN RAISE EXCEPTION 'CHECK 9 FAILED: publish not idempotent'; END IF;
  -- a migrated, already-filed, published return stays exactly as it is today
  f_mig := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_tax,'name','5472 2023.pdf','sha256',md5('mig')||md5('mig'),'bucket','crm-store','path','zz/mig','size',1,
            'document_type','form_5472','period_year',2023,'published',true)))->>'file_id';
  IF (SELECT filing_status FROM store_files WHERE id = f_mig) = 'draft' OR store_file_access(f_mig, p1, NULL) <> 'ok' THEN
    RAISE EXCEPTION 'CHECK 9 FAILED: a migrated published return was turned into a hidden draft';
  END IF;
  RAISE NOTICE 'CHECK 9 passed — publish/unpublish always take effect (even over a stage default); migrated published returns stay visible';

  -- ── 10. company status, formation buyer, Unfiled; links can never point at another client's records
  IF store_file_access(f_cl, p1, NULL) <> 'company_hidden' THEN RAISE EXCEPTION 'CHECK 10 FAILED: closed company visible'; END IF;
  IF store_file_access(f_su, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 10 FAILED: suspended company hidden'; END IF;
  IF store_file_access(f_form, pbuy, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 10 FAILED: buyer cannot see in-formation Articles'; END IF;
  IF store_file_access(f_form, p1, NULL) <> 'not_the_buyer' THEN RAISE EXCEPTION 'CHECK 10 FAILED: non-buyer sees formation files'; END IF;
  IF store_file_access(f_unf, p1, NULL) <> 'unfiled' THEN RAISE EXCEPTION 'CHECK 10 FAILED: Unfiled visible'; END IF;
  BEGIN
    PERFORM store_write(jsonb_build_object('owner_id',o_a,'folder_id',fa_corr,'name','old scan.pdf','sha256',md5('x2')||md5('x2'),'bucket','crm-store','path','zz/x2','size',1,
            'links', jsonb_build_array(jsonb_build_object('kind','service_case','record_id',sd_other))));
    RAISE EXCEPTION 'CHECK 10 FAILED: a link to ANOTHER client''s service case was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'CHECK 10 passed — closed hidden, suspended shown, formation only to its buyer, Unfiled to nobody, cross-client links refused';

  RAISE NOTICE 'ALL S3 CHECKS PASSED (fixtures rolled back)';
END $$;

ROLLBACK;
