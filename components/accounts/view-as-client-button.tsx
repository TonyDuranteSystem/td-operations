'use client'

import { useState } from 'react'
import { Eye, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

/**
 * Admin-only "View as client" button. Opens a read-only portal session as the
 * given contact in a new tab. Render this only for true admins and only when the
 * contact has a portal login (the API also enforces both, returning a clean
 * `no_login` reason otherwise — surfaced per R099).
 *
 * `note`: set by the account page when `contactId` is a stand-in for a
 * different co-member who hasn't finished their own portal setup — shown to
 * staff at click time so it's clear WHO they're actually looking at and why
 * (KS Media Consulting LLC, 2026-08-21).
 */
export function ViewAsClientButton({
  contactId,
  label = 'View as client',
  note,
}: {
  contactId: string
  label?: string
  note?: string | null
}) {
  const [loading, setLoading] = useState(false)

  async function handleClick() {
    if (loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/admin/view-as', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Could not open the client view. Please try again.')
      }
      if (data.reason === 'no_login') {
        toast.error('This client has no portal login, so there is nothing to view.')
        return
      }
      if (data.ok && data.url) {
        if (note) toast.info(note)
        window.open(data.url, '_blank', 'noopener,noreferrer')
      } else {
        throw new Error('Could not open the client view. Please try again.')
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not open the client view.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      title="Open this client's portal as they see it (read-only)"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-zinc-300 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 transition-colors"
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
      {label}
    </button>
  )
}
