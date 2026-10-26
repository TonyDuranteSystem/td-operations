'use client'

import { useState } from 'react'
import { useT } from '@/components/marketing/lang-provider'
import { WA_WEB_HOME, WA_WINDOW_FEATURES, WA_WINDOW_NAME } from '@/lib/marketing/whatsapp-web'

/** Opens WhatsApp Web in its own window (the same window every time), where the person links his phone once with the QR code. */
export function WhatsAppOpen() {
  const t = useT()
  const [blocked, setBlocked] = useState(false)
  return (
    <div className="mt-4 space-y-2">
      <button type="button" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white" data-testid="wa-open-home"
        onClick={() => { const w = window.open(WA_WEB_HOME, WA_WINDOW_NAME, WA_WINDOW_FEATURES); if (w) { w.focus(); setBlocked(false) } else setBlocked(true) }}>
        {t('Open WhatsApp Web')}
      </button>
      <p className="text-xs text-slate-500">{t('It will ask for the QR code the first time.')}</p>
      {blocked && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{t('Your browser blocked the WhatsApp window. Allow pop-ups for this site and try again.')}</p>}
    </div>
  )
}
