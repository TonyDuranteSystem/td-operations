"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { cn } from "@/lib/utils"
import { ArrowLeft, GitBranch } from "lucide-react"
import {
  parseMilestones,
  notesForStage,
  type StageSet,
  type StageDef,
} from "@/lib/dev-tracker/milestones"
import { parseProgressLog, type DevJob } from "./types"

const PRIORITY_CHIP: Record<string, string> = {
  critical: "bg-red-100 text-red-700",
  high: "bg-amber-100 text-amber-700",
  medium: "bg-blue-100 text-blue-700",
  low: "bg-zinc-100 text-zinc-600",
}

export function JobStageBoard({
  job,
  stageSet,
  childrenJobs,
}: {
  job: DevJob
  stageSet: StageSet
  childrenJobs: DevJob[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [kref, setKref] = useState("")

  const ms = parseMilestones(job.milestones)
  const reached = new Map<string, string>()
  if (ms) for (const h of ms.history) reached.set(h.stage, h.at)
  const trail = parseProgressLog(job.progress_log)
  const knownStageKeys = new Set(stageSet.stages.map((s) => s.key))
  const isPostponed = job.status === "backlog"

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch(`/api/dev-board/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || "Update failed — please try again.")
      }
      router.refresh()
    } catch (err) {
      alert(err instanceof Error && err.message ? err.message : "Update failed.")
    } finally {
      setBusy(false)
    }
  }

  function trailForStage(stageKey: string, isCurrent: boolean): typeof trail {
    return trail.filter((e) => {
      if (e.stage) return e.stage === stageKey
      // Legacy/untagged entries: show under the current stage, or under an
      // unknown current that isn't in this set → the first stage as a catch-all.
      const currentInSet = ms ? knownStageKeys.has(ms.current) : false
      if (currentInSet) return isCurrent
      return stageSet.stages[0]?.key === stageKey
    })
  }

  return (
    <div>
      {/* Header */}
      <Link href="/dev-board" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mb-3">
        <ArrowLeft className="h-4 w-4" /> Dev Board
      </Link>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className={cn("text-[10px] font-semibold uppercase px-1.5 rounded", PRIORITY_CHIP[job.priority] || PRIORITY_CHIP.low)}>
          {job.priority}
        </span>
        {job.channel && <span className="text-[11px] text-zinc-500 bg-zinc-100 px-1.5 rounded">{job.channel}</span>}
        <span className="text-[11px] text-zinc-400">{job.type}</span>
        <span className="text-[11px] text-zinc-400">· {stageSet.label} lifecycle</span>
      </div>
      <h1 className="text-lg font-semibold text-zinc-900 mb-3">{job.title}</h1>

      {/* Plain English — for Antonio */}
      <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 max-w-3xl">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 mb-1">In plain English</h4>
        {job.summary_plain ? (
          <p className="text-sm text-amber-900 whitespace-pre-wrap">{job.summary_plain}</p>
        ) : (
          <p className="text-sm text-amber-700/60 italic">No plain-English summary yet.</p>
        )}
      </div>

      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs text-zinc-500">Lane: <span className="font-medium text-zinc-700">{job.status}</span></span>
        <button
          disabled={busy}
          onClick={() => patch({ postponed: !isPostponed })}
          className="text-[11px] px-2 py-0.5 rounded border border-zinc-200 text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
        >
          {isPostponed ? "Reopen" : "Postpone"}
        </button>
      </div>

      {/* Stage board — columns on desktop, stacked on mobile */}
      <div className="flex flex-col md:flex-row gap-3 md:overflow-x-auto pb-2">
        {stageSet.stages.map((stage: StageDef) => {
          const isCurrent = ms?.current === stage.key
          const at = reached.get(stage.key)
          const done = !!at
          const fieldBody = stage.field ? job[stage.field] : null
          const notes = notesForStage(ms, stage.key)
          const stageTrail = trailForStage(stage.key, isCurrent)
          const hasContent = !!fieldBody || notes.length > 0 || stageTrail.length > 0

          return (
            <div
              key={stage.key}
              className={cn(
                "rounded-lg border p-3 md:min-w-[260px] md:w-[260px] md:shrink-0",
                isCurrent ? "border-blue-300 bg-blue-50/40" : done ? "border-emerald-200 bg-white" : "border-zinc-200 bg-zinc-50/60",
              )}
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={cn(
                    "h-2.5 w-2.5 rounded-full shrink-0",
                    isCurrent ? "bg-blue-600" : done ? "bg-emerald-500" : "bg-zinc-300",
                  )}
                />
                <span className={cn("text-xs font-semibold", isCurrent ? "text-blue-900" : done ? "text-zinc-800" : "text-zinc-400")}>
                  {stage.label}
                </span>
                {isCurrent && (
                  <span className="text-[9px] font-semibold uppercase bg-blue-100 text-blue-700 px-1 rounded">current</span>
                )}
                {at && <span className="text-[10px] text-zinc-400 ml-auto">{at.slice(0, 10)}</span>}
              </div>

              {fieldBody && <p className="text-sm text-zinc-800 whitespace-pre-wrap mb-2">{fieldBody}</p>}

              {notes.map((n, i) => (
                <p key={`n${i}`} className="text-sm text-zinc-700 mb-1">• {n}</p>
              ))}

              {stageTrail.length > 0 && (
                <ul className="space-y-1 mb-2">
                  {stageTrail.slice(-20).map((e, i) => (
                    <li key={`t${i}`} className="text-xs text-zinc-700">
                      {e.date && <span className="text-zinc-400">{e.date} · </span>}
                      <span className="font-medium">{e.action}</span>
                      {e.result ? <span className="text-zinc-500"> → {e.result}</span> : null}
                    </li>
                  ))}
                </ul>
              )}

              {!hasContent && (
                <p className="text-xs text-zinc-300 italic mb-2">{done ? "reached" : "not yet"}</p>
              )}

              {!isCurrent && (
                <button
                  disabled={busy}
                  onClick={() => patch({ milestone: stage.key })}
                  className="text-[11px] px-2 py-0.5 rounded border border-zinc-200 text-zinc-600 hover:bg-white disabled:opacity-50"
                >
                  Set current
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Knowledge captured — where this job's lasting knowledge was written
          down. The board points to the doc; it never duplicates it. */}
      <div className="mt-5 max-w-3xl">
        {job.knowledge_status === "captured" && job.knowledge_ref ? (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
            <h4 className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1">
              Knowledge captured
            </h4>
            <p className="text-sm text-emerald-900 whitespace-pre-wrap break-words">→ {job.knowledge_ref}</p>
            <button
              disabled={busy}
              onClick={() => patch({ knowledge_status: "", knowledge_ref: "" })}
              className="mt-1 text-[11px] text-zinc-500 hover:underline disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        ) : job.knowledge_status === "chore" ? (
          <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200 flex items-center gap-2">
            <p className="text-sm text-zinc-500">Marked a chore — nothing to document.</p>
            <button
              disabled={busy}
              onClick={() => patch({ knowledge_status: "" })}
              className="text-[11px] text-zinc-500 hover:underline disabled:opacity-50"
            >
              Undo
            </button>
          </div>
        ) : (
          <div
            className={cn(
              "p-3 rounded-lg border",
              job.status === "done" ? "bg-amber-50 border-amber-300" : "bg-zinc-50 border-zinc-200",
            )}
          >
            <h4 className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600 mb-1">
              Where did the knowledge go?
            </h4>
            <p className="text-xs text-zinc-500 mb-2">
              Point to the living doc / KB article / sysdoc that now holds what this job taught — so
              closing it never loses the knowledge.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={kref}
                onChange={(e) => setKref(e.target.value)}
                placeholder="e.g. docs/systems/dev-tracker.md"
                className="text-xs border border-zinc-300 rounded px-2 py-1 bg-white flex-1 min-w-[200px]"
              />
              <button
                disabled={busy || !kref.trim()}
                onClick={() => patch({ knowledge_ref: kref.trim(), knowledge_status: "captured" })}
                className="text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                Save pointer
              </button>
              <button
                disabled={busy}
                onClick={() => patch({ knowledge_status: "chore" })}
                className="text-[11px] px-2 py-1 rounded border border-zinc-300 text-zinc-600 hover:bg-white disabled:opacity-50"
              >
                Nothing to document
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Cross-cutting — not tied to one stage */}
      <div className="mt-5 max-w-3xl space-y-4">
        {job.decisions && (
          <div>
            <h4 className="text-xs font-semibold uppercase text-zinc-500 mb-1">Decisions &amp; changes</h4>
            <p className="text-sm text-zinc-800 whitespace-pre-wrap">{job.decisions}</p>
          </div>
        )}
        {job.blockers && (
          <div>
            <h4 className="text-xs font-semibold uppercase text-zinc-500 mb-1">Blockers</h4>
            <p className="text-sm text-zinc-800 whitespace-pre-wrap">{job.blockers}</p>
          </div>
        )}
        {childrenJobs.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase text-zinc-500 mb-1">
              Spun-off jobs ({childrenJobs.length})
            </h4>
            <ul className="space-y-1">
              {childrenJobs.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/dev-board/${c.id}`}
                    className="text-xs text-zinc-700 hover:underline inline-flex items-center gap-1"
                  >
                    <GitBranch className="h-3 w-3 text-violet-400" />
                    <span className="font-medium">{c.title}</span>
                    <span className="text-zinc-400">[{c.status}]</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
