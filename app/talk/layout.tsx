import type { Metadata, Viewport } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { Providers } from '@/components/providers'
import { TalkShell } from '@/components/talk/talk-shell'

/**
 * TD Talk — the standalone Team Chat app (dev job c1e326dd; docs/systems/talk.md).
 *
 * A second installable app from the SAME site, next to the CRM app: its own name, icon, manifest and
 * service worker (public/talk-sw.js, scope /talk), and none of the CRM's chrome (no left menu, no header, no
 * sticky notes). The chat itself is the existing Team Chat page, re-exported by ./page.tsx — one set of
 * messages, one set of rules.
 *
 * AUTH: middleware.ts already sends a logged-out visitor to /login (keeping /talk as the return address),
 * enforces the two-step check, and confines clients and partners. The staff check below is the layout's own
 * (the CRM layout has none — it relies on middleware); TD Talk reads and writes INTERNAL chat, so it refuses
 * anyone who is not a dashboard user even if middleware ever changes.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#BE1E2D',
  // Let the page reach the screen edges on iPhone; TalkShell pads the bottom for the home indicator.
  viewportFit: 'cover',
}

export const metadata: Metadata = {
  title: 'TD Talk',
  description: 'Tony Durante LLC — team chat',
  manifest: '/talk/manifest.webmanifest',
  icons: {
    icon: [{ url: '/talk/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: '/talk/icons/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'TD Talk',
  },
}

export default async function TalkLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login?next=%2Ftalk')
  if (!isDashboardUser(user)) redirect('/')

  return (
    <Providers>
      <TalkShell sandbox={process.env.SANDBOX_MODE === '1'}>{children}</TalkShell>
    </Providers>
  )
}
