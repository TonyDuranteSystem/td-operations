import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { saveGeometry } from '@/lib/td-communication/pipeline-queries'

export const dynamic = 'force-dynamic'

/**
 * POST /api/td-communication/projects/[id]/geometry
 *
 * Persist Cris's chosen logo geometry to metadata.logo_geometry (its own sibling
 * key — an AI-profile regenerate never touches it). Staff or scoped partner. The
 * value is coerced server-side, so a malformed body can't land.
 *
 * Body: { geometry: LogoGeometry } → { geometry }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  try {
    const geometry = await saveGeometry(params.id, body.geometry)
    return NextResponse.json({ geometry })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not save the geometry.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
