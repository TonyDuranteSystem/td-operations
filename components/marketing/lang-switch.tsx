'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLang } from '@/components/marketing/lang-provider'
import type { Lang } from '@/lib/marketing/templates'

/** IT | EN — the person's own language, kept in their own browser. */
export function LangSwitch() {
  const router = useRouter()
  const lang = useLang()
  const [busy, setBusy] = useState(false)
  async function pick(next: Lang) {
    if (next === lang || busy) return
    setBusy(true)
    try { await fetch('/api/marketing/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: next }) }) } finally { setBusy(false) }
    router.refresh()
  }
  const cls = (on: boolean) => `rounded px-2 py-0.5 text-xs ${on ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Language / Lingua" data-testid="lang-switch">
      <button type="button" className={cls(lang === 'it')} aria-pressed={lang === 'it'} onClick={() => pick('it')}>IT</button>
      <button type="button" className={cls(lang === 'en')} aria-pressed={lang === 'en'} onClick={() => pick('en')}>EN</button>
    </div>
  )
}
