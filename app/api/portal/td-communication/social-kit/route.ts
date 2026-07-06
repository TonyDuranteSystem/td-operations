import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/portal-auth'
import { resolveClientActiveEnrollment } from '@/lib/td-communication/client-access'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { listReleasedSocialKits } from '@/lib/td-communication/social-kit-queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/portal/td-communication/social-kit — the client's released social
 * sharing kit, for self-serve download. Client-only. Gated three ways:
 *   - the `social_kit_enabled` kill-switch (503 when off),
 *   - the client's enrollment must be `delivered`,
 *   - a released `social_kit` must exist.
 *
 * The client never supplies an enrollment id — it is resolved from their own
 * identity (no IDOR). Returns a short-lived signed forced-download URL, never a
 * storage path.
 *
 *   { available: false }                                   — nothing to download
 *   { available: true, download_url, file_name, released_at }
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const settings = await getCommSettings()
    if (!settings.social_kit_enabled) {
      return NextResponse.json({ error: 'The social sharing kit is not available.' }, { status: 503 })
    }

    const enrollment = await resolveClientActiveEnrollment(user)
    if (!enrollment || enrollment.status !== 'delivered') {
      return NextResponse.json({ available: false })
    }

    const kits = await listReleasedSocialKits(enrollment.id)
    const latest = kits[0]
    if (!latest || !latest.download_url) {
      return NextResponse.json({ available: false })
    }

    return NextResponse.json({
      available: true,
      download_url: latest.download_url,
      file_name: latest.file_name,
      released_at: latest.released_at,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load your social sharing kit.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
