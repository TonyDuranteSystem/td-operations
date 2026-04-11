'use client'

import { useState, useTransition } from 'react'
import { Phone, Clock, Users, FileText, ListChecks, Search, Link2, Unlink, Loader2, ExternalLink } from 'lucide-react'
import { findAndLinkCall, linkCallToLead, unlinkCallFromLead, searchCallsByName } from '../actions'
import { toast } from 'sonner'
import { CallNotesEditor } from './call-notes-editor'

interface CallData {
  id: string
  meeting_name: string | null
  duration_seconds: number | null
  attendees: Array<{ name?: string; email?: string }> | null
  notes: string | null
  action_items: unknown[] | null
  recording_url: string | null
  created_at: string
}

interface CallSummaryCardProps {
  leadId: string
  leadEmail: string | null
  initialCall: CallData | null
  callNotes: string | null
}

export function CallSummaryCard({ leadId, leadEmail, initialCall, callNotes }: CallSummaryCardProps) {
  const [call, setCall] = useState<CallData | null>(initialCall)
  const [searching, setSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<CallData[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const [isPending, startTransition] = useTransition()

  const handleFindCall = () => {
    startTransition(async () => {
      const result = await findAndLinkCall(leadId)
      if (result.success && result.call) {
        setCall(result.call as CallData)
        toast.success(result.multiple
          ? 'Found multiple calls — linked the most recent one'
          : 'Call found and linked')
      } else {
        if (result.error?.includes('No matching call')) {
          setShowSearch(true)
          toast.info('No auto-match found — try searching by name')
        } else {
          toast.error(result.error || 'Failed to find call')
        }
      }
    })
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    try {
      const result = await searchCallsByName(searchQuery)
      setSearchResults(result.calls as CallData[])
      if (result.calls.length === 0) {
        toast.info('No calls matching that name')
      }
    } catch {
      toast.error('Search failed')
    } finally {
      setSearching(false)
    }
  }

  const handleLinkCall = (callId: string) => {
    startTransition(async () => {
      const result = await linkCallToLead(leadId, callId)
      if (result.success) {
        const linked = searchResults.find(c => c.id === callId)
        if (linked) setCall(linked)
        setShowSearch(false)
        setSearchResults([])
        toast.success('Call linked')
      } else {
        toast.error(result.error || 'Failed to link call')
      }
    })
  }

  const handleUnlink = () => {
    startTransition(async () => {
      const result = await unlinkCallFromLead(leadId)
      if (result.success) {
        setCall(null)
        toast.success('Call unlinked')
      } else {
        toast.error(result.error || 'Failed to unlink')
      }
    })
  }

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return '--'
    return `${Math.round(seconds / 60)} min`
  }

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      })
    } catch {
      return dateStr
    }
  }

  // ─── Linked call: show summary ────────────────────────────
  if (call) {
    const nonHostAttendees = (call.attendees || []).filter(a =>
      a.email !== 'antonio.durante@tonydurante.us' &&
      !a.name?.includes('Notetaker') &&
      !a.name?.includes('Fireflies')
    )

    const noteText = typeof call.notes === 'string' ? call.notes : ''
    const actionItems = Array.isArray(call.action_items) ? call.action_items : []

    return (
      <div className="bg-white rounded-lg border p-5 md:col-span-2">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
            <Phone className="h-4 w-4" />
            Call Summary
          </h2>
          <button
            onClick={handleUnlink}
            disabled={isPending}
            className="text-xs text-zinc-400 hover:text-red-500 flex items-center gap-1 transition-colors"
            title="Unlink this call"
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
            Unlink
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Meeting</p>
            <p className="text-sm font-medium">{call.meeting_name || 'Untitled Call'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <Clock className="h-3 w-3" /> Date & Duration
            </p>
            <p className="text-sm font-medium">
              {formatDate(call.created_at)} &middot; {formatDuration(call.duration_seconds)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <Users className="h-3 w-3" /> Attendees
            </p>
            <p className="text-sm font-medium">
              {nonHostAttendees.length > 0
                ? nonHostAttendees.map(a => a.name || a.email || '?').join(', ')
                : 'No attendees'}
            </p>
          </div>
        </div>

        {noteText && (
          <div className="mt-4">
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <FileText className="h-3 w-3" /> Notes
            </p>
            <p className="text-sm text-zinc-700 whitespace-pre-wrap line-clamp-6">
              {noteText.slice(0, 500)}{noteText.length > 500 ? '...' : ''}
            </p>
          </div>
        )}

        {actionItems.length > 0 && (
          <div className="mt-4">
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <ListChecks className="h-3 w-3" /> Action Items
            </p>
            <ul className="space-y-1">
              {actionItems.slice(0, 5).map((item, i) => {
                const text = typeof item === 'string'
                  ? item
                  : (item as Record<string, string>)?.text || (item as Record<string, string>)?.description || JSON.stringify(item)
                return (
                  <li key={i} className="text-sm text-zinc-700 flex items-start gap-1.5">
                    <span className="text-zinc-400 mt-0.5">-</span>
                    <span>{text}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {call.recording_url && (
          <a
            href={call.recording_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mt-3"
          >
            View recording <ExternalLink className="h-3 w-3" />
          </a>
        )}

        <p className="text-[10px] text-zinc-400 mt-3">Source: Circleback (read-only)</p>

        {/* Staff Call Notes — editable CRM interpretation */}
        <CallNotesEditor leadId={leadId} callNotes={callNotes} />
      </div>
    )
  }

  // ─── No call linked: Find Call UI ─────────────────────────
  return (
    <div className="bg-white rounded-lg border p-5 md:col-span-2">
      <h2 className="text-sm font-semibold text-zinc-900 mb-3 flex items-center gap-2">
        <Phone className="h-4 w-4" />
        Call Summary
      </h2>

      <div className="text-center py-4">
        <p className="text-sm text-muted-foreground mb-3">No call linked to this lead</p>
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={handleFindCall}
            disabled={isPending || !leadEmail}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Find Call
          </button>
          <button
            onClick={() => setShowSearch(true)}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border hover:bg-zinc-50"
          >
            <Link2 className="h-3.5 w-3.5" />
            Manual Link
          </button>
        </div>
        {!leadEmail && (
          <p className="text-xs text-amber-600 mt-2">No email on this lead — use Manual Link</p>
        )}
      </div>

      {/* Manual search */}
      {showSearch && (
        <div className="mt-4 border-t pt-4">
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Search by meeting name..."
              className="flex-1 px-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleSearch}
              disabled={searching}
              className="px-3 py-1.5 text-sm font-medium rounded-md bg-zinc-100 hover:bg-zinc-200 disabled:opacity-50"
            >
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Search'}
            </button>
          </div>

          {searchResults.length > 0 && (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {searchResults.map(c => {
                const nonHost = (c.attendees || []).filter(a =>
                  a.email !== 'antonio.durante@tonydurante.us' &&
                  !a.name?.includes('Notetaker')
                )
                return (
                  <div key={c.id} className="flex items-center justify-between p-2 rounded-md bg-zinc-50 hover:bg-zinc-100">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{c.meeting_name || 'Untitled'}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(c.created_at)} &middot; {formatDuration(c.duration_seconds)}
                        {nonHost.length > 0 && ` &middot; ${nonHost.map(a => a.name || a.email).join(', ')}`}
                      </p>
                    </div>
                    <button
                      onClick={() => handleLinkCall(c.id)}
                      disabled={isPending}
                      className="shrink-0 ml-2 px-2 py-1 text-xs font-medium rounded bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50"
                    >
                      Link
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Staff Call Notes — available even without a linked call */}
      <CallNotesEditor leadId={leadId} callNotes={callNotes} />
    </div>
  )
}
