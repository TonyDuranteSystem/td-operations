/**
 * Fetch the client's submitted data for a flow (service_delivery). Backs the
 * flow Workspace data_viewer component.
 *
 * Two sources, by service_type:
 *   - Company Formation → the latest `wizard_progress` row for the SD's
 *     contact (wizard_type='formation'). Formation SDs are CONTACT-scoped
 *     (account_id NULL until the company is materialized at Articles Received),
 *     so this is matched by contact_id, not account_id. The flat `data` blob is
 *     returned as `submitted_data` with `source:'formation'` — the DataViewer
 *     surfaces the candidate LLC names prominently.
 *   - everything else → the newest `tax_return_submissions` row for the SD's
 *     account (Tax Return review stages), `source:'tax'`.
 *
 * GET → { success, source, submission: { entity_type, tax_year, review_status,
 *         created_at, submitted_data } | null }
 * [id] = service_delivery_id. Read-only.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const serviceDeliveryId = params.id

    // 1. Resolve the SD → service_type + scoping ids.
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, account_id, contact_id')
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

    // 2b. Other flows — the latest tax submission (account-scoped).
    if (!sd.account_id) {
      // Contact-only SDs have no account-scoped submission to show.
      return NextResponse.json({ success: true, source: 'tax', submission: null })
    }

    const { data, error } = await supabaseAdmin
      .from('tax_return_submissions')
      .select('entity_type, tax_year, review_status, created_at, submitted_data')
      .eq('account_id', sd.account_id)
      .order('created_at', { ascending: false })
      .limit(1)

    if (error) {
      return NextResponse.json(
        { success: false, error: `Could not load submission: ${error.message}` },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, source: 'tax', submission: data?.[0] ?? null })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
