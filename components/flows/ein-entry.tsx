'use client'

import { useState, useEffect, useCallback } from 'react'
import { Shield, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

interface EinEntryProps {
  serviceDeliveryId: string
  /** SD's account_id — empty until the company is materialized. */
  accountId?: string | null
}

// Accept both the auto-formatted "XX-XXXXXXX" and bare 9 digits "XXXXXXXXX"
// (the server's normalizeEin strips non-digits, so both are valid).
const EIN_RE = /^\d{2}-?\d{7}$/

/**
 * EIN entry for the Company Formation "EIN Received" stage. Reads the account's
 * current EIN (GET /api/flows/[id]/save-ein); if already set, shows it read-only.
 * Otherwise offers an input (XX-XXXXXXX) + Save, which POSTs to record the EIN
 * and notify the client (portal notification + chat). Surfaces server errors
 * verbatim (R099).
 */
export function EinEntry({ serviceDeliveryId, accountId }: EinEntryProps) {
  const [ein, setEin] = useState('')
  const [savedEin, setSavedEin] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasAccount = !!accountId

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/save-ein`)
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success && data.ein_number) setSavedEin(data.ein_number)
    } finally {
      setLoaded(true)
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    load()
  }, [load])

  async function save() {
    const value = ein.trim()
    if (!EIN_RE.test(value)) {
      setError('Enter a valid EIN — 9 digits (XX-XXXXXXX).')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/save-ein`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ein: value }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not save the EIN.')
      }
      setSavedEin(data.ein_number || value)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not save the EIN.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <Shield className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">EIN (Employer Identification Number)</h3>
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : savedEin ? (
        // ── Already recorded ──
        <div className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          EIN: {savedEin}
        </div>
      ) : !hasAccount ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          The CRM account isn&apos;t created yet — the EIN can be recorded once the company exists.
        </p>
      ) : (
        // ── Entry ──
        <div className="space-y-3">
          <p className="text-sm text-zinc-500">Enter the EIN from the CP 575 letter. The client is notified that formation is complete.</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={ein}
              onChange={(e) => {
                let v = e.target.value.replace(/[^0-9]/g, '') // strip non-digits
                if (v.length > 2) v = v.slice(0, 2) + '-' + v.slice(2) // auto-insert dash after 2 digits
                if (v.length > 10) v = v.slice(0, 10) // cap at XX-XXXXXXX (10 chars)
                setEin(v)
              }}
              placeholder="XX-XXXXXXX"
              inputMode="numeric"
              maxLength={10}
              className="w-40 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-mono tracking-wide focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <button
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
              Save EIN
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
