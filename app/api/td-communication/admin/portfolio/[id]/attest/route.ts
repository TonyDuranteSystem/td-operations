import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureAdmin } from '@/lib/td-communication/admin-auth'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { attestWrittenConsent } from '@/lib/td-communication/portfolio-queries'

export const dynamic = 'force-dynamic'

/**
 * POST /api/td-communication/admin/portfolio/[id]/attest — record an admin
 * "written permission on file" attestation as the consent basis (consent_source
 * = 'written_on_file', attested_by/at stamped server-side). ADMIN-ONLY: this is a
 * legal attestation, so it is Antonio's to make, not the partner's.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = ensureAdmin(user)
  if (gate) return gate

  try {
    const participant = await resolveCommParticipant(user)
    const entry = await attestWrittenConsent(params.id, participant?.name ?? user?.email ?? null)
    return NextResponse.json({ entry })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not record the attestation.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
