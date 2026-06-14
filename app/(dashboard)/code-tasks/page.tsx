"use client"

import { useEffect, useState } from "react"
import Link from "next/link"

interface TaskRow {
  id: string
  title: string
  status: string
  code_branch: string | null
  is_promote: boolean
  created_at: string
  updated_at: string
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
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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
      <div className="border-b pb-3">
        <h1 className="text-lg font-semibold text-gray-900">Code Tasks</h1>
        <p className="text-xs text-gray-500">
          Claude code sessions started from Slack. Open a live one to watch it and type to steer.
        </p>
      </div>

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
            <StatusBadge status={t.status} />
          </Link>
        ))}
      </div>
    </div>
  )
}
