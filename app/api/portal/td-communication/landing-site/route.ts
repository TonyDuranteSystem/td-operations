import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/portal-auth'
import { resolveClientDeliveredEnrollment } from '@/lib/td-communication/client-access'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { getSiteForEnrollment, publicUrlForSlug } from '@/lib/td-communication/client-landing-queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/portal/td-communication/landing-site — the client's LIVE landing page
 * URL, for the "your landing page is live" portal card. Client-only. Gated:
 *   - the `landing_builder_enabled` kill-switch (503 when off),
 *   - the client's enrollment must be `delivered` (delivered-inclusive resolver),
 *   - a published, non-deleted site must exist.
 *
 * The client never supplies an enrollment id — resolved from their own identity
 * (no IDOR). Returns only the public URL (already world-readable), never internals.
 *
 *   { available: false }                       — nothing live
 *   { available: true, public_url }
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const settings = await getCommSettings()
    if (!settings.landing_builder_enabled) {
      return NextResponse.json({ error: 'Not available.' }, { status: 503 })
    }

    const enrollment = await resolveClientDeliveredEnrollment(user)
    if (!enrollment) return NextResponse.json({ available: false })

    const site = await getSiteForEnrollment(enrollment.id)
    if (!site || !site.published) return NextResponse.json({ available: false })

    return NextResponse.json({ available: true, public_url: publicUrlForSlug(site.slug) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load your landing page.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
