-- Member info form: fix duplicate-contact failure + make submit atomic.
-- SANDBOX FIRST (ref xjcxlmlpeywtwkhstjlw). Promote to production only with
-- explicit approval.
--
-- Bug (AI Venture Labs LLC / Michele Cotti, MMLLC):
--   When the same person is BOTH an individual member AND the representative of
--   a company member, provisionMemberContacts() resolves both member rows to the
--   SAME contacts.id. The old unique index uq_members_account_contact spanned
--   (account_id, contact_id) WHERE contact_id IS NOT NULL — so the second row
--   (same account_id + same contact_id) violated it and the whole batch INSERT
--   failed. Worse: the submit handler DELETEs all existing members BEFORE the
--   INSERT, with no transaction, so a failed INSERT left the account memberless.
--
-- Fix 1 — narrow the unique index to individual members only.
--   A person legitimately being both a direct member and a company's rep is a
--   valid ownership structure, so the same contact_id may appear on one
--   'individual' row AND one (or more) 'company' rows. We still forbid TWO
--   'individual' rows for the same person on the same account (a real duplicate).
--   Company-member duplicates remain blocked by uq_members_account_company
--   (account_id, company_name).
--
-- Fix 2 — submit_member_info(): atomic DELETE-then-INSERT in one function body.
--   No EXCEPTION handler: any error (e.g. the narrowed unique index) propagates
--   so PostgREST rolls back the whole transaction — the DELETE is undone and the
--   account keeps its existing members.

-- ── Fix 1: narrow the unique index ───────────────────────────────────────────
DROP INDEX IF EXISTS uq_members_account_contact;

CREATE UNIQUE INDEX uq_members_account_contact
  ON members (account_id, contact_id)
  WHERE contact_id IS NOT NULL AND member_type = 'individual';

-- ── Fix 2: atomic submit RPC ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION submit_member_info(p_account_id uuid, p_members jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Atomic by construction: both statements run in the caller's transaction.
  -- If the INSERT raises (e.g. duplicate individual contact_id), the error
  -- propagates uncaught and the DELETE is rolled back with it.
  DELETE FROM members WHERE account_id = p_account_id;

  INSERT INTO members (
    account_id, member_type, full_name, company_name, ein, email, phone,
    ownership_pct, is_primary, is_signer, contact_id,
    address_street, address_city, address_state, address_zip, address_country,
    representative_name, representative_email, representative_phone,
    representative_address_street, representative_address_city,
    representative_address_state, representative_address_zip,
    representative_address_country, created_at, updated_at
  )
  SELECT
    p_account_id,
    r.member_type, r.full_name, r.company_name, r.ein, r.email, r.phone,
    r.ownership_pct, COALESCE(r.is_primary, false), COALESCE(r.is_signer, false),
    r.contact_id,
    r.address_street, r.address_city, r.address_state, r.address_zip,
    r.address_country,
    r.representative_name, r.representative_email, r.representative_phone,
    r.representative_address_street, r.representative_address_city,
    r.representative_address_state, r.representative_address_zip,
    r.representative_address_country,
    COALESCE(r.created_at, now()), COALESCE(r.updated_at, now())
  FROM jsonb_to_recordset(p_members) AS r(
    member_type text, full_name text, company_name text, ein text, email text,
    phone text, ownership_pct numeric, is_primary boolean, is_signer boolean,
    contact_id uuid,
    address_street text, address_city text, address_state text, address_zip text,
    address_country text,
    representative_name text, representative_email text, representative_phone text,
    representative_address_street text, representative_address_city text,
    representative_address_state text, representative_address_zip text,
    representative_address_country text,
    created_at timestamptz, updated_at timestamptz
  );
END;
$$;

GRANT EXECUTE ON FUNCTION submit_member_info(uuid, jsonb) TO service_role;
