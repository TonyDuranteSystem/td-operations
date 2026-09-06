'use client'

/**
 * "Share to..." step 6: send the just-uploaded capture into a specific Team
 * Chat conversation, as a real attachment. Reuses GET /api/team/threads
 * (the existing thread list, already carrying a precomputed display label)
 * rather than building a new listing endpoint.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquare, Search } from 'lucide-react'
import { sendCaptureToTeamChat } from '@/lib/captures/share-actions'
import { addRecentDestination } from '@/lib/captures/recent-destinations'
import { teamThreadDisplayLabel, type TeamThreadLabelInput } from '@/lib/captures/team-thread-label'

type TeamThread = TeamThreadLabelInput

export function TeamChatDestinationPicker({
  captureId,
  resend,
  onSent,
  onError,
}: {
  captureId: string
  /** True for a deliberate re-share of a capture already sent once — see share-actions.ts. */
  resend?: boolean
  onSent: () => void
  onError: (message: string) => void
}) {
  const [threads, setThreads] = useState<TeamThread[] | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/team/threads')
      .then((r) => {
        if (!r.ok) throw new Error('load failed')
        return r.json()
      })
      .then((d) => {
        if (!cancelled) setThreads(Array.isArray(d.threads) ? d.threads : [])
      })
      .catch(() => {
        // A failed load used to look identical to "no conversations exist"
        // (R099 violation, bug-hunter finding 2026-09-04) — surfaced through
        // the same onError this component already uses for send failures,
        // rather than a second, new error mechanism.
        if (!cancelled) onError('Could not load team chat conversations. Please try again.')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    if (!threads) return []
    const q = query.trim().toLowerCase()
    if (!q) return threads
    return threads.filter((t) => teamThreadDisplayLabel(t).toLowerCase().includes(q))
  }, [threads, query])

  const sendTo = async (threadId: string, label: string) => {
    setBusy(true)
    try {
      await sendCaptureToTeamChat(captureId, threadId, resend)
      addRecentDestination({ type: 'team_chat', id: threadId, label })
      onSent()
    } catch (err) {
      setBusy(false)
      onError(err instanceof Error ? err.message : 'Could not send to team chat. Please try again.')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
        <MessageSquare className="h-4 w-4" />
        Send to a team chat conversation
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations..."
          className="w-full rounded-md border border-zinc-200 py-2 pl-8 pr-3 text-sm"
        />
      </div>

      {threads === null ? (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading conversations...
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-2 text-center text-xs text-zinc-400">No matching conversations.</p>
      ) : (
        <div className="flex max-h-52 flex-col gap-1 overflow-y-auto">
          {filtered.map((t) => (
            <button
              key={t.id}
              onClick={() => void sendTo(t.id, teamThreadDisplayLabel(t))}
              disabled={busy}
              className="truncate rounded-md border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 disabled:opacity-40"
            >
              {teamThreadDisplayLabel(t)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
