/**
 * SS-4 for a Company Formation flow.
 *
 *   GET  → the SD's account's SS-4 record (or null) — backs the ss4_panel read.
 *   POST → generate the SS-4 via the shared createSS4 core (lib/operations/ss4.ts),
 *          the same logic the ss4_create MCP tool uses. Surfaces the real reason
 *          when a prerequisite blocks creation (e.g. no Registered Agent) — R099.
 *
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createSS4 } from '@/lib/operations/ss4'
import { APP_BASE_URL } from '@/lib/config'

async function resolveAccountId(serviceDeliveryId: string): Promise<{ account_id: string | null; service_type: string | null } | null> {
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('account_id, service_type')
    .eq('id', serviceDeliveryId)
    .maybeSingle()
  return sd ?? null
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sd = await resolveAccountId(params.id)
    if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    if (!sd.account_id) return NextResponse.json({ success: true, ss4: null })

    const { data: ss4 } = await supabaseAdmin
      .from('ss4_applications')
      .select('id, token, access_code, status, company_name, signed_at, county_and_state')
      .eq('account_id', sd.account_id)
      .maybeSingle()

    if (!ss4) return NextResponse.json({ success: true, ss4: null })

    return NextResponse.json({
      success: true,
      ss4: {
        id: ss4.id,
        status: ss4.status,
        company_name: ss4.company_name,
        signed_at: ss4.signed_at ?? null,
        has_county: !!ss4.county_and_state,
        previewUrl: `${APP_BASE_URL}/ss4/${ss4.token}/${ss4.access_code}?preview=td`,
      },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sd = await resolveAccountId(params.id)
    if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    if (sd.service_type !== 'Company Formation') {
      return NextResponse.json({ success: false, error: 'SS-4 generation only applies to Company Formation flows.' }, { status: 400 })
    }
    if (!sd.account_id) {
      return NextResponse.json(
        { success: false, error: 'The CRM account is not created yet. Reach "Articles Received" first so the company is materialized.' },
        { status: 400 },
      )
    }

    const result = await createSS4({ account_id: sd.account_id })

    // already_exists isn't a failure for the workspace — return the existing record so the panel refreshes.
    if (result.outcome === 'already_exists' && result.ss4) {
      return NextResponse.json({
        success: true,
        already_existed: true,
        ss4: { id: result.ss4.id, status: result.ss4.status, company_name: result.ss4.company_name, previewUrl: result.previewUrl },
      })
    }

    if (!result.ok || !result.ss4) {
      return NextResponse.json(
        { success: false, error: result.message || `Could not generate the SS-4 (${result.outcome}).`, outcome: result.outcome },
        { status: 409 },
      )
    }

    return NextResponse.json({
      success: true,
      ss4: { id: result.ss4.id, status: result.ss4.status, company_name: result.ss4.company_name, previewUrl: result.previewUrl },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
