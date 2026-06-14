"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useParams } from "next/navigation"

// Mirror of END_SENTINEL in scripts/mac-mini/code-task-stream.mjs — the runner ends
// the interactive session (EOF → push branch) when it receives this as an input turn.
const END_SENTINEL = "__END_SESSION__"

interface TaskHeader {
  id: string
  title: string
  status: string
  session_id: string | null
  code_branch: string | null
  reply: string | null
  error_text: string | null
}
interface EventRow {
  seq: number
  event_type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any
  created_at: string
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    processing: "bg-blue-100 text-blue-700",
    done: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
    pending: "bg-gray-100 text-gray-600",
  }
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${map[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status === "processing" ? "● live" : status}
    </span>
  )
}

// Render one persisted event into transcript lines (or null to skip).
function renderEvent(ev: EventRow) {
  if (ev.event_type === "assistant") {
    const blocks = Array.isArray(ev.payload?.content) ? ev.payload.content : []
    return blocks.map((b: { type?: string; text?: string; name?: string }, i: number) => {
      if (b.type === "text" && b.text) {
        return (
          <div key={`${ev.seq}-${i}`} className="whitespace-pre-wrap rounded-lg bg-white px-3 py-2 text-sm text-gray-800 shadow-sm">
            {b.text}
          </div>
        )
      }
      if (b.type === "tool_use") {
        return (
          <div key={`${ev.seq}-${i}`} className="text-xs font-mono text-indigo-600">
            🔧 {b.name}
          </div>
        )
      }
      return null
    })
  }
  if (ev.event_type === "tool_result") {
    return (
      <div key={ev.seq} className="pl-3 text-xs text-gray-400">
        ↳ tool result
      </div>
    )
  }
  // result / system events are turn/lifecycle markers — not shown as content.
  return null
}

export default function CodeTaskViewerPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id as string

  const [task, setTask] = useState<TaskHeader | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const lastSeqRef = useRef(-1)
  const scrollRef = useRef<HTMLDivElement>(null)

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/code-tasks/${id}?since=${lastSeqRef.current}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setLoadError(d.error || "Failed to load session.")
        return
      }
      const data = await res.json()
      setLoadError(null)
      setTask(data.task)
      if (Array.isArray(data.events) && data.events.length) {
        // Dedup by seq — concurrent polls (incl. React StrictMode's double mount)
        // can both fetch from the same `since`; appending blindly would duplicate.
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.seq))
          const fresh = data.events.filter((e: EventRow) => !seen.has(e.seq))
          return fresh.length ? [...prev, ...fresh] : prev
        })
        const maxSeq = data.events[data.events.length - 1].seq
        if (maxSeq > lastSeqRef.current) lastSeqRef.current = maxSeq
      }
    } catch {
      setLoadError("Network error — retrying…")
    }
  }, [id])

  useEffect(() => {
    if (!id) return
    poll()
    const t = setInterval(poll, 2000)
    return () => clearInterval(t)
  }, [id, poll])

  // Auto-scroll to the newest content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [events])

  const live = task?.status === "processing"

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return
      setSending(true)
      setError(null)
      try {
        const res = await fetch(`/api/code-tasks/${id}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || "Failed to send.")
        }
        setInput("")
        poll()
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : "Failed to send.")
      } finally {
        setSending(false)
      }
    },
    [id, poll],
  )

  return (
    <div className="mx-auto flex h-[calc(100vh-120px)] max-w-3xl flex-col">
      <div className="flex items-center justify-between border-b pb-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{task?.title ?? "Code task"}</h1>
          <p className="text-xs text-gray-500">Live session viewer{task?.session_id ? ` · ${task.session_id.slice(0, 8)}` : ""}</p>
        </div>
        {task && <StatusBadge status={task.status} />}
      </div>

      {loadError && <div className="mt-2 rounded bg-amber-50 px-3 py-1 text-xs text-amber-700">{loadError}</div>}

      <div ref={scrollRef} className="mt-3 flex-1 space-y-2 overflow-y-auto rounded-lg bg-gray-50 p-4">
        {events.length === 0 && !loadError && <p className="text-sm text-gray-400">Waiting for the session to start…</p>}
        {events.map(renderEvent)}
        {task && task.status !== "processing" && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3 text-sm">
            <p className="font-medium text-gray-700">
              Session {task.status === "done" ? "finished" : "ended"}.
            </p>
            {task.code_branch && (
              <p className="mt-1 text-xs text-gray-600">
                Review branch: <span className="font-mono">{task.code_branch}</span> — reply “ship it” in Slack to deploy.
              </p>
            )}
            {task.error_text && <p className="mt-1 whitespace-pre-wrap text-xs text-red-600">{task.error_text}</p>}
          </div>
        )}
      </div>

      {error && <div className="mt-2 rounded bg-red-50 px-3 py-1 text-xs text-red-700">{error}</div>}

      <div className="mt-3 flex items-end gap-2">
        <textarea
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none disabled:bg-gray-100"
          placeholder={live ? "Type to steer the session…" : "Session is not live"}
          value={input}
          disabled={!live || sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              send(input)
            }
          }}
        />
        <button
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          disabled={!live || sending || !input.trim()}
          onClick={() => send(input)}
        >
          Send
        </button>
        <button
          className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          disabled={!live || sending}
          onClick={() => {
            if (confirm("End this session? It will wrap up and push its review branch.")) send(END_SENTINEL)
          }}
        >
          End session
        </button>
      </div>
    </div>
  )
}
