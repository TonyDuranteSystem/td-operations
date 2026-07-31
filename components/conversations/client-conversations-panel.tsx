"use client"

import { useEffect, useState, useCallback } from "react"
import { ChevronRight, ChevronDown, MessageSquare, Loader2 } from "lucide-react"
import { toast } from "sonner"

interface ThreadRow {
  id: string
  topic_slug: string | null
  source: string
  status: string
  source_kind: string
  created_at: string
  slackLink: string | null
}

interface ThreadMessage {
  author: string
  text: string
  ts: string
}

/** Format an ISO timestamp as a readable date + time. */
function fmtDateTime(iso: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  return isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/** Format a Slack message ts ("epoch.micro") as a readable date + time. */
function fmtSlackTs(ts: string): string {
  if (!ts) return ""
  const sec = parseFloat(ts)
  if (!isFinite(sec)) return ""
  const d = new Date(Math.floor(sec) * 1000)
  return isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/**
 * Collapsible Conversations list for a single CRM entity (no rollup): shows the
 * client_threads tagged to this contact / account / lead. Each row = topic · opened
 * date/time · Slack link; expanding a row pulls the thread's messages (each with its
 * own date/time) LIVE from Slack.
 */
export function ClientConversationsPanel({
  entityType,
  entityId,
}: {
  entityType: "account" | "contact" | "lead"
  entityId: string
}) {
  const [threads, setThreads] = useState<ThreadRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, ThreadMessage[] | "loading" | "error">>({})

  useEffect(() => {
    const param = `${entityType}_id=${encodeURIComponent(entityId)}`
    fetch(`/api/client-threads?${param}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || "Failed to load conversations")
        return d
      })
      .then((d) => setThreads(d.threads ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load conversations"))
  }, [entityType, entityId])

  const toggle = useCallback(
    async (id: string) => {
      if (openId === id) {
        setOpenId(null)
        return
      }
      setOpenId(id)
      if (!messages[id]) {
        setMessages((m) => ({ ...m, [id]: "loading" }))
        try {
          const r = await fetch(`/api/client-threads/${id}/messages`)
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.error || "Failed")
          setMessages((m) => ({ ...m, [id]: (d.messages ?? []) as ThreadMessage[] }))
        } catch {
          setMessages((m) => ({ ...m, [id]: "error" }))
        }
      }
    },
    [openId, messages],
  )

  const setStatus = useCallback((id: string, status: string) => {
    setThreads((ts) => (ts ? ts.map((t) => (t.id === id ? { ...t, status } : t)) : ts))
  }, [])

  const closeThread = useCallback(
    async (id: string, reopen: boolean) => {
      try {
        const r = await fetch(`/api/client-threads/${id}/close${reopen ? "?reopen=1" : ""}`, {
          method: "POST",
        })
        // R099 — SHOW the server's reason. A silent return left the row looking
        // untouched, so the staff member clicks again and assumes the button is
        // broken; the same class of bug as the 2026-06-23 close-button incident.
        if (!r.ok) {
          const d = await r.json().catch(() => ({}))
          throw new Error(d.error || "Could not update this conversation — please try again.")
        }
        setStatus(id, reopen ? "open" : "closed")
        // Drop cached messages so the next expand reflects frozen (close) or live (reopen).
        setMessages((m) => {
          const c = { ...m }
          delete c[id]
          return c
        })
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : "Could not update this conversation — please try again.")
      }
    },
    [setStatus],
  )

  if (error) return <div className="text-sm text-red-600 p-4">{error}</div>
  if (threads === null)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading conversations…
      </div>
    )
  if (threads.length === 0)
    return (
      <div className="text-sm text-muted-foreground p-6 text-center">
        <MessageSquare className="h-6 w-6 mx-auto mb-2 opacity-40" />
        No conversations tagged to this {entityType} yet.
      </div>
    )

  return (
    <div className="divide-y rounded-lg border bg-white">
      {threads.map((t) => {
        const open = openId === t.id
        const msgs = messages[t.id]
        return (
          <div key={t.id}>
            <button
              onClick={() => toggle(t.id)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50"
            >
              {open ? (
                <ChevronDown className="h-4 w-4 text-zinc-400 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-zinc-400 shrink-0" />
              )}
              <span className="px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700 text-xs font-medium shrink-0">
                {t.topic_slug ?? "untagged"}
              </span>
              <span className="text-zinc-500 text-sm shrink-0">Opened {fmtDateTime(t.created_at)}</span>
              {t.status === "closed" && (
                <span className="px-2 py-0.5 rounded-full bg-zinc-200 text-zinc-600 text-[10px] font-medium shrink-0">
                  Closed
                </span>
              )}
              <span className="flex-1" />
              {t.status === "closed" ? (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeThread(t.id, true)
                  }}
                  className="text-zinc-500 hover:text-zinc-800 text-xs shrink-0 cursor-pointer"
                >
                  Reopen
                </span>
              ) : (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeThread(t.id, false)
                  }}
                  className="text-zinc-500 hover:text-red-600 text-xs shrink-0 cursor-pointer"
                >
                  Close
                </span>
              )}
            </button>
            {open && (
              <div className="px-5 pb-4 bg-zinc-50/50">
                {msgs === "loading" && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading thread…
                  </div>
                )}
                {msgs === "error" && (
                  <div className="text-sm text-red-600 py-3">Couldn&apos;t load this thread.</div>
                )}
                {Array.isArray(msgs) && msgs.length === 0 && (
                  <div className="text-sm text-muted-foreground py-3">
                    No stored copy of this conversation.
                  </div>
                )}
                {Array.isArray(msgs) && msgs.length > 0 && (
                  <div className="space-y-2.5 py-2">
                    {msgs.map((m, i) => (
                      <div key={i} className="text-sm">
                        <div className="flex items-baseline gap-2">
                          <span className="font-medium text-zinc-800">{m.author}</span>
                          {fmtSlackTs(m.ts) && (
                            <span className="text-[11px] text-zinc-400">{fmtSlackTs(m.ts)}</span>
                          )}
                        </div>
                        <div className="text-zinc-700 whitespace-pre-wrap">{m.text}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
