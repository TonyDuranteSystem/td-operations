'use client'

/**
 * Portal error boundary.
 *
 * ⚠️ THIS PAGE IS AN ALARM, NOT JUST A SCREEN (dev job `61f184ca`, 2026-08-12).
 *
 * It used to do two things wrong, both of the same class the job that found it was
 * about — a failure that looks handled and tells nobody:
 *
 *   1. It reported NOTHING. The only trace was `console.error` in the client's own
 *      browser, which we never see. So the identical failure was alarmed when it
 *      happened on the server (the Operating Agreement route reports before it
 *      refuses) and completely silent when it surfaced here — and this boundary
 *      catches, among other things, the member-record read failure that the same
 *      job deliberately made throw rather than degrade.
 *   2. It was ENGLISH ONLY, on a portal that is otherwise bilingual. An Italian
 *      client hit an English wall at the exact moment something had gone wrong.
 *
 * Reporting is fire-and-forget and must never throw: this component is the last
 * thing standing between the client and a blank page.
 */

import { useEffect } from 'react'
import { AlertCircle, RotateCcw, MessageCircle } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'

const COPY: Record<string, Record<string, string>> = {
  title: { en: 'Something went wrong', it: 'Qualcosa è andato storto' },
  body: {
    en: 'We hit an unexpected problem loading this page. Nothing you did caused it, and nothing has been changed.',
    it: 'Si è verificato un problema imprevisto nel caricamento della pagina. Non è colpa tua e non è stato modificato nulla.',
  },
  errorId: { en: 'Error ID', it: 'ID errore' },
  retry: { en: 'Try Again', it: 'Riprova' },
  support: { en: 'Contact Support', it: 'Contatta il Supporto' },
  // Says explicitly that we have been told — otherwise a client waits, assuming
  // someone is looking, when previously nobody was.
  reported: {
    en: 'Our team has been notified automatically. If it keeps happening, write to support@tonydurante.us',
    it: 'Il nostro team è stato avvisato automaticamente. Se il problema persiste, scrivi a support@tonydurante.us',
  },
}

function t(key: string, locale: string): string {
  return COPY[key]?.[locale] || COPY[key]?.['en'] || key
}

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { locale } = useLocale()
  const lang = locale || 'en'

  useEffect(() => {
    console.error('Portal error:', error)

    // Fire-and-forget, and deliberately un-awaited: a reporting failure must not
    // replace the error screen with another error. `digest` is the server-side
    // correlation id Next puts on the boundary — it is what makes the alarm
    // joinable to the actual stack in the platform logs.
    void fetch('/api/system-errors/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        route: 'portal-error-boundary',
        method: 'RENDER',
        page_path: typeof window !== 'undefined' ? window.location.pathname : null,
        message: error.message || 'Unhandled error in the client portal',
        context: { digest: error.digest ?? null, name: error.name ?? null },
      }),
    }).catch(() => {})
  }, [error])

  return (
    <div className="min-h-[50vh] flex items-center justify-center p-6">
      <div className="text-center max-w-md">
        <div className="mx-auto mb-4 p-3 rounded-full bg-red-50 w-fit">
          <AlertCircle className="h-10 w-10 text-red-400" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-900 mb-2">{t('title', lang)}</h2>
        <p className="text-sm text-zinc-500 mb-1">{t('body', lang)}</p>
        {error.digest && (
          <p className="text-xs text-zinc-400 mb-4 font-mono">
            {t('errorId', lang)}: {error.digest}
          </p>
        )}
        <div className="flex items-center justify-center gap-3 mt-4">
          <button
            onClick={reset}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <RotateCcw className="h-4 w-4" />
            {t('retry', lang)}
          </button>
          <a
            href="/portal/chat"
            className="flex items-center gap-2 px-4 py-2 text-sm border border-zinc-200 text-zinc-600 rounded-lg hover:bg-zinc-50 transition-colors"
          >
            <MessageCircle className="h-4 w-4" />
            {t('support', lang)}
          </a>
        </div>
        <p className="text-xs text-zinc-400 mt-4">{t('reported', lang)}</p>
      </div>
    </div>
  )
}
