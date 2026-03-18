'use client'

import { useState } from 'react'
import { UserPlus, Loader2, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

interface PortalUserButtonProps {
  accountId: string
  portalAccount: boolean
}

export function PortalUserButton({ accountId, portalAccount }: PortalUserButtonProps) {
  const [loading, setLoading] = useState(false)
  const [created, setCreated] = useState(portalAccount)

  if (created) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 text-sm">
        <CheckCircle2 className="h-4 w-4" />
        Portal account active
      </div>
    )
  }

  const handleCreate = async () => {
    if (!confirm('Create a portal account for this client? They will receive login credentials.')) return

    setLoading(true)
    try {
      const res = await fetch('/api/portal/admin/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
      })
      const data = await res.json()

      if (res.ok) {
        toast.success(data.message)
        setCreated(true)
      } else {
        toast.error(data.error ?? 'Failed to create portal account')
      }
    } catch {
      toast.error('Failed to create portal account')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleCreate}
      disabled={loading}
      className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 text-sm hover:bg-blue-100 disabled:opacity-50 transition-colors"
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
      Create Portal Account
    </button>
  )
}
