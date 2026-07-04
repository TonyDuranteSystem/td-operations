import type { Metadata } from 'next'
import { APP_BASE_URL } from '@/lib/config'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { listPublishedPortfolio } from '@/lib/td-communication/portfolio-queries'
import { toPublicEntry, deriveCategories } from '@/lib/td-communication/portfolio'
import { PublicPortfolio } from '@/components/td-communication/public-portfolio'

export const dynamic = 'force-dynamic'

/**
 * Public /portfolio page — TD Communication's showcase of completed branding work.
 * Unauthenticated (whitelisted in middleware PUBLIC_PREFIXES). Shows only PUBLISHED
 * entries and only when the portfolio_enabled kill-switch is on; otherwise a
 * "coming soon" state. Shareable, so it carries OG tags — but stays `noindex`
 * until the kill-switch is turned on.
 */
export async function generateMetadata(): Promise<Metadata> {
  let enabled = false
  let ogImage: string | null = null
  try {
    const settings = await getCommSettings()
    enabled = settings.portfolio_enabled
    if (enabled) {
      const entries = await listPublishedPortfolio()
      const hero = entries.find((e) => e.featured) ?? entries[0]
      ogImage = hero?.after_image_url ?? null
    }
  } catch {
    /* fall through to safe defaults (noindex, no image) */
  }
  const title = 'Our Work — TD Communication'
  const description = 'A selection of branding and identity projects designed for our clients.'
  return {
    title,
    description,
    robots: enabled ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      title,
      description,
      url: `${APP_BASE_URL}/portfolio`,
      type: 'website',
      images: ogImage ? [{ url: ogImage }] : undefined,
    },
    twitter: {
      card: ogImage ? 'summary_large_image' : 'summary',
      title,
      description,
      images: ogImage ? [ogImage] : undefined,
    },
  }
}

export default async function PortfolioPage() {
  const settings = await getCommSettings()

  if (!settings.portfolio_enabled) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-6">
        <div className="text-center max-w-md">
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-600 mb-3">TD Communication</p>
          <h1 className="text-3xl font-bold tracking-tight">Coming soon</h1>
          <p className="mt-3 text-zinc-500">Our portfolio of branding work is on its way. Check back shortly.</p>
        </div>
      </div>
    )
  }

  const full = await listPublishedPortfolio()
  const entries = full.map(toPublicEntry)
  const categories = deriveCategories(full)

  return <PublicPortfolio entries={entries} categories={categories} />
}
