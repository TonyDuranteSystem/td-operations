/**
 * Public PWA install page — /portal/install?src=<channel>
 *
 * Lives in the (portal-install) route group ON PURPOSE: the URL stays inside
 * the /portal/ SW+manifest scope (required for installability), but the page
 * escapes app/portal/layout.tsx — so a logged-IN visitor doesn't get the full
 * sidebar shell (with the floating install prompt sliding over this very
 * page), and a logged-OUT QR scanner gets a designed page instead of bare
 * children (council finding, dev job 8f38add1).
 *
 * No session, no client data: the middleware allowlists this path. Language
 * is resolved from Accept-Language (no contact record is reachable here) and
 * refined client-side.
 */
import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import QRCode from 'qrcode'
import { PORTAL_BASE_URL } from '@/lib/config'
import {
  detectDevice,
  resolveInstallLanguage,
  normalizeInstallSrc,
} from '@/lib/portal/install-page-mode'
import { InstallPageClient } from './install-client'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#BE1E2D',
}

export const metadata: Metadata = {
  title: 'TD Portal — Install',
  description: 'Tony Durante LLC — Client Portal',
  // Same manifest the portal layout links: the page must satisfy Chrome
  // installability on its own, without the portal shell.
  manifest: '/portal/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'TD Portal',
  },
}

export default async function InstallPage({
  searchParams,
}: {
  searchParams: { src?: string; lang?: string }
}) {
  const headerList = headers()
  const params = searchParams
  const userAgent = headerList.get('user-agent') || ''
  const acceptLanguage = headerList.get('accept-language')

  const initialDevice = detectDevice(userAgent)
  const initialLanguage = params.lang === 'it' || params.lang === 'en'
    ? params.lang
    : resolveInstallLanguage(acceptLanguage)
  const src = normalizeInstallSrc(params.src ?? null)

  // Desktop mode renders a QR pointing back at this page. Generated at
  // request time from PORTAL_BASE_URL (R012 — never a hardcoded domain, and
  // nothing committed that can go stale).
  const qrSvg = await QRCode.toString(
    `${PORTAL_BASE_URL}/portal/install?src=qr-desktop`,
    { type: 'svg', margin: 1, width: 220, color: { dark: '#18181b', light: '#ffffff' } },
  )

  return (
    <InstallPageClient
      initialDevice={initialDevice}
      initialLanguage={initialLanguage}
      src={src}
      qrSvg={qrSvg}
      installUrl={`${PORTAL_BASE_URL}/portal/install`}
    />
  )
}
