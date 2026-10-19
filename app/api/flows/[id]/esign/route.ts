/**
 * GET /api/flows/[id]/esign — the e-sign envelopes linked to this service delivery (newest first), for the
 * workspace "Form for the client to sign" panel. Staff-only. [id] = service_delivery_id.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  // esign_* tables are not in the generated DB types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from('esign_envelopes')
    .select('id, document_name, status, signed_count, total_signers, created_at, completed_at')
    .eq('service_delivery_id', params.id)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) {
    console.error(`flows/esign: could not read envelopes for SD ${params.id}:`, error.message)
    return NextResponse.json({ success: false, error: 'Could not load the signing status.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, envelopes: data ?? [] })
}
