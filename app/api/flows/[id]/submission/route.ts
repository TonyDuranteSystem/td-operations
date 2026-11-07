/**
 * Fetch the client's submitted data for a flow (service_delivery). Backs the
 * flow Workspace data_viewer component.
 *
 * Three sources, by service_type:
 *   - Company Closure → the finished `closure_submissions` row (the client's closure wizard) that belongs to THIS job, `source:'closure'`.
 *     A job with a company is matched by account; a job with NO company (closing a company that is not ours) by contact
 *     with no account — the same matching closure-form-completed itself uses to find the job. Which row is this job's: see
 *     lib/flows/closure-answers.ts (its own wizard token, else the newest made since the job started and only if no other
 *     closure is open in that scope, else nothing).
 *   - Company Formation → the latest `wizard_progress` row for the SD's
 *     contact (wizard_type='formation'). Formation SDs are CONTACT-scoped
 *     (account_id NULL until the company is materialized at Articles Received),
 *     so this is matched by contact_id, not account_id. The flat `data` blob is
 *     returned as `submitted_data` with `source:'formation'` — the DataViewer
 *     surfaces the candidate LLC names prominently.
 *   - everything else → the newest `tax_return_submissions` row for the SD's
 *     account (Tax Return review stages), `source:'tax'`.
 *
 * GET → { success, source, submission: { id?, entity_type, tax_year, review_status,
 *         created_at, submitted_data } | null, review?: { writable, draft, last_round } }  (review: tax source only)
 * [id] = service_delivery_id. Read-only.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { pickClosureAnswers } from '@/lib/flows/closure-answers'
import { loadTargetTaxSubmission } from '@/lib/tax/target-submission'
import { answerOutcomes, canWriteReviewRequests, latestRound, parseReviewRequests } from '@/lib/tax/review-requests'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const serviceDeliveryId = params.id

    // 1. Resolve the SD → service_type + scoping ids.
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, account_id, contact_id, created_at, source_closure_token')
      .eq('id', serviceDeliveryId)
      .single()

    if (sdErr || !sd) {
      return NextResponse.json(
        { success: false, error: 'Flow (service delivery) not found' },
        { status: 404 },
      )
    }

    // 2a. Company Formation — the client's formation wizard (contact-scoped).
    if (sd.service_type === 'Company Formation') {
      if (!sd.contact_id) {
        return NextResponse.json({ success: true, source: 'formation', submission: null })
      }
      const { data: wp, error: wpErr } = await supabaseAdmin
        .from('wizard_progress')
        .select('data, status, updated_at, created_at')
        .eq('contact_id', sd.contact_id)
        .eq('wizard_type', 'formation')
        .order('updated_at', { ascending: false })
        .limit(1)

      if (wpErr) {
        return NextResponse.json(
          { success: false, error: `Could not load formation wizard: ${wpErr.message}` },
          { status: 500 },
        )
      }

      const row = wp?.[0]
      if (row) {
        return NextResponse.json({
          success: true,
          source: 'formation',
          submission: {
            entity_type: null,
            tax_year: null,
            review_status: row.status ?? null,
            created_at: row.updated_at ?? row.created_at ?? null,
            submitted_data: row.data ?? null,
          },
        })
      }

      // FALLBACK (dev job 9a9c5cf5): a wizard_progress write can fail
      // silently (2026-08-27 missing-column incident being the proven
      // case — Francesco Lussignoli, live production, staff saw "No
      // submitted data found" for a client who had genuinely submitted).
      // formation_submissions carries the same data independently.
      const { data: sub, error: subErr } = await supabaseAdmin
        .from('formation_submissions')
        .select('submitted_data, status, created_at')
        .eq('contact_id', sd.contact_id)
        .in('status', ['completed', 'reviewed'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (subErr) {
        return NextResponse.json(
          { success: false, error: `Could not load formation wizard: ${subErr.message}` },
          { status: 500 },
        )
      }

      return NextResponse.json({
        success: true,
        source: 'formation',
        submission: sub
          ? {
              entity_type: null,
              tax_year: null,
              review_status: sub.status ?? null,
              created_at: sub.created_at ?? null,
              submitted_data: sub.submitted_data ?? null,
            }
          : null,
      })
    }

    // 2c. Company Closure — the client's closure wizard answers. WHICH wizard belongs to this job is decided by pickClosureAnswers
    // (lib/flows/closure-answers.ts): the job's own wizard when it knows it, else the newest one made since the job started — and
    // only when no other closure is open in the same scope; never just "the newest for this person" (another closure's answers).
    if (sd.service_type === 'Company Closure') {
      let q = supabaseAdmin
        .from('closure_submissions')
        .select('submitted_data, status, completed_at, created_at, token')
        .in('status', ['completed', 'reviewed'])
      let others = supabaseAdmin
        .from('service_deliveries')
        .select('id')
        .eq('service_type', 'Company Closure')
        .eq('status', 'active')
        .neq('id', sd.id)
      if (sd.account_id) {
        q = q.eq('account_id', sd.account_id)
        others = others.eq('account_id', sd.account_id)
      } else if (sd.contact_id) {
        q = q.eq('contact_id', sd.contact_id).is('account_id', null)
        others = others.eq('contact_id', sd.contact_id).is('account_id', null)
      } else {
        return NextResponse.json({ success: true, source: 'closure', submission: null })
      }
      const [{ data: rows, error: csErr }, { data: otherJobs, error: otherErr }] = await Promise.all([
        q.order('created_at', { ascending: false }).limit(50),
        others,
      ])
      if (csErr || otherErr) {
        return NextResponse.json(
          { success: false, error: `Could not load the closure wizard: ${(csErr ?? otherErr)?.message}` },
          { status: 500 },
        )
      }
      const cs = pickClosureAnswers({
        job: { id: sd.id, created_at: sd.created_at, source_closure_token: sd.source_closure_token },
        rows: rows ?? [],
        otherOpenJobs: (otherJobs ?? []).map((o) => ({ id: o.id })),
      })
      return NextResponse.json({
        success: true,
        source: 'closure',
        submission: cs
          ? {
              entity_type: null,
              tax_year: null,
              review_status: cs.status ?? null,
              created_at: cs.completed_at ?? cs.created_at ?? null,
              submitted_data: cs.submitted_data ?? null,
            }
          : null,
      })
    }

    // 2b. Other flows — the latest tax submission (account-scoped).
    if (!sd.account_id) {
      // Contact-only SDs have no account-scoped submission to show.
      return NextResponse.json({ success: true, source: 'tax', submission: null })
    }

    // The SAME submission Request Changes / Approve act on and the client's form re-opens (target rule), not just "the newest":
    // the answers staff read, the requests they write next to them and the form the client edits are always ONE row.
    const loaded = await loadTargetTaxSubmission(sd.account_id)
    if (loaded.ok === false) {
      if (loaded.reason === 'error') {
        return NextResponse.json(
          { success: false, error: `Could not load submission: ${loaded.detail}` },
          { status: 500 },
        )
      }
      return NextResponse.json({ success: true, source: 'tax', submission: null })
    }
    const sub = loaded.sub

    // Requests staff wrote next to answers: the unsent draft, and (once Request Changes was pressed) the newest round with what the
    // client did about each one. While the client is still editing (revision_requested) every request is simply "sent".
    const rr = parseReviewRequests(sub.review_requests)
    const last = latestRound(rr)
    const waiting = sub.review_status === 'revision_requested'
    return NextResponse.json({
      success: true,
      source: 'tax',
      submission: {
        id: sub.id,
        entity_type: sub.entity_type,
        tax_year: sub.tax_year,
        review_status: sub.review_status,
        created_at: sub.created_at,
        submitted_data: sub.submitted_data,
      },
      review: {
        writable: canWriteReviewRequests(sub.review_status),
        draft: rr.draft,
        last_round: last
          ? {
              sent_at: last.sent_at,
              by: last.by,
              message: last.message,
              waiting,
              requests: answerOutcomes(last, sub.submitted_data).map((q) => ({
                key: q.key,
                label: q.label,
                group: q.group,
                note: q.note,
                was: q.was,
                now: q.now,
                outcome: q.outcome,
              })),
            }
          : null,
      },
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
