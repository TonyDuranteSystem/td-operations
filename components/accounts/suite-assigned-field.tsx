'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, Lock, Loader2, Plus, Pencil } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { toast } from 'sonner'
import { issueCompanySuite, changeCompanySuite } from '@/app/(dashboard)/accounts/actions'

interface Props {
  accountId: string
  suite: string | null
  isAdmin: boolean
}

/**
 * "Suite Assigned" in Company Info. The suite is issued by the system (next free number) and LOCKED:
 * nobody types a number. No suite yet -> "Issue suite". Changing or removing a locked suite is the
 * owner's admin action (reason required, logged) — the server refuses anyone else.
 */
export function SuiteAssignedField({ accountId, suite, isAdmin }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [changing, setChanging] = useState(false)
  const [newSuite, setNewSuite] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const issue = async () => {
    setBusy(true)
    const result = await issueCompanySuite(accountId)
    setBusy(false)
    if (result.success) {
      toast.success(`Suite ${result.suite} issued`)
      router.refresh()
    } else {
      toast.error(result.error ?? 'Could not issue the suite')
    }
  }

  const change = async () => {
    setBusy(true)
    setError(null)
    const result = await changeCompanySuite(accountId, newSuite.trim() === '' ? null : newSuite.trim(), reason)
    setBusy(false)
    if (result.success) {
      toast.success('Suite changed')
      if ((result.signedLeasesToReplace ?? 0) > 0) {
        toast.warning(`${result.signedLeasesToReplace} signed lease(s) still show the old suite — delete and reissue them.`)
      }
      setChanging(false)
      setNewSuite('')
      setReason('')
      router.refresh()
    } else {
      setError(result.error ?? 'Could not change the suite')
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 group">
        <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground min-w-[100px] text-sm">Suite Assigned</span>
        {suite ? (
          <span className="font-medium text-sm flex-1 flex items-center gap-1.5">
            {suite}
            <Lock className="h-3 w-3 text-muted-foreground" aria-label="Locked" />
          </span>
        ) : (
          <span className="text-sm flex-1 text-muted-foreground">Not issued yet</span>
        )}
        {!suite && (
          <button
            type="button"
            onClick={issue}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded border hover:bg-zinc-50 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Issue suite
          </button>
        )}
        {suite && isAdmin && !changing && (
          <FastTooltip label="Change suite (owner only)">
            <button
              type="button"
              onClick={() => setChanging(true)}
              className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-zinc-100 transition-opacity"
              aria-label="Change suite (owner only)"
            >
              <Pencil className="h-3 w-3 text-muted-foreground" />
            </button>
          </FastTooltip>
        )}
      </div>
      {changing && (
        <div className="ml-6 space-y-1.5 rounded border p-2">
          <p className="text-xs text-muted-foreground">
            Owner only. The suite is locked — this is the one logged way to change it. Leave the suite empty to take it off the company.
          </p>
          <input
            value={newSuite}
            onChange={e => setNewSuite(e.target.value)}
            placeholder="New suite, e.g. 3D-318"
            className="w-full px-2 py-1 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Reason (required)"
            className="w-full px-2 py-1 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={change}
              disabled={busy || reason.trim() === ''}
              className="px-2 py-1 text-xs rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Change suite'}
            </button>
            <button
              type="button"
              onClick={() => { setChanging(false); setError(null) }}
              disabled={busy}
              className="px-2 py-1 text-xs rounded bg-zinc-50 hover:bg-zinc-100 text-zinc-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
