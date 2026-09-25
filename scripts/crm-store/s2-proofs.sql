-- CRM Store — slice S2 proofs for the one write step (master plan v4.4 §8.9 slice 2).
-- Throwaway fixtures inside a transaction, ROLLED BACK at the end. Any failed check raises.
-- The storage-level proofs (real bytes, 18 MB + large file, staged upload, Drive guard) are in
-- scripts/crm-store/s2-proofs.ts.

BEGIN;

DO $$
DECLARE
  a1 uuid; a2 uuid; p1 uuid; p2 uuid; o1 uuid; o2 uuid; op1 uuid; op2 uuid;
  f1 uuid; f2 uuid; fp1 uuid; fp2 uuid; sd uuid;
  r jsonb; r2 jsonb; fid uuid; n int;
  sha_a text := repeat('a', 64); sha_b text := repeat('b', 64); sha_c text := repeat('c', 64);
  base jsonb;
BEGIN
  INSERT INTO accounts (company_name, status) VALUES ('ZZ S2 Co One', 'Active') RETURNING id INTO a1;
  INSERT INTO accounts (company_name, status) VALUES ('ZZ S2 Co Two', 'Active') RETURNING id INTO a2;
  INSERT INTO contacts (full_name) VALUES ('ZZ S2 Person A') RETURNING id INTO p1;
  INSERT INTO contacts (full_name) VALUES ('ZZ S2 Person B') RETURNING id INTO p2;
  INSERT INTO service_deliveries (service_name, service_type, account_id, status) VALUES ('Tax', 'Tax Return', a1, 'active') RETURNING id INTO sd;
  o1 := store_ensure_owner('company', a1); PERFORM store_apply_template(o1, 'company_standard', 'ZZ S2 Co One');
  o2 := store_ensure_owner('company', a2); PERFORM store_apply_template(o2, 'company_standard', 'ZZ S2 Co Two');
  op1 := store_ensure_owner('person', p1); PERFORM store_apply_template(op1, 'person_standard', 'ZZ S2 Person A');
  op2 := store_ensure_owner('person', p2); PERFORM store_apply_template(op2, 'person_standard', 'ZZ S2 Person B');
  SELECT id INTO f1 FROM store_folders WHERE owner_id = o1 AND kind = 'tax';
  SELECT id INTO f2 FROM store_folders WHERE owner_id = o2 AND kind = 'tax';
  SELECT id INTO fp1 FROM store_folders WHERE owner_id = op1 AND kind = 'personal';
  SELECT id INTO fp2 FROM store_folders WHERE owner_id = op2 AND kind = 'personal';

  base := jsonb_build_object('owner_id', o1, 'folder_id', f1, 'name', '1065 2025.pdf', 'bucket', 'crm-store', 'size', 10, 'mime', 'application/pdf');

  -- 1. created, with links/subjects/facts in the same step
  r := store_write(base || jsonb_build_object('caller_key','zz-s2:tax:1:0','path','zz/1','sha256',sha_a,'document_type','form_1065','period_year',2025,
        'links', jsonb_build_array(jsonb_build_object('kind','service_case','record_id',sd,'stage','Tax Return Prepared')),
        'subjects', jsonb_build_array(jsonb_build_object('kind','person','contact_id',p1,'role','owner_member')),
        'facts', jsonb_build_array(jsonb_build_object('key','tax_year','value','2025'))));
  IF r->>'status' <> 'created' THEN RAISE EXCEPTION 'CHECK 1 FAILED: %', r; END IF;
  fid := (r->>'file_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM store_record_links WHERE file_id = fid AND record_id = sd AND stage_at_creation = 'Tax Return Prepared')
     OR NOT EXISTS (SELECT 1 FROM store_file_subjects WHERE file_id = fid AND contact_id = p1)
     OR NOT EXISTS (SELECT 1 FROM store_file_facts WHERE file_id = fid AND key = 'tax_year') THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: links/subjects/facts not written with the save';
  END IF;
  RAISE NOTICE 'CHECK 1 passed — new file created with its service-case link, subject and fact in one step';

  -- 2. same bytes again (a retry) → unchanged; links stay single (idempotent)
  r := store_write(base || jsonb_build_object('caller_key','zz-s2:tax:1:0','path','zz/1b','sha256',sha_a,
        'links', jsonb_build_array(jsonb_build_object('kind','service_case','record_id',sd,'stage','Tax Return Prepared'))));
  IF r->>'status' <> 'unchanged' THEN RAISE EXCEPTION 'CHECK 2 FAILED: %', r; END IF;
  SELECT count(*) INTO n FROM store_record_links WHERE file_id = fid;
  IF n <> 1 THEN RAISE EXCEPTION 'CHECK 2 FAILED: % links', n; END IF;
  RAISE NOTICE 'CHECK 2 passed — a retry with the same bytes is "already saved", links not duplicated';

  -- 3. different bytes, same identity → new version; staff correction of type/year is NOT overwritten
  UPDATE store_files SET document_type = 'tax_return', period_year = 2024 WHERE id = fid;   -- staff correction
  r := store_write(base || jsonb_build_object('caller_key','zz-s2:tax:1:0','path','zz/2','sha256',sha_b,'document_type','form_1065','period_year',2025));
  IF r->>'status' <> 'versioned' THEN RAISE EXCEPTION 'CHECK 3 FAILED: %', r; END IF;
  IF (SELECT document_type FROM store_files WHERE id = fid) <> 'tax_return' OR (SELECT period_year FROM store_files WHERE id = fid) <> 2024 THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: staff correction overwritten';
  END IF;
  RAISE NOTICE 'CHECK 3 passed — new bytes become version 2; staff corrections survive';

  -- 4. re-render with no meaningful change → unchanged (no runaway versions)
  r := store_write(base || jsonb_build_object('caller_key','zz-s2:tax:1:0','path','zz/3','sha256',sha_c,'content_changed',false));
  IF r->>'status' <> 'unchanged' THEN RAISE EXCEPTION 'CHECK 4 FAILED: %', r; END IF;
  SELECT count(*) INTO n FROM store_file_versions WHERE file_id = fid;
  IF n <> 2 THEN RAISE EXCEPTION 'CHECK 4 FAILED: % versions', n; END IF;
  RAISE NOTICE 'CHECK 4 passed — a re-render with no real change adds no version';

  -- 5. same bytes + "filed" → the file is marked filed (forward move); then different bytes → frozen
  r := store_write(base || jsonb_build_object('caller_key','zz-s2:tax:1:0','path','zz/4','sha256',sha_b,'filing_status','filed'));
  IF r->>'status' <> 'unchanged' OR (SELECT filing_status FROM store_files WHERE id = fid) <> 'filed' THEN RAISE EXCEPTION 'CHECK 5 FAILED: not marked filed %', r; END IF;
  r := store_write(base || jsonb_build_object('caller_key','zz-s2:tax:1:0','path','zz/5','sha256',sha_c));
  IF r->>'status' <> 'frozen' THEN RAISE EXCEPTION 'CHECK 5 FAILED: filed file took new bytes %', r; END IF;
  r := store_write(base || jsonb_build_object('caller_key','zz-s2:tax:1:0','path','zz/6','sha256',sha_b));
  IF r->>'status' <> 'unchanged' THEN RAISE EXCEPTION 'CHECK 5 FAILED: identical retry after filing not "done" %', r; END IF;
  r := store_write(base || jsonb_build_object('caller_key','zz-s2:tax:1:0','path','zz/7','sha256',sha_c,'content_changed',false));
  IF r->>'status' <> 'unchanged' THEN RAISE EXCEPTION 'CHECK 5 FAILED: re-render of a filed file raised an alarm %', r; END IF;
  r := store_write(base || jsonb_build_object('caller_key','zz-s2:tax:1:0','path','zz/8','sha256',sha_b,'filing_status','draft'));
  IF (SELECT filing_status FROM store_files WHERE id = fid) <> 'filed' THEN RAISE EXCEPTION 'CHECK 5 FAILED: filed downgraded'; END IF;
  -- an amended return is a NEW file (its own identity), the original stays
  r := store_write(base || jsonb_build_object('caller_key','zz-s2:tax:1:amended','path','zz/9','sha256',sha_c,'filing_status','amended'));
  IF r->>'status' <> 'created' OR (r->>'name') <> '1065 2025 (2).pdf' THEN RAISE EXCEPTION 'CHECK 5 FAILED: amended %', r; END IF;
  RAISE NOTICE 'CHECK 5 passed — filing locks; new bytes refused; identical retry and re-render are "done"; no downgrade; amended = new file, original kept';

  -- 6. same passport bytes for two different people → two files, each with its owner
  r  := store_write(jsonb_build_object('owner_id',op1,'folder_id',fp1,'name','Passport.pdf','caller_key','zz-s2:passport:A','bucket','crm-store','path','zz/pa','sha256',sha_a,'size',10));
  r2 := store_write(jsonb_build_object('owner_id',op2,'folder_id',fp2,'name','Passport.pdf','caller_key','zz-s2:passport:B','bucket','crm-store','path','zz/pb','sha256',sha_a,'size',10));
  IF r->>'status' <> 'created' OR r2->>'status' <> 'created' OR r->>'file_id' = r2->>'file_id' THEN RAISE EXCEPTION 'CHECK 6 FAILED: % %', r, r2; END IF;
  RAISE NOTICE 'CHECK 6 passed — identical bytes for two people are two separate files';

  -- 7. two uploads in one form slot (different keys) → two files, second auto-suffixed
  r  := store_write(jsonb_build_object('owner_id',o2,'folder_id',f2,'name','Statement.pdf','caller_key','zz-s2:wizard:9:bank:0','bucket','crm-store','path','zz/s0','sha256',sha_a,'size',10));
  r2 := store_write(jsonb_build_object('owner_id',o2,'folder_id',f2,'name','statement.PDF','caller_key','zz-s2:wizard:9:bank:1','bucket','crm-store','path','zz/s1','sha256',sha_b,'size',10));
  IF r2->>'status' <> 'created' OR (r2->>'name') <> 'statement (2).PDF' THEN RAISE EXCEPTION 'CHECK 7 FAILED: %', r2; END IF;
  RAISE NOTICE 'CHECK 7 passed — two uploads are two files; a case-insensitive name clash gets " (2)"';

  -- 8. identity wins across owners: a re-homed file is versioned where it now lives
  PERFORM store_rehome_file((r->>'file_id')::uuid, f1, NULL, 'misfiled: belongs to Co One');
  r2 := store_write(jsonb_build_object('owner_id',o2,'folder_id',f2,'name','Statement.pdf','caller_key','zz-s2:wizard:9:bank:0','bucket','crm-store','path','zz/s0b','sha256',sha_c,'size',10));
  IF r2->>'status' <> 'versioned' OR (SELECT owner_id FROM store_files WHERE id = (r->>'file_id')::uuid) <> o1 THEN
    RAISE EXCEPTION 'CHECK 8 FAILED: misfile came back %', r2;
  END IF;
  RAISE NOTICE 'CHECK 8 passed — after a re-home, a re-save versions the file where it now lives (no duplicate misfile)';

  -- 9. trashed file → the flow gets a quiet "trashed", not an error storm
  UPDATE store_files SET state = 'trashed', trashed_at = now() WHERE id = (r->>'file_id')::uuid;
  r2 := store_write(jsonb_build_object('owner_id',o1,'folder_id',f1,'name','Statement.pdf','caller_key','zz-s2:wizard:9:bank:0','bucket','crm-store','path','zz/s0c','sha256',sha_a,'size',10));
  IF r2->>'status' <> 'trashed' THEN RAISE EXCEPTION 'CHECK 9 FAILED: %', r2; END IF;
  RAISE NOTICE 'CHECK 9 passed — saving into a trashed file is a quiet no-op';

  -- 10. a long name never breaks the 255 limit when suffixed
  r  := store_write(jsonb_build_object('owner_id',o2,'folder_id',f2,'name',repeat('x',250)||'.pdf','caller_key',NULL,'bucket','crm-store','path','zz/l0','sha256',sha_a,'size',10));
  r2 := store_write(jsonb_build_object('owner_id',o2,'folder_id',f2,'name',repeat('x',250)||'.pdf','caller_key',NULL,'bucket','crm-store','path','zz/l1','sha256',sha_a,'size',10));
  IF length(r2->>'name') > 255 OR r2->>'name' NOT LIKE '% (2).pdf' THEN RAISE EXCEPTION 'CHECK 10 FAILED: %', r2->>'name'; END IF;
  RAISE NOTICE 'CHECK 10 passed — a no-identity save is always a new file; long names are trimmed to fit the suffix';

  RAISE NOTICE 'ALL S2 WRITE-STEP CHECKS PASSED (fixtures rolled back)';
END $$;

ROLLBACK;
