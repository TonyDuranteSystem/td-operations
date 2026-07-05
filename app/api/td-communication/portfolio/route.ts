import { NextResponse } from 'next/server'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { listPublishedPortfolio } from '@/lib/td-communication/portfolio-queries'
import { toPublicEntry, deriveCategories } from '@/lib/td-communication/portfolio'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/portfolio — PUBLIC read of the published portfolio.
 * No auth (added to middleware PUBLIC_PREFIXES). Serves ONLY the public-safe
 * subset of published, non-deleted entries. Gated by the portfolio_enabled
 * kill-switch: when off, returns { enabled: false, entries: [] } so the page shows
 * a "coming soon" state instead of the gallery.
 *
 * This is a SINGLE literal route — there are no public sub-routes under
 * /api/td-communication/portfolio (every mutating route lives under
 * /api/td-communication/admin/portfolio and self-authenticates).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const settings = await getCommSettings()
    if (!settings.portfolio_enabled) {
      return NextResponse.json({ enabled: false, entries: [], categories: [] })
    }
    const full = await listPublishedPortfolio()
    const entries = full.map(toPublicEntry)
    const categories = deriveCategories(full)
    return NextResponse.json({ enabled: true, entries, categories })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load the portfolio.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
