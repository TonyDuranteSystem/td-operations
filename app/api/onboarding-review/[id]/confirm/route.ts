/**
 * Confirm an onboarding submission — the staff-facing "Confirm" action on
 * the review-inbox screen (dev job bc2a8f7f, Antonio's 2026-09-20 decision).
 *
 * This is the ONLY thing that lets an onboarding client's Contact/Account
 * setup proceed, and it only runs when staff explicitly click Confirm
 * after reviewing the submitted data and documents — never automatically
 * on client submission.
 *
 * POST → { success, alreadyApplied, contact_id, account_id, company_name, lines, pending }
 * [id] = onboarding_submissions.id.
 *
 * Two real client journeys share this one table and this one Confirm button,
 * so this route branches on the row's `source`:
 *   - 'portal_wizard' (the REAL client journey — logged in, portal wizard):
 *     confirmPortalWizardOnboarding just records the review and re-enqueues
 *     the onboarding_setup job, which does the actual Account/Drive/tasks
 *     creation using its own wizard-specific logic (the job already stopped
 *     once at a staff-review gate — this resumes it).
 *   - anything else (the separate manual token-link tool): applyOnboardingReview,
 *     unchanged — creates the Contact/Account inline itself.
 * Both functions share the same idempotency-lock shape, so a double-click
 * here is safe by construction either way.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { applyOnboardingReview, confirmPortalWizardOnboarding } from '@/lib/operations/onboarding-review'

async function currentUserEmail(): Promise<string> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.email || 'dashboard-staff'
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const actor = await currentUserEmail()

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('onboarding_submissions')
      .select('source')
      .eq('id', params.id)
      .maybeSingle()
    if (subErr || !sub) {
      return NextResponse.json({ success: false, error: subErr?.message || 'Submission not found' }, { status: 404 })
    }

    const result = sub.source === 'portal_wizard'
      ? await confirmPortalWizardOnboarding(params.id, actor)
      : await applyOnboardingReview(params.id, actor)

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error, lines: result.lines }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      alreadyApplied: result.alreadyApplied,
      contact_id: result.contact_id,
      account_id: result.account_id,
      company_name: result.company_name,
      lines: result.lines,
      pending: result.pending ?? false,
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
