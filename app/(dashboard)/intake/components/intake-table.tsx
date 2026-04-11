'use client'

import { useTransition, useState } from 'react'
import { toast } from 'sonner'
import { UserPlus, Link2, X, Phone, Loader2, Check, ExternalLink } from 'lucide-react'
import { createLeadFromIntake, linkIntakeToExisting, dismissIntake } from '../actions'
import type { IntakeEntry } from '../page'
import { useRouter } from 'next/navigation'

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  pending_review: { label: 'Pending', className: 'bg-amber-100 text-amber-700' },
  auto_linked: { label: 'Auto-linked', className: 'bg-blue-100 text-blue-700' },
  converted: { label: 'Converted', className: 'bg-emerald-100 text-emerald-700' },
  linked: { label: 'Linked', className: 'bg-indigo-100 text-indigo-700' },
  lost: { label: 'Lost', className: 'bg-zinc-100 text-zinc-500' },
  dismissed: { label: 'Dismissed', className: 'bg-zinc-100 text-zinc-400' },
}

interface IntakeTableProps {
  entries: IntakeEntry[]
  readonly?: boolean
}

export function IntakeTable({ entries, readonly = false }: IntakeTableProps) {
  return (
    <div className="bg-white rounded-lg border divide-y">
      {entries.map(entry => (
        <IntakeRow key={entry.id} entry={entry} readonly={readonly} />
      ))}
    </div>
  )
}

function IntakeRow({ entry, readonly }: { entry: IntakeEntry; readonly: boolean }) {
  const [isPending, startTransition] = useTransition()
  const [processed, setProcessed] = useState(false)
  const [linkMode, setLinkMode] = useState(false)
  const [linkLeadId, setLinkLeadId] = useState('')
  const router = useRouter()

  const { parsed, matches, circleback_match } = entry
  const badge = STATUS_BADGES[entry.review_status] || STATUS_BADGES.pending_review

  const formatDate = (d: string) => {
    try {
      return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    } catch {
      return d
    }
  }

  const handleCreateLead = () => {
    startTransition(async () => {
      const result = await createLeadFromIntake(entry.id, circleback_match?.id)
      if (result.success) {
        toast.success(`Lead created${circleback_match ? ' with call linked' : ''}`)
        setProcessed(true)
        router.refresh()
      } else {
        toast.error(result.error || 'Failed')
      }
    })
  }

  const handleLink = () => {
    if (!linkLeadId.trim()) {
      toast.error('Enter a lead ID')
      return
    }
    startTransition(async () => {
      const result = await linkIntakeToExisting(entry.id, linkLeadId.trim())
      if (result.success) {
        toast.success('Linked to existing lead')
        setProcessed(true)
        setLinkMode(false)
        router.refresh()
      } else {
        toast.error(result.error || 'Failed')
      }
    })
  }

  const handleDismiss = (status: 'lost' | 'dismissed') => {
    startTransition(async () => {
      const result = await dismissIntake(entry.id, status)
      if (result.success) {
        toast.success(status === 'lost' ? 'Marked as lost' : 'Dismissed')
        setProcessed(true)
        router.refresh()
      } else {
        toast.error(result.error || 'Failed')
      }
    })
  }

  if (processed) {
    return (
      <div className="px-4 py-3 flex items-center gap-2 text-sm text-emerald-600 bg-emerald-50">
        <Check className="h-4 w-4" />
        Processed
      </div>
    )
  }

  return (
    <div className="px-4 py-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium truncate">{parsed.name}</span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${badge.className}`}>
              {badge.label}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{parsed.email}</span>
            {parsed.call_date && <span>Call: {parsed.call_date}</span>}
            {parsed.referrer_name && <span>Ref: {parsed.referrer_name}</span>}
            <span>Booked: {formatDate(entry.created_at)}</span>
          </div>
          {parsed.reason && (
            <p className="text-xs text-zinc-500 mt-1 truncate">
              {parsed.reason}
            </p>
          )}
        </div>

        {/* Match indicators */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Circleback match */}
          {circleback_match && (
            <div className="flex items-center gap-1 text-xs bg-violet-50 text-violet-700 px-2 py-1 rounded-md" title={`Circleback: ${circleback_match.meeting_name}`}>
              <Phone className="h-3 w-3" />
              <span className="hidden sm:inline">Call matched</span>
              <span className="sm:hidden">CB</span>
            </div>
          )}

          {/* Existing lead/contact indicator */}
          {matches.existing_lead_id && (
            <a
              href={`/leads/${matches.existing_lead_id}`}
              className="flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-md hover:bg-blue-100"
              title={`Existing lead: ${matches.existing_lead_status}`}
            >
              <ExternalLink className="h-3 w-3" />
              Lead exists
            </a>
          )}
          {matches.existing_contact_id && !matches.existing_lead_id && (
            <span className="text-xs bg-amber-50 text-amber-700 px-2 py-1 rounded-md">
              Contact: {matches.existing_contact_name}
            </span>
          )}
        </div>

        {/* Actions */}
        {!readonly && (
          <div className="flex items-center gap-1.5 shrink-0">
            {!linkMode ? (
              <>
                <button
                  onClick={handleCreateLead}
                  disabled={isPending}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50"
                  title={matches.existing_lead_id ? 'A lead already exists — consider linking instead' : 'Create new lead'}
                >
                  {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}
                  Create
                </button>
                <button
                  onClick={() => {
                    setLinkMode(true)
                    if (matches.existing_lead_id) setLinkLeadId(matches.existing_lead_id)
                  }}
                  disabled={isPending}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border hover:bg-zinc-50 disabled:opacity-50"
                >
                  <Link2 className="h-3 w-3" />
                  Link
                </button>
                <button
                  onClick={() => handleDismiss('lost')}
                  disabled={isPending}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600 disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </>
            ) : (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={linkLeadId}
                  onChange={e => setLinkLeadId(e.target.value)}
                  placeholder="Lead UUID"
                  className="w-40 px-2 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  onClick={handleLink}
                  disabled={isPending || !linkLeadId.trim()}
                  className="px-2 py-1 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Link'}
                </button>
                <button
                  onClick={() => { setLinkMode(false); setLinkLeadId('') }}
                  className="px-1.5 py-1 text-xs rounded border hover:bg-zinc-50"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
