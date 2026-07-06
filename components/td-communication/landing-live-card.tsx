'use client'

/**
 * TD Communication — "Your landing page is live" portal card (Phase 16).
 *
 * Self-hiding, client-facing. Mounted unconditionally in the delivered branch of
 * /portal/td-communication; it fetches its own state and renders nothing when the
 * kill-switch is off, the project isn't delivered, or no site is published.
 * Mirrors SocialKitCard. Bilingual EN/IT.
 */

import { useEffect, useState } from 'react'

const T = {
  en: {
    title: 'Your landing page is live',
    body: 'Your new brand landing page is published and ready to share.',
    view: 'View your page',
    copy: 'Copy link',
    copied: 'Link copied',
  },
  it: {
    title: 'La tua landing page è online',
    body: 'La landing page del tuo nuovo brand è pubblicata e pronta da condividere.',
    view: 'Vedi la tua pagina',
    copy: 'Copia link',
    copied: 'Link copiato',
  },
}

export function LandingLiveCard({ locale = 'en' }: { locale?: 'en' | 'it' }) {
  const t = T[locale] || T.en
  const [url, setUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/portal/td-communication/landing-site', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((d) => { if (alive && d.available && d.public_url) setUrl(d.public_url) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  if (!url) return null

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
      <h3 className="text-base font-semibold text-emerald-900">{t.title}</h3>
      <p className="mt-1 text-sm text-emerald-800">{t.body}</p>
      <p className="mt-2 text-sm break-all">
        <a href={url} target="_blank" rel="noreferrer" className="text-emerald-700 underline">{url}</a>
      </p>
      <div className="mt-3 flex gap-2">
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
          {t.view}
        </a>
        <button
          onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
          className="inline-flex items-center rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
        >
          {copied ? t.copied : t.copy}
        </button>
      </div>
    </div>
  )
}
