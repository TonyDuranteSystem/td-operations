'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'

/** "Pick this lead" for a Good lead waiting. Takes the lead (one person only) and opens it. The server's refusal (someone was faster) is shown as written (R099). */
export function PickButton({ leadId }: { leadId: string }) {
  const router = useRouter()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function pick() {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'claim' }) })
      if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; throw new Error(d.error ? t(d.error) : t('Could not pick this lead. Please try again.')) }
      router.push(`/marketing/leads?lead=${leadId}`)
    } catch (e) { setError(e instanceof Error && e.message ? e.message : t('Could not pick this lead. Please try again.')); setBusy(false) }
  }
  return (
    <div>
      <button className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={pick}>{busy ? t('Picking…') : t('Pick this lead')}</button>
      {error && <p role="alert" className="mt-1 text-xs text-rose-700">{error}</p>}
    </div>
  )
}
