'use client'

/**
 * /offer/<token> — the link in the offer email. N0 (dev job f907220c).
 *
 * This page used to load the WHOLE offer with the public database key (access code,
 * commissions and internal notes included) and compare the client's email in the
 * browser — so the "gate" protected nothing, and it was a second, older copy of the
 * offer page without the package and payment-choice pickers.
 *
 * It is now only the gate: the email is checked on the server (/api/offers/gate), which
 * hands back the offer's access code, and the client continues on the real offer page
 * /offer/<token>/<code> — the same page the portal shows. Nothing about the offer is
 * sent to the browser before the email matches.
 */

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { offerGateInfo, offerGateCheck, OfferApiError } from '@/lib/offers/offer-api-client'

const LABELS = {
  en: {
    invalidLink: 'Invalid Link',
    invalidLinkMessage: 'This link does not contain a valid reference.',
    loading: 'Loading offer...',
    emailGateTitle: 'Verify Your Identity',
    emailGateMessage: 'Enter the email address associated with this proposal to view it.',
    emailGateButton: 'View Proposal',
    emailGateError: 'The email address does not match. Please try again.',
    emailPlaceholder: 'your@email.com',
    checking: 'Checking...',
  },
  it: {
    invalidLink: 'Link non valido',
    invalidLinkMessage: 'Questo link non contiene un riferimento valido.',
    loading: 'Caricamento offerta...',
    emailGateTitle: 'Verifica la tua identità',
    emailGateMessage: 'Inserisci l\'indirizzo email associato a questa proposta per visualizzarla.',
    emailGateButton: 'Visualizza Proposta',
    emailGateError: 'L\'indirizzo email non corrisponde. Riprova.',
    emailPlaceholder: 'tua@email.com',
    checking: 'Verifica in corso...',
  },
}

export default function OfferEmailGatePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = (params.token as string) || ''
  const legacyCode = searchParams.get('c') || ''
  const isPreview = searchParams.get('preview') === 'td'

  const [lang, setLang] = useState<'en' | 'it'>('it')
  const [loading, setLoading] = useState(true)
  const [emailInput, setEmailInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const L = LABELS[lang]

  function goToOffer(code: string) {
    const q = isPreview ? '?preview=td' : ''
    router.replace(`/offer/${encodeURIComponent(token)}/${encodeURIComponent(code)}${q}`)
  }

  useEffect(() => {
    if (!token) { setLoading(false); return }
    // Legacy ?c= links carry the code already.
    if (legacyCode) { goToOffer(legacyCode); return }
    let cancelled = false
    ;(async () => {
      try {
        const info = await offerGateInfo(token)
        if (!cancelled) setLang(info.language)
      } catch { /* default language */ }
      // A signed-in admin/team member skips the email (the server decides, not this flag).
      if (isPreview) {
        try {
          const { code } = await offerGateCheck(token, '', true)
          if (!cancelled && code) { goToOffer(code); return }
        } catch { /* not staff here — show the gate */ }
      }
      if (!cancelled) setLoading(false)
    })()
    // Prevent copy/print, as the offer page does.
    const handler = (e: Event) => e.preventDefault()
    document.addEventListener('contextmenu', handler)
    return () => { cancelled = true; document.removeEventListener('contextmenu', handler) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => { document.documentElement.lang = lang }, [lang])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (checking) return
    setChecking(true)
    setError(null)
    try {
      const { code } = await offerGateCheck(token, emailInput)
      goToOffer(code)
    } catch (err) {
      const msg = err instanceof OfferApiError && err.message !== 'email_mismatch' ? err.message : L.emailGateError
      setError(msg)
      setChecking(false)
    }
  }

  if (!token) {
    return (
      <>
        <GateStyles />
        <div className="offer-error-page"><div>
          <h1>{L.invalidLink}</h1>
          <p>{L.invalidLinkMessage}</p>
        </div></div>
      </>
    )
  }

  if (loading) {
    return (
      <>
        <GateStyles />
        <div className="offer-loading"><div className="offer-loading-spinner" /><span>{L.loading}</span></div>
      </>
    )
  }

  return (
    <>
      <GateStyles />
      <div className="offer-gate">
        <div className="offer-gate-box">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/logo.jpg" alt="Tony Durante LLC" className="offer-gate-logo" />
          <h2>{L.emailGateTitle}</h2>
          <p>{L.emailGateMessage}</p>
          <form onSubmit={handleSubmit}>
            <input
              type="email"
              value={emailInput}
              onChange={(e) => { setEmailInput(e.target.value); setError(null) }}
              placeholder={L.emailPlaceholder}
              className={`offer-gate-input${error ? ' offer-gate-input-error' : ''}`}
              required
              autoFocus
            />
            {error && <div className="offer-gate-error-msg">{error}</div>}
            <button type="submit" className="offer-gate-btn" disabled={checking}>{checking ? L.checking : L.emailGateButton}</button>
          </form>
        </div>
      </div>
    </>
  )
}

function GateStyles() {
  return (
    <style jsx global>{`
      body { background: #f7f8fa !important; color: #374151 !important; font-family: 'Source Sans 3', -apple-system, sans-serif !important; line-height: 1.7 !important; -webkit-font-smoothing: antialiased; }
      @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=Source+Sans+3:wght@300;400;500;600;700&display=swap');
      @media print { body { display: none !important; } }
      :root { --offer-red: #b8292f; --offer-blue: #1e3a5f; --offer-gray-200: #edf0f4; --offer-gray-500: #6b7280; }
      .offer-gate { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
      .offer-gate-box { background: #fff; padding: 48px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; max-width: 440px; width: 100%; }
      .offer-gate-logo { height: 48px; margin-bottom: 24px; }
      .offer-gate-box h2 { font-family: 'Playfair Display', serif; font-size: 24px; color: var(--offer-blue); margin-bottom: 8px; }
      .offer-gate-box p { font-size: 15px; color: var(--offer-gray-500); margin-bottom: 24px; line-height: 1.6; }
      .offer-gate-input { width: 100%; padding: 14px 16px; border: 2px solid var(--offer-gray-200); border-radius: 8px; font-size: 16px; outline: none; transition: border-color .2s; box-sizing: border-box; }
      .offer-gate-input:focus { border-color: var(--offer-blue); }
      .offer-gate-input-error { border-color: var(--offer-red) !important; }
      .offer-gate-error-msg { color: var(--offer-red); font-size: 14px; margin-top: 8px; }
      .offer-gate-btn { display: block; width: 100%; margin-top: 16px; padding: 14px; background: var(--offer-blue); color: #fff; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background .2s; }
      .offer-gate-btn:hover { background: #162d4a; }
      .offer-gate-btn:disabled { opacity: .7; cursor: wait; }
      .offer-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-size: 18px; color: var(--offer-gray-500); }
      .offer-loading-spinner { width: 40px; height: 40px; border: 3px solid var(--offer-gray-200); border-top-color: var(--offer-red); border-radius: 50%; animation: offer-spin 1s linear infinite; margin-bottom: 16px; }
      @keyframes offer-spin { to { transform: rotate(360deg); } }
      .offer-error-page { display: flex; align-items: center; justify-content: center; height: 100vh; text-align: center; }
      .offer-error-page h1 { color: var(--offer-red); font-family: 'Playfair Display', serif; margin-bottom: 12px; }
      .offer-error-page p { color: var(--offer-gray-500); }
    `}</style>
  )
}
