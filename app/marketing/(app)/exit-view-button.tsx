'use client'

import { useState } from 'react'

/** Stops "view as" and returns Antonio to the CRM Teams page. */
export function ExitViewButton() {
  const [busy, setBusy] = useState(false)
  return (
    <button className="rounded-lg border border-amber-700 bg-white px-3 py-1 text-xs font-medium text-amber-900 disabled:opacity-50" disabled={busy}
      onClick={async () => { setBusy(true); await fetch('/api/marketing-admin/view-as', { method: 'DELETE' }).catch(() => null); window.location.href = '/marketing-leads/teams' }}>
      {busy ? 'Leaving…' : 'Exit view'}
    </button>
  )
}
