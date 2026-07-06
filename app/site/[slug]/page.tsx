import type { Metadata } from 'next'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { getPublishedSiteBySlug } from '@/lib/td-communication/client-landing-queries'
import { ClientLandingRenderer } from '@/components/td-communication/client-landing/client-landing-renderer'

// Read settings + DB at request time; a kill-switch flip / re-publish must take
// effect immediately, and [slug] can't be statically enumerated.
export const dynamic = 'force-dynamic'

/**
 * Resolve the live site for a slug, gated by the kill-switch. Returns null when
 * the feature is off OR nothing is published at that slug (the two-condition
 * go-live: published AND landing_builder_enabled).
 */
async function resolveLive(slug: string) {
  const settings = await getCommSettings()
  if (!settings.landing_builder_enabled) return null
  return getPublishedSiteBySlug(slug)
}

export async function generateMetadata(
  { params }: { params: { slug: string } },
): Promise<Metadata> {
  let live = null
  try {
    live = await resolveLive(params.slug)
  } catch {
    live = null
  }
  if (!live) {
    return { title: 'Coming soon', robots: { index: false, follow: false } }
  }
  return {
    title: live.title || 'Landing page',
    // A published client site is meant to be found — allow indexing when live.
    robots: { index: true, follow: true },
    openGraph: {
      title: live.title || 'Landing page',
      images: live.theme.logo_url ? [live.theme.logo_url] : undefined,
    },
  }
}

export default async function ClientLandingPage(
  { params }: { params: { slug: string } },
) {
  let live = null
  try {
    live = await resolveLive(params.slug)
  } catch {
    live = null
  }

  if (!live) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', color: '#6b7280', padding: 24, textAlign: 'center' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#374151' }}>Coming soon</h1>
          <p>This page isn&rsquo;t available yet.</p>
        </div>
      </main>
    )
  }

  return (
    <main style={{ minHeight: '100vh' }}>
      <ClientLandingRenderer title={live.title} theme={live.theme} sections={live.sections} />
    </main>
  )
}
