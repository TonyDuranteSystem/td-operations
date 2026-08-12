'use client'

/**
 * LEGACY bare-token Operating Agreement URL — now a PURE REDIRECT.
 *
 * ⛔ WHY THIS IS NO LONGER A SIGNING PAGE.
 *
 * This page used to render the whole agreement and sign it IN THE BROWSER: it
 * screenshotted itself with html2pdf, uploaded the PDF with the anon key, and
 * wrote status/signed_at/pdf_path straight into oa_agreements with the anon key.
 * That anon write is the last of the browser-side signing holes (the canonical
 * `[token]/[code]` page moved signing fully server-side to
 * /api/operating-agreement/[token]/sign). The anon UPDATE grant on oa_agreements
 * is being revoked, so this code path is already dead — keeping it would only be
 * a dead, confusing surface that still uploaded to the signed bucket.
 *
 * What remains is the ONE thing this URL still legitimately does: old links carry
 * the access code as `?c=<code>`, so redirect those to the current
 * `/{token}/{code}` route (R015 — old links must keep working). Anything without a
 * code is sent to the portal, which is where clients sign now.
 */

import { Suspense, useEffect } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'

function LegacyOARedirect() {
  const { token } = useParams<{ token: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()

  useEffect(() => {
    const code = searchParams.get('c')
    if (code && token) {
      // Preserve the preview flag so a staff ?c=…&preview=td link still previews.
      const preview = searchParams.get('preview')
      router.replace(`/operating-agreement/${token}/${code}${preview ? `?preview=${preview}` : ''}`)
    }
  }, [token, searchParams, router])

  const hasCode = !!searchParams.get('c')

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontFamily: 'Georgia, "Times New Roman", serif', background: '#f8f8f8', padding: 24 }}>
      <div style={{ textAlign: 'center', maxWidth: 460 }}>
        <h2 style={{ color: '#222', marginBottom: 8 }}>Operating Agreement</h2>
        {hasCode ? (
          <p style={{ color: '#888' }}>Opening your Operating Agreement…</p>
        ) : (
          <p style={{ color: '#666', fontSize: 15, lineHeight: 1.6 }}>
            To view or sign your Operating Agreement, please open it from your{' '}
            <a href="https://portal.tonydurante.us/portal/sign/oa" style={{ color: '#0A3161', fontWeight: 600 }}>Tony Durante portal</a>.
            If you reached this page from an old link, contact{' '}
            <a href="mailto:support@tonydurante.us" style={{ color: '#0A3161' }}>support@tonydurante.us</a>.
          </p>
        )}
      </div>
    </div>
  )
}

export default function OperatingAgreementLegacyPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh' }} />}>
      <LegacyOARedirect />
    </Suspense>
  )
}
