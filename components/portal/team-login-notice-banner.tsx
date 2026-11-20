'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'

/**
 * Team Powers step 6 — the banner a team login sees until it accepts its own notice.
 *
 * Drawn by the portal layout ONLY for a team login that has no notice on file. The words are built on the server (in the person's
 * language, with their real powers) and passed in; the server saves them again when the button is pressed, so what is saved is
 * what the server built, never what this screen sent. Until the person accepts, the rest of the portal gives them nothing but
 * the home page (see resolvePortalIdentity).
 */
export interface TeamLoginNoticeBannerProps {
  lang: 'en' | 'it'
  bannerTitle: string
  limitLine: string
  acceptLabel: string
  notice: {
    version: string
    title: string
    powersIntro: string
    powers: string[]
    responsibility: string
    never: string
  }
}

export function TeamLoginNoticeBanner({ lang, bannerTitle, limitLine, acceptLabel, notice }: TeamLoginNoticeBannerProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function accept() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/portal/team/accept-notice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: notice.version }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (lang === 'it' ? 'Non siamo riusciti a salvare. Riprova.' : 'We could not save this. Please try again.'))
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : lang === 'it' ? 'Non siamo riusciti a salvare. Riprova.' : 'We could not save this. Please try again.')
      setBusy(false)
    }
  }

  return (
    <section
      role="region"
      aria-label={bannerTitle}
      data-testid="team-login-notice-banner"
      className="mx-4 mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 sm:mx-6 lg:mx-8"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100">
          <ShieldCheck className="h-4 w-4 text-amber-700" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-950">{bannerTitle}</p>
          <p className="mt-0.5 text-xs text-amber-800">{limitLine}</p>

          <div className="mt-3 rounded-lg border border-amber-200 bg-white px-3 py-3 text-sm text-zinc-800">
            <p className="font-medium">{notice.title}</p>
            <p className="mt-2 text-zinc-600">{notice.powersIntro}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {notice.powers.length ? notice.powers.map((p) => <li key={p}>{p}</li>) : <li>{lang === 'it' ? '(nessun potere selezionato)' : '(no powers ticked)'}</li>}
            </ul>
            <p className="mt-3">{notice.responsibility}</p>
            <p className="mt-2">{notice.never}</p>
          </div>

          {error && (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={accept}
            disabled={busy}
            className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-60"
          >
            {busy ? (lang === 'it' ? 'Salvataggio…' : 'Saving…') : acceptLabel}
          </button>
        </div>
      </div>
    </section>
  )
}
