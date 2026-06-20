"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

interface TaskRow {
  id: string
  title: string
  status: string
  code_branch: string | null
  is_promote: boolean
  created_at: string
  updated_at: string
  stuck?: boolean
}

interface RunnerInfo {
  online: boolean
  seconds_ago: number | null
  last_heartbeat: string | null
}

function agoLabel(sec: number | null): string {
  if (sec == null) return "never"
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  return `${Math.round(sec / 3600)}h ago`
}

function RunnerBadge({ runner }: { runner: RunnerInfo | null }) {
  if (!runner) return null
  const online = runner.online
  return (
    <span
      title={runner.last_heartbeat ? `Last heartbeat: ${new Date(runner.last_heartbeat).toLocaleString()}` : "No heartbeat recorded"}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        online ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-green-500" : "bg-red-500"}`} />
      Mac Mini {online ? "online" : "offline"} · {agoLabel(runner.seconds_ago)}
    </span>
  )
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

export default function CodeTasksIndexPage() {
  const router = useRouter()
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [runner, setRunner] = useState<RunnerInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [newTitle, setNewTitle] = useState("")
  const [newInstr, setNewInstr] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)

  async function createTask() {
    if (submitting) return
    setSubmitting(true)
    setFormErr(null)
    try {
      const res = await fetch("/api/code-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle, instructions: newInstr }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "Failed to create task.")
      if (d.id) router.push(`/code-tasks/${d.id}`)
    } catch (err) {
      setFormErr(err instanceof Error && err.message ? err.message : "Failed to create task.")
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const res = await fetch("/api/code-tasks")
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          if (active) setError(d.error || "Failed to load code tasks.")
          return
        }
        const data = await res.json()
        if (active) {
          setTasks(data.tasks ?? [])
          setRunner(data.runner ?? null)
          setError(null)
        }
      } catch {
        if (active) setError("Network error — retrying…")
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [])

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-start justify-between border-b pb-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Code Tasks</h1>
          <p className="text-xs text-gray-500">
            Claude code sessions started from Slack. Open a live one to watch it and type to steer.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <RunnerBadge runner={runner} />
          <button
            onClick={() => setShowForm((v) => !v)}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
          >
            {showForm ? "Cancel" : "+ New task"}
          </button>
        </div>
      </div>

      {runner && !runner.online && (
        <div className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
          ⚠️ The Mac Mini worker looks offline (last heartbeat {agoLabel(runner.seconds_ago)}). New code tasks won&apos;t run until it&apos;s back.
        </div>
      )}

      {showForm && (
        <div className="mt-3 space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3">
          <input
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
            placeholder="Short title (optional)"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <textarea
            className="min-h-[90px] w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
            placeholder="Describe what to build or fix, with enough detail for Claude to do it (file paths, exact changes, etc.)…"
            value={newInstr}
            onChange={(e) => setNewInstr(e.target.value)}
          />
          {formErr && <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{formErr}</p>}
          <div className="flex justify-end">
            <button
              onClick={createTask}
              disabled={submitting || newInstr.trim().length < 10}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? "Queuing…" : "Queue task"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-700">{error}</div>}

      <div className="mt-3 divide-y rounded-lg border border-gray-200 bg-white">
        {loading && tasks.length === 0 && <p className="p-4 text-sm text-gray-400">Loading…</p>}
        {!loading && tasks.length === 0 && !error && (
          <p className="p-4 text-sm text-gray-400">No code tasks yet. Ask Claude to build something in Slack.</p>
        )}
        {tasks.map((t) => (
          <Link
            key={t.id}
            href={`/code-tasks/${t.id}`}
            className="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-800">
                {t.is_promote ? "🚀 " : ""}
                {t.title}
              </p>
              <p className="text-xs text-gray-500">
                {new Date(t.updated_at).toLocaleString()}
                {t.code_branch ? ` · ${t.code_branch}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {t.stuck && (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700" title="No progress for a while — the worker may be stuck or offline.">
                  ⚠ stuck
                </span>
              )}
              <StatusBadge status={t.status} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
