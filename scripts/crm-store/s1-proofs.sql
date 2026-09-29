-- CRM Store — slice S1 proofs (master plan v4.4 §8.9, slice 1).
-- Runs every S1 pass/fail check against the applied schema using THROWAWAY fixtures
-- created inside this transaction, then ROLLS BACK: nothing is left behind and no real
-- client record is touched. Any failed check raises and aborts with the check's name.
-- Run in the sandbox SQL editor (or psql) AFTER 20260924-2300-crm-store-foundation-s1.sql.

BEGIN;

DO $$
DECLARE
  a1 uuid; a2 uuid; a3 uuid; p1 uuid; p2 uuid; pc uuid;
  sd1 uuid; sd2 uuid; sd3 uuid;
  o_a1 uuid; o_a2 uuid; o_p1 uuid; o_f1 uuid; o_f2 uuid; o_f3 uuid; o_unf uuid; o_again uuid;
  r_a1 uuid; r_a2 uuid; r_f1 uuid; r_unf uuid;
  f_company uuid; f_tax uuid; f_a2company uuid; f_x uuid;
  file1 uuid; v1 uuid; v2 uuid; file_unf uuid;
  n int; ok boolean;
BEGIN
  -- ── fixtures (fake names, rolled back at the end)
  INSERT INTO accounts (company_name, status, entity_type) VALUES ('ZZ S1 Proof Co', 'Active', 'Single Member LLC') RETURNING id INTO a1;
  INSERT INTO accounts (company_name, status, entity_type) VALUES ('ZZ S1 Proof Co', 'Active', 'Multi Member LLC') RETURNING id INTO a2;  -- same name on purpose
  INSERT INTO contacts (full_name) VALUES ('ZZ S1 Person One') RETURNING id INTO p1;
  INSERT INTO contacts (full_name) VALUES ('ZZ S1 Person Two') RETURNING id INTO p2;
  INSERT INTO contacts (full_name) VALUES ('ZZ S1 Consultant') RETURNING id INTO pc;
  INSERT INTO account_contacts (account_id, contact_id, role) VALUES (a1, p1, 'Sole  Member');           -- SMLLC owner, no members row
  INSERT INTO account_contacts (account_id, contact_id, role) VALUES (a2, p1, 'Member');
  INSERT INTO account_contacts (account_id, contact_id, role) VALUES (a2, p2, 'owner');
  INSERT INTO account_contacts (account_id, contact_id, role) VALUES (a2, pc, 'Partner - Tax/NHR Consultant (Portugal)');

  -- ── 1. two companies with the same name get separate owners and separate roots
  o_a1 := store_ensure_owner('company', a1);
  o_a2 := store_ensure_owner('company', a2);
  IF o_a1 = o_a2 THEN RAISE EXCEPTION 'CHECK 1 FAILED: same-name companies share an owner'; END IF;
  r_a1 := store_apply_template(o_a1, 'company_standard', 'ZZ S1 Proof Co');
  r_a2 := store_apply_template(o_a2, 'company_standard', 'ZZ S1 Proof Co');
  IF r_a1 = r_a2 THEN RAISE EXCEPTION 'CHECK 1 FAILED: same-name companies share a root'; END IF;
  SELECT count(*) INTO n FROM store_folders WHERE owner_id = o_a1;
  IF n <> 6 THEN RAISE EXCEPTION 'CHECK 1 FAILED: expected root + 5 folders, got %', n; END IF;
  IF store_ensure_owner('company', a1) <> o_a1 THEN RAISE EXCEPTION 'CHECK 1 FAILED: ensure_owner not idempotent'; END IF;
  PERFORM store_apply_template(o_a1, 'company_standard', 'ZZ S1 Proof Co');
  SELECT count(*) INTO n FROM store_folders WHERE owner_id = o_a1;
  IF n <> 6 THEN RAISE EXCEPTION 'CHECK 1 FAILED: template not idempotent (%)', n; END IF;
  RAISE NOTICE 'CHECK 1 passed — same-name companies stay separate; owner + template idempotent';

  -- ── 2. one person in two companies (incl. an SMLLC owner with no members row): stored once, in both Contacts views
  o_p1 := store_ensure_owner('person', p1);
  PERFORM store_apply_template(o_p1, 'person_standard', 'ZZ S1 Person One');
  IF store_ensure_owner('person', p1) <> o_p1 THEN RAISE EXCEPTION 'CHECK 2 FAILED: second person owner created'; END IF;
  IF NOT EXISTS (SELECT 1 FROM store_company_contacts(a1) WHERE contact_id = p1 AND role_slug = 'owner') THEN
    RAISE EXCEPTION 'CHECK 2 FAILED: SMLLC owner ("Sole  Member") missing from Contacts view';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM store_company_contacts(a2) WHERE contact_id = p1 AND role_slug = 'member') THEN
    RAISE EXCEPTION 'CHECK 2 FAILED: member missing from second company Contacts view';
  END IF;
  SELECT count(*) INTO n FROM store_owners WHERE contact_id = p1;
  IF n <> 1 THEN RAISE EXCEPTION 'CHECK 2 FAILED: person stored % times', n; END IF;
  IF (SELECT (metadata->>'shown_through_company')::boolean FROM catalog_entries WHERE catalog_id='storage_folder_kinds' AND slug='itin') IS DISTINCT FROM false
     OR (SELECT (metadata->>'shown_through_company')::boolean FROM catalog_entries WHERE catalog_id='storage_folder_kinds' AND slug='person_tax') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'CHECK 2 FAILED: ITIN / personal tax folders are marked as shown through a company';
  END IF;
  RAISE NOTICE 'CHECK 2 passed — one personal folder, visible in both companies'' Contacts views; ITIN/personal tax never shown through a company';

  -- ── 3. a consultant linked to a company does NOT appear in Contacts (and is reported as unmatched)
  IF EXISTS (SELECT 1 FROM store_company_contacts(a2) WHERE contact_id = pc) THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: consultant appears in Contacts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM store_unmatched_contact_roles() WHERE raw_role = 'Partner - Tax/NHR Consultant (Portugal)') THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: unmatched role not reported';
  END IF;
  -- a single role-less link counts as the owner
  INSERT INTO accounts (company_name, status) VALUES ('ZZ S1 No Role Co', 'Active') RETURNING id INTO a3;
  INSERT INTO account_contacts (account_id, contact_id, role) VALUES (a3, p2, NULL);
  IF NOT EXISTS (SELECT 1 FROM store_company_contacts(a3) WHERE contact_id = p2 AND role_slug = 'owner') THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: role-less single link not treated as owner';
  END IF;
  -- an ended link disappears
  UPDATE account_contacts SET ended_at = now() WHERE account_id = a3 AND contact_id = p2;
  IF EXISTS (SELECT 1 FROM store_company_contacts(a3)) THEN RAISE EXCEPTION 'CHECK 3 FAILED: ended link still in Contacts'; END IF;
  RAISE NOTICE 'CHECK 3 passed — consultant excluded and reported; role-less single link = owner; ended link removed';

  -- ── 4. an Unfiled file is classified and re-homed to its client (one logged step)
  o_unf := store_ensure_owner('unfiled', NULL);
  IF store_ensure_owner('unfiled', NULL) <> o_unf THEN RAISE EXCEPTION 'CHECK 4 FAILED: two Unfiled owners'; END IF;
  r_unf := store_apply_template(o_unf, 'unfiled_standard', 'Unfiled');
  INSERT INTO store_files (owner_id, folder_id, name) VALUES (o_unf, r_unf, 'IRS letter scan.pdf') RETURNING id INTO file_unf;
  SELECT id INTO f_x FROM store_folders WHERE owner_id = o_a1 AND kind = 'correspondence';
  PERFORM store_rehome_file(file_unf, f_x, NULL, 'classified: IRS notice for this company');
  IF (SELECT owner_id FROM store_files WHERE id = file_unf) <> o_a1 THEN RAISE EXCEPTION 'CHECK 4 FAILED: file not re-homed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM store_events WHERE file_id = file_unf AND event = 'rehomed') THEN RAISE EXCEPTION 'CHECK 4 FAILED: re-home not logged'; END IF;
  RAISE NOTICE 'CHECK 4 passed — Unfiled file re-homed with a logged event';

  -- ── 5. formation: company-in-formation owner, files before Articles, attach in place, re-run no-op
  INSERT INTO service_deliveries (service_name, service_type, contact_id, status) VALUES ('Formation', 'Company Formation', p2, 'active') RETURNING id INTO sd1;
  o_f1 := store_ensure_owner('formation', sd1);
  r_f1 := store_apply_template(o_f1, 'company_standard', 'ZZ S1 New Co (in formation)');
  SELECT id INTO f_company FROM store_folders WHERE owner_id = o_f1 AND kind = 'company';
  INSERT INTO store_files (owner_id, folder_id, name, document_type) VALUES (o_f1, f_company, 'Articles of Organization.pdf', 'articles_of_organization') RETURNING id INTO file1;
  -- Articles create the company; the create-company step links the case
  INSERT INTO accounts (company_name, status, entity_type) VALUES ('ZZ S1 New Co LLC', 'Active', 'Single Member LLC') RETURNING id INTO a3;
  UPDATE service_deliveries SET account_id = a3 WHERE id = sd1;
  o_again := store_attach_formation(sd1, a3, NULL, 'ZZ S1 New Co LLC');
  IF o_again <> o_f1 THEN RAISE EXCEPTION 'CHECK 5 FAILED: attach created a different owner'; END IF;
  IF (SELECT kind FROM store_owners WHERE id = o_f1) <> 'company' OR (SELECT account_id FROM store_owners WHERE id = o_f1) <> a3 THEN
    RAISE EXCEPTION 'CHECK 5 FAILED: owner not converted in place';
  END IF;
  IF (SELECT owner_id FROM store_files WHERE id = file1) <> o_f1 THEN RAISE EXCEPTION 'CHECK 5 FAILED: Articles moved'; END IF;
  IF (SELECT name FROM store_folders WHERE id = r_f1) <> 'ZZ S1 New Co LLC' THEN RAISE EXCEPTION 'CHECK 5 FAILED: root not renamed'; END IF;
  IF store_attach_formation(sd1, a3) <> o_f1 THEN RAISE EXCEPTION 'CHECK 5 FAILED: re-run not a no-op'; END IF;
  IF store_ensure_owner('company', a3) <> o_f1 THEN RAISE EXCEPTION 'CHECK 5 FAILED: company ensure did not find the attached owner'; END IF;
  SELECT count(*) INTO n FROM store_folders WHERE owner_id = o_f1;
  IF n <> 6 THEN RAISE EXCEPTION 'CHECK 5 FAILED: second template created (% folders)', n; END IF;
  -- a returning client's second formation gets its own owner
  INSERT INTO service_deliveries (service_name, service_type, contact_id, status) VALUES ('Formation', 'Company Formation', p2, 'active') RETURNING id INTO sd2;
  o_f2 := store_ensure_owner('formation', sd2);
  IF o_f2 = o_f1 THEN RAISE EXCEPTION 'CHECK 5 FAILED: second formation reused the first owner'; END IF;
  -- company ensure auto-attaches an in-formation owner once the case is linked (no stranded files)
  INSERT INTO accounts (company_name, status) VALUES ('ZZ S1 Second Co LLC', 'Active') RETURNING id INTO a1;
  UPDATE service_deliveries SET account_id = a1 WHERE id = sd2;
  IF store_ensure_owner('company', a1) <> o_f2 THEN RAISE EXCEPTION 'CHECK 5 FAILED: company ensure did not attach the formation owner'; END IF;
  -- a cancelled formation cannot be attached
  INSERT INTO service_deliveries (service_name, service_type, contact_id, status) VALUES ('Formation', 'Company Formation', p1, 'cancelled') RETURNING id INTO sd3;
  o_f3 := store_ensure_owner('formation', sd3);
  UPDATE store_owners SET lifecycle_override = 'archived' WHERE id = o_f3;
  BEGIN
    PERFORM store_attach_formation(sd3, a2);
    RAISE EXCEPTION 'CHECK 5 FAILED: cancelled formation was attached';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'CHECK 5 FAILED%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'CHECK 5 passed — formation owner from payment, attached in place at Articles, re-run no-op, one owner per purchase, cancelled refused';

  -- ── 7. a move to another owner is refused (except through the logged re-home)
  SELECT id INTO f_a2company FROM store_folders WHERE owner_id = o_a2 AND kind = 'company';
  BEGIN
    UPDATE store_files SET folder_id = f_a2company WHERE id = file1;
    RAISE EXCEPTION 'CHECK 7 FAILED: file moved into another owner''s folder';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 7 FAILED%' THEN RAISE; END IF; END;
  BEGIN
    UPDATE store_files SET owner_id = o_a2, folder_id = f_a2company WHERE id = file1;
    RAISE EXCEPTION 'CHECK 7 FAILED: file owner changed directly';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 7 FAILED%' THEN RAISE; END IF; END;
  SELECT id INTO f_tax FROM store_folders WHERE owner_id = o_f1 AND kind = 'tax';
  BEGIN
    UPDATE store_folders SET parent_id = r_a2 WHERE id = f_tax;
    RAISE EXCEPTION 'CHECK 7 FAILED: folder moved under another owner';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 7 FAILED%' THEN RAISE; END IF; END;
  -- loop refused
  INSERT INTO store_folders (owner_id, parent_id, kind, name) VALUES (o_f1, f_tax, 'tax_year', '2025') RETURNING id INTO f_x;
  BEGIN
    UPDATE store_folders SET parent_id = f_x WHERE id = f_tax;
    RAISE EXCEPTION 'CHECK 7 FAILED: folder loop allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 7 FAILED%' THEN RAISE; END IF; END;
  RAISE NOTICE 'CHECK 7 passed — cross-owner moves and loops refused';

  -- ── 8. nothing cascades; nothing is deleted
  BEGIN
    DELETE FROM store_folders WHERE id = f_x;
    RAISE EXCEPTION 'CHECK 8 FAILED: folder deleted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 8 FAILED%' THEN RAISE; END IF; END;
  BEGIN
    DELETE FROM store_files WHERE id = file1;
    RAISE EXCEPTION 'CHECK 8 FAILED: file deleted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 8 FAILED%' THEN RAISE; END IF; END;
  BEGIN
    DELETE FROM service_deliveries WHERE id = sd2;
    RAISE EXCEPTION 'CHECK 8 FAILED: service case with stored documents deleted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'CHECK 8 FAILED%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'This record has stored documents%' THEN RAISE EXCEPTION 'CHECK 8 FAILED: unfriendly refusal: %', SQLERRM; END IF;
  END;
  BEGIN
    DELETE FROM contacts WHERE id = p1;
    RAISE EXCEPTION 'CHECK 8 FAILED: contact with a personal folder deleted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 8 FAILED%' THEN RAISE; END IF; END;
  RAISE NOTICE 'CHECK 8 passed — no deletes, no cascades, friendly refusal on linked service cases';

  -- ── 9. a new folder type + template change, added as data, appears on the next company (no deploy)
  INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata)
  VALUES ('storage_folder_kinds', 'zz_s1_legal', '6. Legal', 'active', '{"accepts_files":true}');
  UPDATE catalog_entries SET metadata = jsonb_set(metadata, '{folders}', (metadata->'folders') || '[{"name":"6. Legal","kind":"zz_s1_legal"}]'::jsonb)
   WHERE catalog_id = 'storage_folder_templates' AND slug = 'company_standard';
  o_again := store_ensure_owner('person', pc);  -- any fresh owner; use a company for the template:
  INSERT INTO accounts (company_name, status) VALUES ('ZZ S1 Template Co', 'Active') RETURNING id INTO a1;
  o_again := store_ensure_owner('company', a1);
  PERFORM store_apply_template(o_again, 'company_standard', 'ZZ S1 Template Co');
  IF NOT EXISTS (SELECT 1 FROM store_folders WHERE owner_id = o_again AND kind = 'zz_s1_legal' AND name = '6. Legal') THEN
    RAISE EXCEPTION 'CHECK 9 FAILED: new folder type from data not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM catalog_entries WHERE catalog_id = 'storage_document_types' AND slug = 'form_1040_nr' AND (metadata->>'personal')::boolean)
     OR EXISTS (SELECT 1 FROM catalog_entries WHERE catalog_id = 'storage_document_types' AND slug IN ('form_ss_4','tax_return','form_1065') AND (metadata->>'personal')::boolean) THEN
    RAISE EXCEPTION 'CHECK 9 FAILED: document-type privacy seeds wrong';
  END IF;
  RAISE NOTICE 'CHECK 9 passed — folder types/templates are data; privacy seeds correct (1040-NR personal; SS-4/returns company)';

  -- ── 10. versions immutable, filed files frozen, names unique among live files, history append-only
  INSERT INTO store_file_versions (file_id, version_no, storage_bucket, storage_path, sha256, size_bytes)
  VALUES (file1, 1, 'crm-store', 'zz-s1/' || file1 || '/1', repeat('a', 64), 100) RETURNING id INTO v1;
  UPDATE store_files SET current_version_id = v1, filing_status = 'filed' WHERE id = file1;
  BEGIN
    UPDATE store_file_versions SET sha256 = repeat('b', 64) WHERE id = v1;
    RAISE EXCEPTION 'CHECK 10 FAILED: saved version edited';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 10 FAILED%' THEN RAISE; END IF; END;
  UPDATE store_file_versions SET ocr_text = 'Articles of Organization' WHERE id = v1;  -- allowed
  INSERT INTO store_file_versions (file_id, version_no, storage_bucket, storage_path, sha256, size_bytes)
  VALUES (file1, 2, 'crm-store', 'zz-s1/' || file1 || '/2', repeat('c', 64), 120) RETURNING id INTO v2;
  BEGIN
    UPDATE store_files SET current_version_id = v2 WHERE id = file1;
    RAISE EXCEPTION 'CHECK 10 FAILED: filed file took a new version';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 10 FAILED%' THEN RAISE; END IF; END;
  BEGIN
    UPDATE store_files SET filing_status = 'none' WHERE id = file1;
    RAISE EXCEPTION 'CHECK 10 FAILED: filed file un-filed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 10 FAILED%' THEN RAISE; END IF; END;
  BEGIN
    INSERT INTO store_files (owner_id, folder_id, name) VALUES (o_f1, f_company, 'ARTICLES OF ORGANIZATION.pdf');
    RAISE EXCEPTION 'CHECK 10 FAILED: duplicate live name allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 10 FAILED%' THEN RAISE; END IF; END;
  BEGIN
    UPDATE store_events SET reason = 'x' WHERE file_id = file_unf;
    RAISE EXCEPTION 'CHECK 10 FAILED: history edited';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'CHECK 10 FAILED%' THEN RAISE; END IF; END;
  RAISE NOTICE 'CHECK 10 passed — versions immutable, filed files frozen, live names unique, history append-only';

  RAISE NOTICE 'ALL S1 CHECKS PASSED (fixtures are rolled back)';
END $$;

ROLLBACK;
