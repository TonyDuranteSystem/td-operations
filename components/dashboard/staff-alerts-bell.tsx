'use client'

/**
 * Staff Alerts — the bell next to "Enable Notifications". Unlike the sonner toasts in
 * realtime-notifications.tsx (auto-dismiss after 6-8s and never cover sticky notes at
 * all), this is a PERSISTENT list: a note reply/share/edit stays here until dismissed,
 * with a reply box and a Mark done button right on the row.
 *
 * Two renderings sharing one data source, same convention as DashboardPushToggle
 * (compact = mobile top bar, full = desktop header): compact opens a bottom sheet
 * (matches sticky-notes-layer.tsx's own mobile pattern — a header-anchored popover has
 * nowhere good to put a reply textarea at 380px); full opens a dropdown panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { MessageSquare, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { requestOpenNote } from '@/lib/notes/open-note'
import { requestOpenTeamChat } from '@/lib/team/open-team-chat'

interface NoteStaffAlert {
  kind: 'note_reply' | 'note_update'
  note_id: string
  reply_id: string | null
  author_name: string | null
  title: string
  body: string
  url: string
  tag: string
  client_name: string | null
  created_at: string
}

/** A DM / @mention / channel-post alert — Open + Dismiss only, no reply/mark-done
 *  (those stay note-only; a chat alert clears by reading the thread, see the PATCH
 *  handler on /api/crm/staff-alerts). */
interface ChatStaffAlert {
  kind: 'chat_mention' | 'chat_dm' | 'chat_channel'
  thread_id: string
  title: string
  body: string
  url: string
  tag: string
  created_at: string
}

type StaffAlert = NoteStaffAlert | ChatStaffAlert

function isNoteAlert(a: StaffAlert): a is NoteStaffAlert {
  return a.kind === 'note_reply' || a.kind === 'note_update'
}

function alertKey(a: StaffAlert): string {
  return isNoteAlert(a) ? `${a.kind}:${a.note_id}:${a.reply_id ?? ''}` : `${a.kind}:${a.thread_id}`
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

// R099: surface a failed dismiss instead of swallowing it — e.g. the note was hard-deleted
// between this tab's last fetch and the click, so the dismiss-row insert hits a foreign-key
// violation server-side. The optimistic removal already happened; invalidateQueries (in
// dismissMany's finally) will bring the alert back on the next fetch if the write really
// failed, so silence here would read as "I dismissed it and it came back" with no explanation.
async function dismissOnServer(a: StaffAlert) {
  try {
    const payload = isNoteAlert(a)
      ? { kind: a.kind, note_id: a.note_id, reply_id: a.reply_id }
      : { kind: a.kind, thread_id: a.thread_id }
    const res = await fetch('/api/crm/staff-alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || 'Could not update that alert — it may reappear.')
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not update that alert — it may reappear.')
  }
}

export function StaffAlertsBell({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const router = useRouter()
  const knownAlertsRef = useRef<Map<string, StaffAlert>>(new Map())
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set())

  // Polled, not just event-driven: opening a chat alert marks its thread read
  // through the SAME floating-chat / full-page mechanisms Team Chat's own UI
  // uses, neither of which knows this query exists to invalidate it (found
  // live, 2026-09-04 — the bell kept showing an alert for a thread already
  // read). The explicit invalidate in openAlert below covers the common case
  // immediately; this interval is the guarantee for whatever it misses,
  // matching the same-purpose interval sticky-notes-layer.tsx and
  // floating-chat.tsx already poll on.
  const { data } = useQuery<{ alerts: StaffAlert[] }>({
    queryKey: ['staff-alerts'],
    queryFn: async () => {
      const res = await fetch('/api/crm/staff-alerts')
      if (!res.ok) throw new Error('Could not load alerts')
      return res.json()
    },
    refetchInterval: 60_000,
  })

  const serverAlerts = useMemo(() => data?.alerts ?? [], [data])
  for (const a of serverAlerts) knownAlertsRef.current.set(alertKey(a), a)

  // A row with unsaved reply text stays on screen even if the server's list drops it
  // (dismissed from another tab, or the underlying event changed) — the note editor was
  // hit by exactly this class of bug once already (a backdrop-close mid-reply losing
  // typed text), so the same protection applies here.
  const alerts = useMemo(() => {
    const serverKeys = new Set(serverAlerts.map(alertKey))
    const pinned = Array.from(dirtyKeys)
      .filter((k) => !serverKeys.has(k))
      .map((k) => knownAlertsRef.current.get(k))
      .filter((a): a is StaffAlert => !!a)
    return [...serverAlerts, ...pinned]
  }, [serverAlerts, dirtyKeys])

  const setDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((prev) => {
      if (dirty === prev.has(key)) return prev
      const next = new Set(prev)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const dismissMany = useCallback(async (toDismiss: StaffAlert[]) => {
    if (toDismiss.length === 0) return
    const keys = new Set(toDismiss.map(alertKey))
    qc.setQueryData<{ alerts: StaffAlert[] }>(['staff-alerts'], (old) =>
      old ? { alerts: old.alerts.filter((x) => !keys.has(alertKey(x))) } : old,
    )
    try {
      await Promise.all(toDismiss.map(dismissOnServer))
    } finally {
      qc.invalidateQueries({ queryKey: ['staff-alerts'] })
    }
  }, [qc])

  const dismissOne = useCallback((a: StaffAlert) => dismissMany([a]), [dismissMany])
  const dismissNote = useCallback(
    (noteId: string) => dismissMany(alerts.filter((a): a is NoteStaffAlert => isNoteAlert(a) && a.note_id === noteId)),
    [dismissMany, alerts],
  )

  // The dirty-keys pin (above) only protects a row that stays MOUNTED while the server
  // stops listing it. Closing the panel itself unmounts every row unconditionally — found
  // by an adversarial review of the shipped code: a stray tap on the backdrop (very easy at
  // 380px, where the sheet covers most of the screen) silently wiped an in-progress reply
  // with no confirmation, the exact class of bug this file's own comment claimed to prevent.
  // Every close path (backdrop, the mobile X, re-tapping the bell, navigating via Open) now
  // goes through this one guard instead of a bare setOpen(false).
  const confirmDiscardIfDirty = useCallback(() => {
    return dirtyKeys.size === 0 || confirm('You have an unsent reply here — close and lose it?')
  }, [dirtyKeys])

  const requestClose = useCallback(() => {
    if (confirmDiscardIfDirty()) setOpen(false)
  }, [confirmDiscardIfDirty])

  // Open IN PLACE whenever the target surface can show it — never lose the page
  // you were working on for a click that's just "look at this" (Antonio,
  // 2026-09-04). Both request* helpers return false when their layer isn't
  // mounted or can't find the thing (e.g. a snoozed/archived-for-me note, or a
  // thread the floating chat bails on because you're already on /team-chat);
  // only then do we fall back to navigating to the full page.
  const openAlert = useCallback((a: StaffAlert) => {
    if (!confirmDiscardIfDirty()) return
    setOpen(false)
    const handled = isNoteAlert(a)
      ? requestOpenNote({ noteId: a.note_id })
      : requestOpenTeamChat({ threadId: a.thread_id })
    if (!isNoteAlert(a)) {
      // Opening a chat alert marks its thread read somewhere downstream
      // (the floating chat's own markRead, or the full team-chat page's
      // default GET) — neither knows THIS query exists to invalidate it, so
      // the badge/row would otherwise sit stale until the 60s poll. Best-
      // effort immediate refresh, timed after the mark-read write has had a
      // moment to land; the poll (above) is the actual guarantee.
      setTimeout(() => qc.invalidateQueries({ queryKey: ['staff-alerts'] }), 800)
    }
    if (handled) return
    // Verified live (2026-09-04): a soft client-side push to the SAME page you're
    // already on (e.g. clicking a chat alert while sitting on /team-chat itself)
    // does not reliably re-run that page's own ?thread=/?note= deep-link effect —
    // the URL updates but the view doesn't follow, which reads as a dead click.
    // A full navigation always remounts and picks the deep link up correctly.
    const targetPath = a.url.split('?')[0]
    if (typeof window !== 'undefined' && window.location.pathname === targetPath) {
      window.location.href = a.url
      return
    }
    router.push(a.url)
  }, [router, confirmDiscardIfDirty, qc])

  const count = alerts.length

  if (compact) {
    return (
      <>
        <FastTooltip label="Staff Alerts">
          <button
            onClick={() => setOpen(true)}
            className="relative p-2 rounded-md hover:bg-zinc-100 text-zinc-500"
            aria-label={`Staff Alerts${count ? `, ${count} unread` : ''}`}
          >
            <MessageSquare className="h-5 w-5" />
            {count > 0 && (
              <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                {count > 9 ? '9+' : count}
              </span>
            )}
          </button>
        </FastTooltip>
        {open && (
          <div className="lg:hidden fixed inset-0 z-[46] flex flex-col justify-end bg-black/30" onClick={requestClose}>
            <div className="max-h-[75vh] overflow-y-auto rounded-t-xl bg-zinc-50 p-3" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-1 pb-2">
                <span className="text-sm font-semibold text-zinc-700">Staff Alerts</span>
                <button onClick={requestClose} className="p-1 text-zinc-400" aria-label="Close">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <AlertsList alerts={alerts} onOpen={openAlert} onDismiss={dismissOne} onDismissNote={dismissNote} onDirtyChange={setDirty} />
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="relative">
      <FastTooltip label="Staff Alerts">
        <button
          onClick={() => (open ? requestClose() : setOpen(true))}
          className={`relative flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors border ${
            count > 0
              ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
              : 'bg-zinc-100 text-zinc-600 border-zinc-200 hover:bg-zinc-200'
          }`}
          aria-label={`Staff Alerts${count ? `, ${count} unread` : ''}`}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          {count > 0 ? `${count} new` : 'Alerts'}
        </button>
      </FastTooltip>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={requestClose} />
          <div className="absolute right-0 top-full mt-2 z-50 w-96 max-h-[70vh] overflow-y-auto rounded-lg border bg-white shadow-lg">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-semibold text-zinc-700">Staff Alerts</span>
            </div>
            <AlertsList alerts={alerts} onOpen={openAlert} onDismiss={dismissOne} onDismissNote={dismissNote} onDirtyChange={setDirty} />
          </div>
        </>
      )}
    </div>
  )
}

function AlertsList({ alerts, onOpen, onDismiss, onDismissNote, onDirtyChange }: {
  alerts: StaffAlert[]
  onOpen: (a: StaffAlert) => void
  onDismiss: (a: StaffAlert) => void
  onDismissNote: (noteId: string) => void
  onDirtyChange: (key: string, dirty: boolean) => void
}) {
  if (alerts.length === 0) {
    return <p className="p-6 text-center text-sm text-zinc-400">All caught up.</p>
  }
  return (
    <div className="divide-y">
      {alerts.map((a) => (
        <AlertRow key={alertKey(a)} alert={a} onOpen={onOpen} onDismiss={onDismiss} onDismissNote={onDismissNote} onDirtyChange={onDirtyChange} />
      ))}
    </div>
  )
}

function AlertRow({ alert, onOpen, onDismiss, onDismissNote, onDirtyChange }: {
  alert: StaffAlert
  onOpen: (a: StaffAlert) => void
  onDismiss: (a: StaffAlert) => void
  onDismissNote: (noteId: string) => void
  onDirtyChange: (key: string, dirty: boolean) => void
}) {
  const [replying, setReplying] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = alertKey(alert)

  useEffect(() => {
    onDirtyChange(key, replying && replyText.trim().length > 0)
    return () => onDirtyChange(key, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, replying, replyText])

  const submitReply = useCallback(async () => {
    if (!isNoteAlert(alert) || !replyText.trim()) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch('/api/crm/staff-notes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alert.note_id, action: 'reply', body: replyText }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not send the reply.')
      setReplyText('')
      setReplying(false)
      onDismiss(alert)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reply.')
    } finally {
      setSending(false)
    }
  }, [alert, replyText, onDismiss])

  const markDone = useCallback(async () => {
    if (!isNoteAlert(alert)) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch('/api/crm/staff-notes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alert.note_id, action: 'archive' }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not mark it done.')
      }
      onDismissNote(alert.note_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark it done.')
    } finally {
      setSending(false)
    }
  }, [alert, onDismissNote])

  return (
    <div className="p-3">
      <div className="flex items-start gap-2">
        <button className="flex-1 min-w-0 text-left" onClick={() => onOpen(alert)}>
          <p className="text-sm font-medium text-zinc-800">{alert.title}</p>
          <p className="text-sm text-zinc-500 line-clamp-2">{alert.body}</p>
          <p className="mt-0.5 text-xs text-zinc-400 truncate">
            {isNoteAlert(alert) && alert.client_name ? `${alert.client_name} · ` : ''}
            {timeAgo(alert.created_at)}
          </p>
        </button>
        <button
          onClick={() => onDismiss(alert)}
          className="shrink-0 p-1 rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {!isNoteAlert(alert) ? null : !replying ? (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => setReplying(true)}
            className="text-xs px-2 py-1 rounded border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
          >
            Reply
          </button>
          <button
            onClick={markDone}
            disabled={sending}
            className="text-xs px-2 py-1 rounded border border-zinc-200 text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 flex items-center gap-1"
          >
            {sending && <Loader2 className="h-3 w-3 animate-spin" />}
            Mark done
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-1">
          <textarea
            autoFocus
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Write a reply..."
            className="w-full rounded border border-zinc-200 p-2 text-sm resize-none"
            rows={2}
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={submitReply}
              disabled={sending || !replyText.trim()}
              className="text-xs px-2 py-1 rounded bg-zinc-800 text-white disabled:opacity-50 flex items-center gap-1"
            >
              {sending && <Loader2 className="h-3 w-3 animate-spin" />}
              Send
            </button>
            <button
              onClick={() => {
                if (!replyText.trim() || confirm('Discard your reply?')) {
                  setReplying(false)
                  setReplyText('')
                }
              }}
              className="text-xs px-2 py-1 rounded border border-zinc-200 text-zinc-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
