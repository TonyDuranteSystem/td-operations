/**
 * Activate the Registered Agent on Harbor Compliance for a Company Formation
 * flow. Backs the Workspace "Activate RA on Harbor Compliance" button on the
 * "Articles Received" stage — RA activation only happens once the company is
 * confirmed (Articles received), never at filing time.
 *
 * Resolves the SD → account, then pushes the company to Harbor Compliance
 * (mirrors the hc_sync_company MCP tool): updates the linked HC company when
 * accounts.hc_company_id is set; otherwise reports clearly that HC company
 * creation still needs the HC jurisdiction / business-structure reference IDs
 * (R099 — surface the real reason, no generic failure).
 *
 * POST → { success, message } | { success:false, error }
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { harborCompliance } from '@/lib/harbor-compliance'
import { logAction } from '@/lib/mcp/action-log'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const serviceDeliveryId = params.id

    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, account_id')
      .eq('id', serviceDeliveryId)
      .single()

    if (sdErr || !sd) {
      return NextResponse.json({ success: false, error: 'Flow (service delivery) not found' }, { status: 404 })
    }
    if (sd.service_type !== 'Company Formation') {
      return NextResponse.json(
        { success: false, error: 'Registered Agent activation only applies to Company Formation flows.' },
        { status: 400 },
      )
    }
    if (!sd.account_id) {
      return NextResponse.json(
        {
          success: false,
          error:
            'The CRM account is not created yet. Upload the Articles of Organization to materialize the company first, then activate the Registered Agent.',
        },
        { status: 400 },
      )
    }

    const { data: account, error: accErr } = await supabaseAdmin
      .from('accounts')
      .select('id, company_name, state_of_formation, entity_type, hc_company_id')
      .eq('id', sd.account_id)
      .single()

    if (accErr || !account) {
      return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 })
    }
    if (!account.company_name || !account.state_of_formation) {
      return NextResponse.json(
        {
          success: false,
          error: `Account "${account.company_name || account.id}" is missing company name or state of formation — set those before activating the RA.`,
        },
        { status: 400 },
      )
    }

    // Already linked → update the HC company.
    if (account.hc_company_id) {
      await harborCompliance.updateCompany(account.hc_company_id, { legal_name: account.company_name })
      logAction({
        action_type: 'update',
        table_name: 'hc_companies',
        record_id: account.hc_company_id,
        account_id: account.id,
        summary: `RA activation: updated HC company for ${account.company_name}`,
        details: { hc_company_id: account.hc_company_id, source: 'flow-activate-ra' },
      })
      return NextResponse.json({
        success: true,
        message: `Registered Agent is linked on Harbor Compliance (company ${account.hc_company_id}). Details were refreshed.`,
      })
    }

    // Not yet linked → HC company creation needs reference IDs (jurisdiction /
    // business structure) that the hc_sync_company tool path does not yet resolve.
    // Report this honestly so staff can complete it on the HC portal.
    logAction({
      action_type: 'create',
      table_name: 'hc_companies',
      record_id: account.id,
      account_id: account.id,
      summary: `RA activation requested for ${account.company_name} (HC company not yet created)`,
      details: { state_of_formation: account.state_of_formation, entity_type: account.entity_type, source: 'flow-activate-ra' },
    })
    return NextResponse.json(
      {
        success: false,
        error:
          'This company is not yet on Harbor Compliance. Create the HC company on the Harbor Compliance portal (or via hc_sync_company once the jurisdiction / business-structure reference IDs are configured), then re-run this to link it.',
      },
      { status: 409 },
    )
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
