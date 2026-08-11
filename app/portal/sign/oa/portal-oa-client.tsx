'use client'

import { useEffect, useState, useCallback } from 'react'
import { FileText, CheckCircle, Clock, PenLine, Send } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface PortalOAClientProps {
  oaUrl: string
  status: string
  companyName: string
  language?: string
  /** Shown only for a multi-member agreement that is not yet fully signed. */
  accountId?: string
  canResend?: boolean
}

const STATUS_INFO: Record<string, { en: string; it: string; icon: typeof FileText; color: string; bg: string }> = {
  draft: { en: 'Operating Agreement Ready', it: 'Operating Agreement Pronto', icon: PenLine, color: 'text-blue-600', bg: 'bg-blue-50' },
  sent: { en: 'Operating Agreement Ready', it: 'Operating Agreement Pronto', icon: PenLine, color: 'text-blue-600', bg: 'bg-blue-50' },
  viewed: { en: 'Awaiting Your Signature', it: 'In Attesa della Tua Firma', icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
  signed: { en: 'Signed', it: 'Firmato', icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' },
}

const SUBTITLES: Record<string, { en: string; it: string }> = {
  signed: { en: 'Your Operating Agreement has been signed and saved.', it: 'Il tuo Operating Agreement \u00e8 stato firmato e salvato.' },
  default: { en: 'Review and sign your Operating Agreement below.', it: 'Rivedi e firma il tuo Operating Agreement qui sotto.' },
}

export function PortalOAClient({ oaUrl, status, companyName, language, accountId, canResend }: PortalOAClientProps) {
  const router = useRouter()
  const [currentStatus, setCurrentStatus] = useState(status)
  const [resending, setResending] = useState(false)
  const [resendMsg, setResendMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const info = STATUS_INFO[currentStatus] || STATUS_INFO.sent
  const Icon = info.icon
  const lang = (language === 'it' ? 'it' : 'en') as 'en' | 'it'
  const subtitle = SUBTITLES[currentStatus] || SUBTITLES.default

  const handleResend = useCallback(async () => {
    if (!accountId || resending) return
    setResending(true)
    setResendMsg(null)
    try {
      const res = await fetch('/api/portal/operating-agreement/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResendMsg({ ok: false, text: data.error || (lang === 'it' ? 'Impossibile inviare i link. Riprova.' : 'Could not send the links. Please try again.') })
      } else {
        const n = data.reissued ?? 0
        setResendMsg({
          ok: true,
          text: lang === 'it'
            ? `Nuovi link di firma inviati a ${n} ${n === 1 ? 'socio' : 'soci'} via email.`
            : `Fresh signing links emailed to ${n} member${n === 1 ? '' : 's'}.`,
        })
      }
    } catch {
      setResendMsg({ ok: false, text: lang === 'it' ? 'Errore di connessione. Riprova.' : 'Connection error. Please try again.' })
    } finally {
      setResending(false)
    }
  }, [accountId, resending, lang])

  // Listen for postMessage from embedded OA page when signing completes.
  const handleMessage = useCallback((event: MessageEvent) => {
    // Only trust our own signing page. Without this any embedded/opener frame
    // could flip the client's agreement banner to "Signed". Note `.tonydurante.us`
    // with the leading dot is deliberate — a lookalike like "evil-tonydurante.us"
    // does not match. Sandbox/local origins are accepted too, or this cannot be
    // QA'd anywhere but production.
    const trusted =
      event.origin === window.location.origin ||
      event.origin.endsWith('.tonydurante.us') ||
      event.origin.endsWith('.vercel.app') ||
      event.origin.startsWith('http://localhost')
    if (!trusted) return
    if (event.data?.type === 'oa-signed') {
      // A multi-owner agreement is NOT signed when one owner signs — announcing
      // "signed and saved" to a partial signer was wrong (it self-corrected on
      // the refresh a second and a half later, but the client saw it).
      if (event.data?.allSigned === false) {
        setTimeout(() => router.refresh(), 1200)
        return
      }
      setCurrentStatus('signed')
      // Refresh the dashboard after a short delay to update checklist
      setTimeout(() => router.refresh(), 1500)
    }
  }, [router])

  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Status bar */}
      <div className={`${info.bg} border-b px-6 py-3 flex items-center gap-3`}>
        <Icon className={`h-5 w-5 ${info.color}`} />
        <div className="flex-1">
          <p className={`text-sm font-semibold ${info.color}`}>{info[lang]}</p>
          <p className="text-xs text-zinc-500">{subtitle[lang]}</p>
        </div>
        {/* Re-send signing links — only for a multi-member agreement still awaiting
            signatures. Rotates + re-emails the pending members' personal links (a
            15-day window), so the account owner can fix an expired link without staff. */}
        {canResend && currentStatus !== 'signed' && accountId && (
          <button
            onClick={handleResend}
            disabled={resending}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
          >
            <Send className="h-3.5 w-3.5" />
            {resending
              ? (lang === 'it' ? 'Invio…' : 'Sending…')
              : (lang === 'it' ? 'Reinvia i link di firma' : 'Re-send signing links')}
          </button>
        )}
      </div>
      {resendMsg && (
        <div className={`px-6 py-2 text-xs ${resendMsg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {resendMsg.text}
        </div>
      )}

      {/* OA iframe */}
      <iframe
        src={oaUrl}
        className="flex-1 w-full border-0"
        title={`Operating Agreement for ${companyName}`}
        allow="clipboard-write"
      />
    </div>
  )
}
