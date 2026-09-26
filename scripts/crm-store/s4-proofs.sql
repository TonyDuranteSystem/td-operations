-- CRM Store — slice S4 proofs: trash / restore / purge / remove-from-view / folder upload / zip listing
-- (master plan v4.5 §8.9 #4). Throwaway fixtures inside a transaction, ROLLED BACK. SANDBOX ONLY.
-- Every call with a side effect is its own statement (SQL does not promise evaluation order).

BEGIN;

DO $$
DECLARE
  a uuid; a2 uuid; p1 uuid; p2 uuid; o_a uuid; o_a2 uuid; o_p2 uuid; sd uuid; staff uuid := gen_random_uuid();
  f_tax uuid; f_corr uuid; f_co2 uuid; fp2 uuid; sub uuid; sub2 uuid; leaf uuid; again uuid;
  x1 uuid; x2 uuid; x3 uuid; xa uuid; xb uuid; xc uuid; f_pass uuid; f_filed uuid; f_link uuid;
  b1 uuid; b2 uuid; b3 uuid; r jsonb; n int; nm text;
BEGIN
  INSERT INTO accounts (company_name, status, entity_type) VALUES ('ZZ S4 Co', 'Active', 'Multi Member LLC') RETURNING id INTO a;
  INSERT INTO accounts (company_name, status) VALUES ('ZZ S4 Other Co', 'Active') RETURNING id INTO a2;
  INSERT INTO contacts (full_name) VALUES ('ZZ S4 Owner') RETURNING id INTO p1;
  INSERT INTO contacts (full_name) VALUES ('ZZ S4 Member') RETURNING id INTO p2;
  INSERT INTO account_contacts (account_id, contact_id, role) VALUES (a, p1, 'owner'), (a, p2, 'member');
  INSERT INTO service_deliveries (service_name, service_type, account_id, stage, status) VALUES ('Tax', 'Tax Return', a, 'Completed', 'active') RETURNING id INTO sd;
  o_a := store_ensure_owner('company', a);   PERFORM store_apply_template(o_a, 'company_standard', 'ZZ S4 Co');
  o_a2 := store_ensure_owner('company', a2); PERFORM store_apply_template(o_a2, 'company_standard', 'ZZ S4 Other Co');
  o_p2 := store_ensure_owner('person', p2);  PERFORM store_apply_template(o_p2, 'person_standard', 'ZZ S4 Member');
  SELECT id INTO f_tax  FROM store_folders WHERE owner_id = o_a AND kind = 'tax';
  SELECT id INTO f_corr FROM store_folders WHERE owner_id = o_a AND kind = 'correspondence';
  SELECT id INTO f_co2  FROM store_folders WHERE owner_id = o_a2 AND kind = 'company';
  SELECT id INTO fp2    FROM store_folders WHERE owner_id = o_p2 AND kind = 'personal';

  -- ── 7 (first, it builds the tree). folder upload: nested folders created once, idempotent, bad names refused
  leaf := store_ensure_folder_path(o_a, f_corr, ARRAY['2025','Bank letters'], staff);
  again := store_ensure_folder_path(o_a, f_corr, ARRAY['2025','bank letters '], staff);
  IF leaf <> again THEN RAISE EXCEPTION 'CHECK 7 FAILED: folder path not idempotent (case/space)'; END IF;
  SELECT parent_id INTO sub FROM store_folders WHERE id = leaf;
  IF (SELECT name FROM store_folders WHERE id = sub) <> '2025' OR (SELECT parent_id FROM store_folders WHERE id = sub) <> f_corr THEN RAISE EXCEPTION 'CHECK 7 FAILED: wrong nesting'; END IF;
  BEGIN
    PERFORM store_ensure_folder_path(o_a, f_corr, ARRAY['ok','..'], staff);
    RAISE EXCEPTION 'CHECK 7 FAILED: ".." accepted in an upload path';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'CHECK 7 FAILED%' THEN RAISE; END IF; END;
  BEGIN
    PERFORM store_ensure_folder_path(o_a2, f_corr, ARRAY['stray'], staff);
    RAISE EXCEPTION 'CHECK 7 FAILED: folders created under a folder of another client';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'CHECK 7 passed — folder upload creates nested folders once (case-insensitive), refuses bad path segments';

  x1 := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',leaf,'name','Letter A.pdf','sha256',md5('x1')||md5('x1'),'bucket','crm-store','path','zz/x1','size',1,'document_type','irs_notice','published',true)))->>'file_id';
  x2 := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',sub,'name','Summary.pdf','sha256',md5('x2')||md5('x2'),'bucket','crm-store','path','zz/x2','size',1,'document_type','irs_notice','published',true)))->>'file_id';
  f_pass := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',leaf,'name','Passport Member.pdf','sha256',md5('pp')||md5('pp'),'bucket','crm-store','path','zz/pp','size',1,'document_type','passport','published',true,
             'subjects', jsonb_build_array(jsonb_build_object('kind','person','contact_id',p2,'role','concerns')))))->>'file_id';

  -- ── 6. zip listing: nested paths; a member never gets another member's personal file; staff get all
  SELECT count(*) INTO n FROM store_folder_zip_listing(sub, p1, NULL, false);
  IF n <> 2 OR NOT EXISTS (SELECT 1 FROM store_folder_zip_listing(sub, p1, NULL, false) WHERE zip_path = 'Bank letters/Letter A.pdf') THEN
    RAISE EXCEPTION 'CHECK 6 FAILED: owner zip listing wrong (% rows)', n;
  END IF;
  IF EXISTS (SELECT 1 FROM store_folder_zip_listing(sub, p1, NULL, false) WHERE file_id = f_pass) THEN RAISE EXCEPTION 'CHECK 6 FAILED: another member''s passport entered the zip'; END IF;
  IF NOT EXISTS (SELECT 1 FROM store_folder_zip_listing(sub, p2, NULL, false) WHERE file_id = f_pass) THEN RAISE EXCEPTION 'CHECK 6 FAILED: the member''s own passport missing from their zip'; END IF;
  SELECT count(*) INTO n FROM store_folder_zip_listing(sub, NULL, NULL, true);
  IF n <> 3 THEN RAISE EXCEPTION 'CHECK 6 FAILED: staff zip should hold all 3 files, got %', n; END IF;
  IF EXISTS (SELECT 1 FROM store_folder_zip_listing(sub, p1, NULL, true)) THEN RAISE EXCEPTION 'CHECK 6 FAILED: a portal viewer claimed the staff listing'; END IF;
  RAISE NOTICE 'CHECK 6 passed — zip listing keeps the folder structure, filters every file through the privacy check, staff see all';

  -- ── 1. trash a folder tree as one batch, then batch restore with " (2)" on a clash
  b1 := store_trash_folder(sub, staff, 'cleanup');
  IF (SELECT count(*) FROM store_files WHERE trash_batch_id = b1) <> 3 OR (SELECT count(*) FROM store_folders WHERE trash_batch_id = b1) <> 2 THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: batch did not take the whole tree';
  END IF;
  IF store_file_access(x1, p1, NULL) <> 'not_live' OR EXISTS (SELECT 1 FROM store_visible_files(p1, NULL, NULL) WHERE file_id = x1) THEN RAISE EXCEPTION 'CHECK 1 FAILED: trashed file still visible'; END IF;
  IF NOT EXISTS (SELECT 1 FROM store_trash_list(o_a) WHERE batch_id = b1 AND files = 3 AND folders = 2 AND top_name = '2025') THEN RAISE EXCEPTION 'CHECK 1 FAILED: trash list'; END IF;
  IF (SELECT count(*) FROM store_events WHERE event = 'trashed' AND details->>'batch_id' = b1::text AND file_id IS NOT NULL) <> 3 THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: each trashed file needs its own event';
  END IF;
  IF (SELECT purge_after FROM store_files WHERE id = x1) IS NULL THEN RAISE EXCEPTION 'CHECK 1 FAILED: no purge_after stamped at trash time'; END IF;
  BEGIN
    PERFORM store_trash_folder(sub, staff, 'second click');
    RAISE EXCEPTION 'CHECK 1 FAILED: a second trash of the same folder was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'CHECK 1 FAILED%' THEN RAISE; END IF; END;
  BEGIN
    PERFORM store_trash_folder(f_tax, staff, NULL);
    RAISE EXCEPTION 'CHECK 1 FAILED: a standard template folder was trashed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'CHECK 1 FAILED%' THEN RAISE; END IF; END;
  -- meanwhile a new "2025" folder is created in the same place
  PERFORM store_ensure_folder_path(o_a, f_corr, ARRAY['2025'], staff);
  r := store_restore_batch(b1, staff, NULL);
  SELECT name INTO nm FROM store_folders WHERE id = sub;
  IF nm <> '2025 (2)' THEN RAISE EXCEPTION 'CHECK 1 FAILED: restored folder not renamed on clash (%)', nm; END IF;
  IF (SELECT state FROM store_files WHERE id = x1) <> 'live' OR (SELECT folder_id FROM store_files WHERE id = x1) <> leaf OR store_file_access(x1, p1, NULL) <> 'ok' THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: files not back in their folders %', r;
  END IF;
  b2 := store_trash_file(x2, staff, NULL);
  x3 := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',sub,'name','summary.PDF','sha256',md5('x3')||md5('x3'),'bucket','crm-store','path','zz/x3','size',1,'document_type','irs_notice')))->>'file_id';
  r := store_restore_batch(b2, staff, NULL);
  IF (SELECT name FROM store_files WHERE id = x2) <> 'Summary (2).pdf' THEN RAISE EXCEPTION 'CHECK 1 FAILED: restored file not renamed on clash (%)', (SELECT name FROM store_files WHERE id = x2); END IF;
  IF NOT EXISTS (SELECT 1 FROM store_events WHERE event = 'restored' AND file_id = x2 AND details->>'from_name' = 'Summary.pdf') THEN RAISE EXCEPTION 'CHECK 1 FAILED: restore not recorded per file'; END IF;
  RAISE NOTICE 'CHECK 1 passed — a folder tree is trashed and restored as one batch; name clashes get " (2)"';

  -- ── 2. restore never lands in another client; a vanished original folder needs an explicit same-owner target
  b3 := store_trash_file(x3, staff, NULL);
  PERFORM store_trash_folder(sub, staff, NULL);
  BEGIN
    PERFORM store_restore_batch(b3, staff, NULL);
    RAISE EXCEPTION 'CHECK 2 FAILED: restored into a trashed folder';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM store_restore_batch(b3, staff, f_co2);
    RAISE EXCEPTION 'CHECK 2 FAILED: restored into ANOTHER client''s folder';
  EXCEPTION WHEN check_violation THEN NULL; END;
  r := store_restore_batch(b3, staff, f_corr);
  IF (SELECT folder_id FROM store_files WHERE id = x3) <> f_corr OR (SELECT state FROM store_files WHERE id = x3) <> 'live' THEN RAISE EXCEPTION 'CHECK 2 FAILED: explicit same-owner restore'; END IF;
  BEGIN
    UPDATE store_folders SET trashed_at = now() WHERE parent_id IS NULL AND owner_id = o_a;
    RAISE EXCEPTION 'CHECK 2 FAILED: a root folder was trashed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM store_rehome_subtree(sub, o_a2, f_co2, staff, 'wrong client');
    RAISE EXCEPTION 'CHECK 2 FAILED: a trashed folder was moved to another client';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'CHECK 2 passed — restore refused into a trashed folder or another client; explicit same-owner target works; root cannot be trashed';

  -- ── 10. a folder with live contents cannot be trashed around the trash function
  xa := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',f_tax,'name','1065 2023.pdf','sha256',md5('xa')||md5('xa'),'bucket','crm-store','path','zz/xa','size',1,
          'document_type','form_1065','period_year',2023,'filing_status','filed','published',true)))->>'file_id';
  BEGIN
    UPDATE store_folders SET trashed_at = now(), trash_batch_id = gen_random_uuid() WHERE id = f_tax;
    RAISE EXCEPTION 'CHECK 10 FAILED: a folder holding live files was trashed directly';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'CHECK 10 passed — trashing a folder outside the trash function is refused while it holds live items';

  -- ── 4. a FILED file can be trashed only by a named staff member, with an event
  BEGIN
    PERFORM store_trash_file(xa, NULL, NULL);
    RAISE EXCEPTION 'CHECK 4 FAILED: trashed with no staff member';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'CHECK 4 FAILED%' THEN RAISE; END IF; END;
  b1 := store_trash_file(xa, staff, 'filed in error');
  IF NOT EXISTS (SELECT 1 FROM store_events WHERE event = 'trashed' AND file_id = xa AND actor = staff AND details->>'filing_status' = 'filed') THEN RAISE EXCEPTION 'CHECK 4 FAILED: no event'; END IF;
  PERFORM store_restore_batch(b1, staff, NULL);
  RAISE NOTICE 'CHECK 4 passed — a filed file is trashed only by a named staff member, recorded with its filing status';

  -- ── 5. amendment chain A←B←C: trashing / restoring never leaves two current filings shown
  xb := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',f_tax,'name','1065 2023 amended.pdf','sha256',md5('xb')||md5('xb'),'bucket','crm-store','path','zz/xb','size',1,
          'document_type','form_1065','period_year',2023,'filing_status','amended','published',true,'supersedes_file_id',xa)))->>'file_id';
  xc := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',f_tax,'name','1065 2023 amended 2.pdf','sha256',md5('xc')||md5('xc'),'bucket','crm-store','path','zz/xc','size',1,
          'document_type','form_1065','period_year',2023,'filing_status','amended','published',true,'supersedes_file_id',xb)))->>'file_id';
  SELECT count(*) INTO n FROM (VALUES (xa),(xb),(xc)) v(id) WHERE store_file_access(v.id, p1, NULL) = 'ok';
  IF n <> 1 OR store_file_access(xc, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 5 FAILED: % shown before trash', n; END IF;
  b2 := store_trash_file(xb, staff, NULL);
  SELECT count(*) INTO n FROM (VALUES (xa),(xb),(xc)) v(id) WHERE store_file_access(v.id, p1, NULL) = 'ok';
  IF n <> 1 OR store_file_access(xc, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 5 FAILED: trashing B → % shown', n; END IF;
  b3 := store_trash_file(xc, staff, NULL);
  SELECT count(*) INTO n FROM (VALUES (xa),(xb),(xc)) v(id) WHERE store_file_access(v.id, p1, NULL) = 'ok';
  IF n <> 1 OR store_file_access(xa, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 5 FAILED: B and C trashed → % shown (original should)', n; END IF;
  PERFORM store_restore_batch(b2, staff, NULL);
  SELECT count(*) INTO n FROM (VALUES (xa),(xb),(xc)) v(id) WHERE store_file_access(v.id, p1, NULL) = 'ok';
  IF n <> 1 OR store_file_access(xb, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 5 FAILED: B restored → % shown', n; END IF;
  PERFORM store_restore_batch(b3, staff, NULL);
  SELECT count(*) INTO n FROM (VALUES (xa),(xb),(xc)) v(id) WHERE store_file_access(v.id, p1, NULL) = 'ok';
  IF n <> 1 OR store_file_access(xc, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 5 FAILED: C restored → % shown', n; END IF;
  -- trash the amendment, staff amend the original again, then restore the trashed one → skipped, never two current
  b2 := store_trash_file(xc, staff, NULL);
  b3 := store_trash_file(xb, staff, NULL);
  PERFORM store_write(jsonb_build_object('owner_id',o_a,'folder_id',f_tax,'name','1065 2023 amended again.pdf','sha256',md5('xd')||md5('xd'),'bucket','crm-store','path','zz/xd','size',1,
          'document_type','form_1065','period_year',2023,'filing_status','amended','published',true,'supersedes_file_id',xa));
  r := store_restore_batch(b3, staff, NULL);
  IF jsonb_array_length(r->'skipped') <> 1 OR (SELECT state FROM store_files WHERE id = xb) <> 'trashed' THEN RAISE EXCEPTION 'CHECK 5 FAILED: a competing amendment was restored %', r; END IF;
  SELECT count(*) INTO n FROM store_files f WHERE f.owner_id = o_a AND f.period_year = 2023 AND store_file_access(f.id, p1, NULL) = 'ok';
  IF n <> 1 THEN RAISE EXCEPTION 'CHECK 5 FAILED: % current 2023 filings shown', n; END IF;
  BEGIN
    PERFORM store_write(jsonb_build_object('owner_id',o_a,'folder_id',f_tax,'name','branch.pdf','sha256',md5('br')||md5('br'),'bucket','crm-store','path','zz/br','size',1,
            'document_type','form_1065','period_year',2023,'supersedes_file_id',xa));
    RAISE EXCEPTION 'CHECK 5 FAILED: a second live amendment of the same original was accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'CHECK 5 FAILED%' THEN RAISE; END IF; END;
  RAISE NOTICE 'CHECK 5 passed — A←B←C shows one current filing in any trash/restore order; a competing amendment is never restored or created';

  -- ── 3. "go back a stage" leaves the file and its visibility; "remove from view" is not trash
  f_link := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',f_tax,'name','Receipt.pdf','sha256',md5('rc')||md5('rc'),'bucket','crm-store','path','zz/rc','size',1,
             'document_type','irs_notice','links', jsonb_build_array(jsonb_build_object('kind','service_case','record_id',sd)))))->>'file_id';
  IF store_file_access(f_link, p1, NULL) <> 'ok' THEN RAISE EXCEPTION 'CHECK 3 FAILED: safe-stage file not shown'; END IF;
  UPDATE service_deliveries SET stage = 'Tax Return Prepared' WHERE id = sd;          -- staff go back a stage
  IF store_file_access(f_link, p1, NULL) <> 'ok' OR NOT EXISTS (SELECT 1 FROM store_record_links WHERE file_id = f_link) THEN RAISE EXCEPTION 'CHECK 3 FAILED: going back a stage changed the file'; END IF;
  IF NOT store_remove_link(f_link, 'service_case', sd, staff, 'wrong case') THEN RAISE EXCEPTION 'CHECK 3 FAILED: remove from view'; END IF;
  IF (SELECT state FROM store_files WHERE id = f_link) <> 'live' OR store_file_access(f_link, p1, NULL) <> 'ok'
     OR EXISTS (SELECT 1 FROM store_record_links WHERE file_id = f_link)
     OR NOT EXISTS (SELECT 1 FROM store_events WHERE event = 'link_removed' AND file_id = f_link) THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: remove-from-view acted like a trash (or left no record)';
  END IF;
  RAISE NOTICE 'CHECK 3 passed — going back a stage changes nothing; "remove from view" only drops that link (logged), the file stays';

  -- ── 8. the purge (time-travelled inside this proof only): not early, tombstone + history kept, links released
  PERFORM set_config('store.purge_clock_test', 'on', true);
  f_filed := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',f_corr,'name','Old notice.pdf','sha256',md5('on')||md5('on'),'bucket','crm-store','path','zz/on','size',1,
              'document_type','irs_notice','links', jsonb_build_array(jsonb_build_object('kind','service_case','record_id',sd)),
              'subjects', jsonb_build_array(jsonb_build_object('kind','person','contact_id',p1,'role','concerns')))))->>'file_id';
  b1 := store_trash_file(f_filed, staff, NULL);
  IF (store_purge_file(f_filed, now()))->>'status' <> 'not_due' THEN RAISE EXCEPTION 'CHECK 8 FAILED: purged before the trash window ended'; END IF;
  IF EXISTS (SELECT 1 FROM store_purge_due(now(), 1000) WHERE file_id = f_filed)
     OR NOT EXISTS (SELECT 1 FROM store_purge_due(now() + interval '91 days', 1000) WHERE file_id = f_filed) THEN RAISE EXCEPTION 'CHECK 8 FAILED: due list'; END IF;
  r := store_purge_file(f_filed, now() + interval '91 days');
  IF r->>'status' <> 'purged' OR jsonb_array_length(r->'objects') <> 1 THEN RAISE EXCEPTION 'CHECK 8 FAILED: %', r; END IF;
  IF (SELECT state FROM store_files WHERE id = f_filed) <> 'purged' OR NOT EXISTS (SELECT 1 FROM store_file_versions WHERE file_id = f_filed)
     OR (SELECT count(*) FROM store_events WHERE file_id = f_filed) < 3 THEN RAISE EXCEPTION 'CHECK 8 FAILED: tombstone / history not kept'; END IF;
  IF EXISTS (SELECT 1 FROM store_record_links WHERE file_id = f_filed) OR EXISTS (SELECT 1 FROM store_file_subjects WHERE file_id = f_filed)
     OR (SELECT jsonb_array_length(details->'kept'->'links') FROM store_events WHERE event = 'purged' AND file_id = f_filed) <> 1 THEN
    RAISE EXCEPTION 'CHECK 8 FAILED: links not moved into the history';
  END IF;
  BEGIN
    PERFORM store_restore_batch(b1, staff, NULL);
    RAISE EXCEPTION 'CHECK 8 FAILED: a fully purged batch could be restored';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'CHECK 8 FAILED%' THEN RAISE; END IF; END;
  IF (store_purge_file(f_filed, now() + interval '92 days'))->>'status' <> 'already_purged' THEN RAISE EXCEPTION 'CHECK 8 FAILED: purge not idempotent'; END IF;
  BEGIN
    UPDATE store_files SET name = 'x' WHERE id = f_filed;
    RAISE EXCEPTION 'CHECK 8 FAILED: a tombstone was edited';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- without the proof flag, a caller's future clock is ignored
  PERFORM set_config('store.purge_clock_test', 'off', true);
  f_link := (store_write(jsonb_build_object('owner_id',o_a,'folder_id',f_corr,'name','Another notice.pdf','sha256',md5('an')||md5('an'),'bucket','crm-store','path','zz/an','size',1,'document_type','irs_notice')))->>'file_id';
  PERFORM store_trash_file(f_link, staff, NULL);
  IF (store_purge_file(f_link, now() + interval '1000 days'))->>'status' <> 'not_due' THEN RAISE EXCEPTION 'CHECK 8 FAILED: a caller-supplied future clock purged a file'; END IF;
  RAISE NOTICE 'CHECK 8 passed — purge only after the window; tombstone, versions and history kept; links moved into history; a purged batch cannot be restored; a caller cannot fake the clock';

  -- ── 9. the window can never be shortened for what is already in the trash, and never below 90 days
  UPDATE catalog_entries SET metadata = jsonb_set(metadata, '{trash_days}', '7') WHERE catalog_id = 'storage_settings' AND slug = 'trash';
  IF store_trash_days() <> 90 THEN RAISE EXCEPTION 'CHECK 9 FAILED: trash window went below 90 days'; END IF;
  UPDATE catalog_entries SET metadata = jsonb_set(metadata, '{trash_days}', '"ninety"') WHERE catalog_id = 'storage_settings' AND slug = 'trash';
  IF store_trash_days() <> 90 THEN RAISE EXCEPTION 'CHECK 9 FAILED: a bad window value broke the setting'; END IF;
  UPDATE catalog_entries SET metadata = jsonb_set(metadata, '{trash_days}', '120') WHERE catalog_id = 'storage_settings' AND slug = 'trash';
  IF (SELECT purge_after FROM store_files WHERE id = f_link) > now() + interval '91 days' THEN RAISE EXCEPTION 'CHECK 9 FAILED: a settings edit moved an existing purge date'; END IF;
  UPDATE catalog_entries SET metadata = jsonb_set(metadata, '{trash_days}', '90') WHERE catalog_id = 'storage_settings' AND slug = 'trash';
  IF EXISTS (SELECT 1 FROM store_trash_list(o_a) WHERE batch_id = b1) THEN RAISE EXCEPTION 'CHECK 9 FAILED: a fully purged batch still listed'; END IF;
  RAISE NOTICE 'CHECK 9 passed — the trash window is fixed per item when trashed, never under 90 days, bad values fall back; purged batches leave the list';

  -- ── 11. legal holds (#61): ITIN papers 3 years, filed tax returns forever — trashed, restorable, never purged while held
  PERFORM set_config('store.purge_clock_test', 'on', true);
  x1 := (store_write(jsonb_build_object('owner_id',o_p2,'folder_id',fp2,'name','W-7 Member.pdf','sha256',md5('w7')||md5('w7'),'bucket','crm-store','path','zz/w7','size',1,
          'document_type','form_w_7','period_year',extract(year FROM now())::int)))->>'file_id';
  SELECT id INTO sub2 FROM store_folders WHERE owner_id = o_p2 AND kind = 'itin';
  x2 := (store_write(jsonb_build_object('owner_id',o_p2,'folder_id',sub2,'name','Passport for ITIN.pdf','sha256',md5('pi')||md5('pi'),'bucket','crm-store','path','zz/pi','size',1,'document_type','passport')))->>'file_id';
  x3 := (store_write(jsonb_build_object('owner_id',o_p2,'folder_id',fp2,'name','Passport (personal).pdf','sha256',md5('pq')||md5('pq'),'bucket','crm-store','path','zz/pq','size',1,'document_type','passport')))->>'file_id';
  PERFORM store_trash_file(x1, staff, NULL); PERFORM store_trash_file(x2, staff, NULL); PERFORM store_trash_file(x3, staff, NULL);
  PERFORM store_trash_file(xa, staff, NULL);   -- the filed 1065 2023
  IF (store_purge_file(x1, now() + interval '91 days'))->>'hold' <> 'itin_application' THEN RAISE EXCEPTION 'CHECK 11 FAILED: W-7 not held'; END IF;
  IF (store_purge_file(x2, now() + interval '91 days'))->>'hold' <> 'itin_identity' THEN RAISE EXCEPTION 'CHECK 11 FAILED: ITIN passport not held'; END IF;
  IF (store_purge_file(xa, now() + interval '20 years'))->>'hold' <> 'filed_tax_returns' THEN RAISE EXCEPTION 'CHECK 11 FAILED: filed return not held forever'; END IF;
  IF (store_purge_file(x3, now() + interval '91 days'))->>'status' <> 'purged' THEN RAISE EXCEPTION 'CHECK 11 FAILED: an ordinary passport should still follow the 90 days'; END IF;
  IF (store_purge_file(x1, now() + interval '5 years'))->>'status' <> 'purged' THEN RAISE EXCEPTION 'CHECK 11 FAILED: the W-7 hold never ends'; END IF;
  IF EXISTS (SELECT 1 FROM store_purge_due(now() + interval '91 days', 1000) WHERE file_id IN (x2, xa)) THEN RAISE EXCEPTION 'CHECK 11 FAILED: held files listed as due'; END IF;
  IF NOT EXISTS (SELECT 1 FROM store_trash_list(o_a) WHERE held_files >= 1) THEN RAISE EXCEPTION 'CHECK 11 FAILED: the trash list does not show held files'; END IF;
  RAISE NOTICE 'CHECK 11 passed — W-7s and ITIN IDs held for 3 years, filed returns forever; ordinary files still follow the 90 days';

  RAISE NOTICE 'ALL S4 CHECKS PASSED (fixtures rolled back)';
END $$;

ROLLBACK;
