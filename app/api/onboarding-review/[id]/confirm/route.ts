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
import { applyOnboardingReview, confirmPortalWizardOnboarding, type FilingIdChoice, type SuiteConfirmChoice } from '@/lib/operations/onboarding-review'
import { normalizeFilingId } from '@/lib/articles-parse'

async function currentUserEmail(): Promise<string> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.email || 'dashboard-staff'
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const actor = await currentUserEmail()

    // The suite decision is REQUIRED (Antonio 2026-09-30): issue the company's suite, or explicitly "No suite for this
    // client" with a reason. Refuse a Confirm that carries neither — no silent default either way.
    const body = (await req.json().catch(() => ({}))) as { suite_choice?: string; suite_reason?: string; filing_id?: unknown }
    let suite: SuiteConfirmChoice
    if (body.suite_choice === 'issue') {
      suite = { choice: 'issue' }
    } else if (body.suite_choice === 'waive' && body.suite_reason?.trim()) {
      suite = { choice: 'waive', reason: body.suite_reason.trim() }
    } else {
      return NextResponse.json(
        { success: false, error: 'Choose what to do about the suite first: Issue a suite, or No suite for this client (with a reason).' },
        { status: 400 },
      )
    }

    // The State Filing ID staff checked against the real Articles on the review screen (job 64d2be64): a number (confirmed or corrected),
    // or null = "this document has no Filing ID". The key is absent when the screen had no Articles to check.
    let filingId: FilingIdChoice | undefined
    if (body.filing_id === null) {
      filingId = { value: null }
    } else if (body.filing_id !== undefined) {
      const checked = normalizeFilingId(body.filing_id)
      if (!checked) {
        return NextResponse.json(
          { success: false, error: 'The State Filing ID can only contain letters, numbers and dashes (4 to 30 characters), for example 2026-002103965. Correct it on the card and confirm again.' },
          { status: 400 },
        )
      }
      filingId = { value: checked }
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('onboarding_submissions')
      .select('source')
      .eq('id', params.id)
      .maybeSingle()
    if (subErr || !sub) {
      return NextResponse.json({ success: false, error: subErr?.message || 'Submission not found' }, { status: 404 })
    }

    // the 4th argument is passed only when staff checked a number, so every other call keeps its exact shape
    const filingArgs = filingId ? [filingId] as const : ([] as const)
    const result = sub.source === 'portal_wizard'
      ? await confirmPortalWizardOnboarding(params.id, actor, suite, ...filingArgs)
      : await applyOnboardingReview(params.id, actor, suite, ...filingArgs)

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
