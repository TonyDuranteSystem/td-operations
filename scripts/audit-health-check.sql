-- =============================================================================
-- AUDIT HEALTH CHECK — Tony Durante LLC Supabase Database
-- =============================================================================
-- Run anytime to check system health. Returns a unified report.
-- Columns: check_name | table_name | severity | records_affected | sample_ids | description
--
-- Severity levels:
--   P0 = Data integrity violation (orphans, broken FKs, constraint-breaking values)
--   P1 = Business logic violation (stuck workflows, mismatches)
--   P2 = Data quality warning (unexpected values, stale records)
--
-- Generated: 2026-04-08
-- =============================================================================

WITH audit_results AS (

  -- =========================================================================
  -- SECTION 1: STATUS VALUE CHECKS
  -- Each check finds rows where a TEXT/VARCHAR status column contains
  -- a value outside the allowed set.
  -- =========================================================================

  -- CHECK 1: service_deliveries.status
  SELECT
    'invalid_sd_status'                     AS check_name,
    'service_deliveries'                    AS table_name,
    'P0'                                    AS severity,
    COUNT(*)::int                           AS records_affected,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200) AS sample_ids,
    'status values not in (active, blocked, completed, cancelled): found ' ||
      STRING_AGG(DISTINCT status, ', ')     AS description
  FROM service_deliveries
  WHERE status NOT IN ('active', 'blocked', 'completed', 'cancelled')

  UNION ALL

  -- CHECK 2: service_deliveries.service_type
  -- Validated against pipeline_stages.service_type plus additional known types
  SELECT
    'invalid_sd_service_type',
    'service_deliveries',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'service_type values not matching any pipeline_stages.service_type or known types: found ' ||
      STRING_AGG(DISTINCT sd.service_type, ', ')
  FROM service_deliveries sd
  WHERE sd.service_type IS NOT NULL
    AND sd.service_type NOT IN (
      'Company Formation', 'Client Onboarding', 'Tax Return', 'State RA Renewal',
      'CMRA', 'CMRA Mailing Address', 'Shipping', 'Public Notary',
      'Banking Fintech', 'Banking Physical', 'ITIN', 'Company Closure',
      'Client Offboarding', 'State Annual Report', 'EIN', 'EIN Application',
      'Support', 'Billing Annual Renewal', 'Annual Renewal'
    )

  UNION ALL

  -- CHECK 3: offers.status
  -- NOTE: existing CHECK constraint allows (draft, sent, viewed, accepted, signed, completed, expired)
  SELECT
    'invalid_offer_status',
    'offers',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (draft, sent, viewed, signed, completed, accepted, expired): found ' ||
      STRING_AGG(DISTINCT status::text, ', ')
  FROM offers
  WHERE status::text NOT IN ('draft', 'sent', 'viewed', 'signed', 'completed', 'accepted', 'expired')

  UNION ALL

  -- CHECK 4: lease_agreements.status
  SELECT
    'invalid_lease_status',
    'lease_agreements',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (draft, sent, viewed, signed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status::text, ', '), 'N/A')
  FROM lease_agreements
  WHERE status::text NOT IN ('draft', 'sent', 'viewed', 'signed')

  UNION ALL

  -- CHECK 5: oa_agreements.status
  SELECT
    'invalid_oa_status',
    'oa_agreements',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (draft, sent, viewed, signed, partially_signed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM oa_agreements
  WHERE status NOT IN ('draft', 'sent', 'viewed', 'signed', 'partially_signed')

  UNION ALL

  -- CHECK 6: ss4_applications.status
  SELECT
    'invalid_ss4_status',
    'ss4_applications',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (draft, awaiting_signature, signed, submitted, done, fax_failed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM ss4_applications
  WHERE status NOT IN ('draft', 'awaiting_signature', 'signed', 'submitted', 'done', 'fax_failed')

  UNION ALL

  -- CHECK 7: deadlines.status
  SELECT
    'invalid_deadline_status',
    'deadlines',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (Pending, Completed, Filed, Not Started, Overdue): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM deadlines
  WHERE status NOT IN ('Pending', 'Completed', 'Filed', 'Not Started', 'Overdue')

  UNION ALL

  -- CHECK 8: documents.status
  -- NOTE: existing CHECK allows (pending, processed, classified, unclassified, error)
  SELECT
    'invalid_document_status',
    'documents',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (classified, unclassified, error, pending, processed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM documents
  WHERE status NOT IN ('classified', 'unclassified', 'error', 'pending', 'processed')

  UNION ALL

  -- CHECK 9: client_invoices.status
  -- NOTE: existing CHECK allows (Draft, Sent, Paid, Overdue, Cancelled)
  SELECT
    'invalid_client_invoice_status',
    'client_invoices',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (Draft, Sent, Paid, Partial, Overdue, Cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM client_invoices
  WHERE status NOT IN ('Draft', 'Sent', 'Paid', 'Partial', 'Overdue', 'Cancelled')

  UNION ALL

  -- CHECK 10: client_expenses.status
  SELECT
    'invalid_client_expense_status',
    'client_expenses',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (Pending, Paid, Overdue, Cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM client_expenses
  WHERE status NOT IN ('Pending', 'Paid', 'Overdue', 'Cancelled')

  UNION ALL

  -- CHECK 11: banking_submissions.status
  SELECT
    'invalid_banking_sub_status',
    'banking_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM banking_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 12: formation_submissions.status
  SELECT
    'invalid_formation_sub_status',
    'formation_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM formation_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 13: onboarding_submissions.status
  SELECT
    'invalid_onboarding_sub_status',
    'onboarding_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM onboarding_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 14: tax_return_submissions.status
  SELECT
    'invalid_tax_sub_status',
    'tax_return_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM tax_return_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 15: itin_submissions.status
  SELECT
    'invalid_itin_sub_status',
    'itin_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM itin_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 16: closure_submissions.status
  SELECT
    'invalid_closure_sub_status',
    'closure_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM closure_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 17: wizard_progress.status
  SELECT
    'invalid_wizard_status',
    'wizard_progress',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (in_progress, submitted, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM wizard_progress
  WHERE status NOT IN ('in_progress', 'submitted', 'reviewed')

  UNION ALL

  -- CHECK 18: pending_activations.status
  SELECT
    'invalid_activation_status',
    'pending_activations',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (awaiting_payment, payment_confirmed, activated, expired, cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM pending_activations
  WHERE status NOT IN ('awaiting_payment', 'payment_confirmed', 'activated', 'expired', 'cancelled')

  UNION ALL

  -- CHECK 19: referrals.status
  SELECT
    'invalid_referral_status',
    'referrals',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, converted, credited, paid, cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM referrals
  WHERE status NOT IN ('pending', 'converted', 'credited', 'paid', 'cancelled')

  UNION ALL

  -- CHECK 20: signature_requests.status
  SELECT
    'invalid_sigreq_status',
    'signature_requests',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (draft, awaiting_signature, signed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM signature_requests
  WHERE status NOT IN ('draft', 'awaiting_signature', 'signed')

  UNION ALL

  -- CHECK 21: contacts.portal_tier
  SELECT
    'invalid_contact_portal_tier',
    'contacts',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'portal_tier values not in (lead, onboarding, active, NULL): found ' ||
      COALESCE(STRING_AGG(DISTINCT portal_tier, ', '), 'N/A')
  FROM contacts
  WHERE portal_tier IS NOT NULL
    AND portal_tier NOT IN ('lead', 'onboarding', 'active')

  UNION ALL

  -- CHECK 22: contacts.portal_role
  SELECT
    'invalid_contact_portal_role',
    'contacts',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'portal_role values not in (client, partner, NULL): found ' ||
      COALESCE(STRING_AGG(DISTINCT portal_role, ', '), 'N/A')
  FROM contacts
  WHERE portal_role IS NOT NULL
    AND portal_role NOT IN ('client', 'partner')

  UNION ALL

  -- CHECK 23: accounts.portal_tier
  SELECT
    'invalid_account_portal_tier',
    'accounts',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'portal_tier values not in (lead, onboarding, active, NULL): found ' ||
      COALESCE(STRING_AGG(DISTINCT portal_tier, ', '), 'N/A')
  FROM accounts
  WHERE portal_tier IS NOT NULL
    AND portal_tier NOT IN ('lead', 'onboarding', 'active')

  UNION ALL

  -- CHECK 24: tasks.status (ENUM — catch any unexpected values like lowercase 'todo')
  -- tasks.status is an ENUM so Postgres enforces values at insert, but we still
  -- check for the semantically-wrong 'todo' that may have been inserted when the
  -- enum label was added.
  SELECT
    'invalid_task_status',
    'tasks',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'tasks with status not in expected set (To Do, In Progress, Waiting, Done, Cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status::text, ', '), 'N/A')
  FROM tasks
  WHERE status::text NOT IN ('To Do', 'In Progress', 'Waiting', 'Done', 'Cancelled')

  UNION ALL

  -- =========================================================================
  -- SECTION 2: BUSINESS LOGIC CHECKS
  -- =========================================================================

  -- CHECK 25: Payments marked Paid with NULL paid_date
  SELECT
    'paid_null_paid_date',
    'payments',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'Payments with status=Paid but paid_date is NULL'
  FROM payments
  WHERE status = 'Paid' AND paid_date IS NULL

  UNION ALL

  -- CHECK 26: Active service_deliveries on Cancelled/Closed accounts
  SELECT
    'active_sd_cancelled_account',
    'service_deliveries',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'Active SDs linked to accounts with status Cancelled or Closed'
  FROM service_deliveries sd
  JOIN accounts a ON sd.account_id = a.id
  WHERE sd.status = 'active'
    AND a.status IN ('Cancelled', 'Closed')

  UNION ALL

  -- CHECK 27: pending_activations stuck at payment_confirmed > 7 days
  SELECT
    'stuck_activations',
    'pending_activations',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'Activations stuck at payment_confirmed for > 7 days (oldest: ' ||
      COALESCE(MIN(updated_at)::text, MIN(created_at)::text, '?') || ')'
  FROM pending_activations
  WHERE status = 'payment_confirmed'
    AND COALESCE(updated_at, created_at) < NOW() - INTERVAL '7 days'

  UNION ALL

  -- CHECK 28: NULL stage in service_deliveries where service_type has pipeline stages
  SELECT
    'sd_null_stage',
    'service_deliveries',
    'P2',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'SDs with NULL stage but service_type has defined pipeline stages: ' ||
      COALESCE(STRING_AGG(DISTINCT sd.service_type, ', '), 'N/A')
  FROM service_deliveries sd
  WHERE sd.stage IS NULL
    AND sd.status = 'active'
    AND sd.service_type IN (SELECT DISTINCT service_type FROM pipeline_stages)

  UNION ALL

  -- CHECK 29: Portal tier mismatch between contacts and accounts
  -- A contact's portal_tier should match all their linked accounts' portal_tier
  SELECT
    'portal_tier_contact_account_mismatch',
    'contacts / accounts',
    'P1',
    COUNT(DISTINCT c.id)::int,
    LEFT(STRING_AGG(DISTINCT c.id::text, ', '), 200),
    'Contacts whose portal_tier differs from their account portal_tier'
  FROM contacts c
  JOIN accounts a ON a.contact_id = c.id
  WHERE c.portal_tier IS DISTINCT FROM a.portal_tier
    AND c.portal_tier IS NOT NULL
    AND a.portal_tier IS NOT NULL

  UNION ALL

  -- CHECK 30: Portal tier mismatch between contacts and auth.users
  -- auth.users stores portal_tier in raw_user_meta_data->>'portal_tier'
  SELECT
    'portal_tier_contact_auth_mismatch',
    'contacts / auth.users',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(c.id::text, ', '), 200),
    'Contacts whose portal_tier differs from auth.users metadata'
  FROM contacts c
  JOIN auth.users u ON c.auth_uid = u.id
  WHERE c.portal_tier IS DISTINCT FROM (u.raw_user_meta_data->>'portal_tier')
    AND c.portal_tier IS NOT NULL
    AND (u.raw_user_meta_data->>'portal_tier') IS NOT NULL

  UNION ALL

  -- CHECK 31: Auth users with no matching contact
  SELECT
    'orphan_auth_users',
    'auth.users',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(u.id::text, ', '), 200),
    'auth.users with no matching contact (by auth_uid)'
  FROM auth.users u
  LEFT JOIN contacts c ON c.auth_uid = u.id
  WHERE c.id IS NULL

  UNION ALL

  -- CHECK 32: SD service_type not in pipeline_stages
  SELECT
    'sd_service_type_no_pipeline',
    'service_deliveries',
    'P2',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'SDs with service_type not matching any pipeline_stages.service_type: ' ||
      COALESCE(STRING_AGG(DISTINCT sd.service_type, ', '), 'N/A')
  FROM service_deliveries sd
  WHERE sd.service_type IS NOT NULL
    AND sd.service_type NOT IN (SELECT DISTINCT service_type FROM pipeline_stages)

  UNION ALL

  -- CHECK 33: SD stage not matching pipeline_stages for their service_type
  SELECT
    'sd_stage_invalid_for_type',
    'service_deliveries',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'SDs with stage not valid for their service_type per pipeline_stages'
  FROM service_deliveries sd
  WHERE sd.stage IS NOT NULL
    AND sd.service_type IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pipeline_stages ps
      WHERE ps.service_type = sd.service_type
        AND ps.stage_name = sd.stage
    )

  UNION ALL

  -- CHECK 34: Active accounts with zero service deliveries
  SELECT
    'active_account_no_sds',
    'accounts',
    'P2',
    COUNT(*)::int,
    LEFT(STRING_AGG(a.id::text, ', '), 200),
    'Active accounts with zero service deliveries'
  FROM accounts a
  LEFT JOIN service_deliveries sd ON sd.account_id = a.id
  WHERE a.status = 'Active'
  GROUP BY a.id
  HAVING COUNT(sd.id) = 0

  UNION ALL

  -- CHECK 35: QB sync pending for > 7 days
  SELECT
    'qb_sync_stale',
    'payments',
    'P2',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'Payments with qb_sync_status=pending for > 7 days'
  FROM payments
  WHERE qb_sync_status = 'pending'
    AND updated_at < NOW() - INTERVAL '7 days'

  UNION ALL

  -- =========================================================================
  -- SECTION 3: ORPHAN CHECKS
  -- =========================================================================

  -- CHECK 36: SDs with non-existent account_id
  SELECT
    'orphan_sd_account',
    'service_deliveries',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'SDs referencing account_id that does not exist in accounts'
  FROM service_deliveries sd
  LEFT JOIN accounts a ON sd.account_id = a.id
  WHERE sd.account_id IS NOT NULL
    AND a.id IS NULL

  UNION ALL

  -- CHECK 37: SDs with non-existent contact_id
  SELECT
    'orphan_sd_contact',
    'service_deliveries',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'SDs referencing contact_id that does not exist in contacts'
  FROM service_deliveries sd
  LEFT JOIN contacts c ON sd.contact_id = c.id
  WHERE sd.contact_id IS NOT NULL
    AND c.id IS NULL

  UNION ALL

  -- CHECK 38: Payments with non-existent account_id
  SELECT
    'orphan_payment_account',
    'payments',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(p.id::text, ', ' ORDER BY p.created_at DESC), 200),
    'Payments referencing account_id that does not exist in accounts'
  FROM payments p
  LEFT JOIN accounts a ON p.account_id = a.id
  WHERE p.account_id IS NOT NULL
    AND a.id IS NULL

  UNION ALL

  -- CHECK 39: Documents with non-existent account_id
  SELECT
    'orphan_document_account',
    'documents',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(d.id::text, ', ' ORDER BY d.created_at DESC), 200),
    'Documents referencing account_id that does not exist in accounts'
  FROM documents d
  LEFT JOIN accounts a ON d.account_id = a.id
  WHERE d.account_id IS NOT NULL
    AND a.id IS NULL

)

-- =========================================================================
-- FINAL OUTPUT — only rows with at least one finding
-- =========================================================================
SELECT
  check_name,
  table_name,
  severity,
  records_affected,
  sample_ids,
  description
FROM audit_results
WHERE records_affected > 0
ORDER BY
  CASE severity WHEN 'P0' THEN 1 WHEN 'P1' THEN 2 WHEN 'P2' THEN 3 END,
  records_affected DESC;
