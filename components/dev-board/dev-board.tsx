"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd"
import { cn } from "@/lib/utils"
import {
  GitBranch, ChevronRight, ChevronDown, CheckCircle2, TrendingUp, ArrowRight,
  User, CalendarClock, ExternalLink, RefreshCw, Loader2,
} from "lucide-react"
import {
  ACTIVE_BOARD_LANES,
  DONE_LANE,
  laneForStatus,
  channelsInJobs,
  isSafeInternalUrl,
  type BoardLaneKey,
} from "@/lib/dev-tracker/board"
import { DEFAULT_STAGE_SET, labelForStage, parseMilestones } from "@/lib/dev-tracker/milestones"
import { parseProgressLog, type DevJob } from "./types"

export type { DevJob } from "./types"

const PRIORITY_CHIP: Record<string, string> = {
  critical: "bg-red-100 text-red-700",
  high: "bg-amber-100 text-amber-700",
  medium: "bg-blue-100 text-blue-700",
  low: "bg-zinc-100 text-zinc-600",
}

const SHIPPED_PREVIEW = 12 // finished cards shown before "show all"

/** One labelled technical section inside the expanded card. Renders nothing
 *  when the field is empty so the expanded view stays as short as the record. */
function TechBlock({ label, text }: { label: string; text: string | null }) {
  if (!text) return null
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase text-zinc-400">{label}</div>
      <p className="text-[10px] text-zinc-600 whitespace-pre-wrap break-words max-h-32 overflow-y-auto mt-0.5">
        {text}
      </p>
    </div>
  )
}

function shippedSortKey(j: DevJob): string {
  return j.completed_at || j.updated_at || j.created_at || ""
}

export function DevBoard({ jobs, initialChannel }: { jobs: DevJob[]; initialChannel: string }) {
  const router = useRouter()
  const [channel, setChannel] = useState(initialChannel)
  const [local, setLocal] = useState<DevJob[]>(jobs)
  const [shippedOpen, setShippedOpen] = useState(false)
  const [shippedAll, setShippedAll] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set())
  // Human view (default) = plain-English layer, technical collapsed.
  // Technical view = every card opens its technical layer.
  const [techView, setTechView] = useState(false)

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function refreshPlain(id: string) {
    setRefreshingIds((prev) => new Set(prev).add(id))
    try {
      const res = await fetch(`/api/dev-board/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_plain: true }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || "Refresh failed — please try again.")
      }
      router.refresh()
    } catch (err) {
      alert(err instanceof Error && err.message ? err.message : "Refresh failed.")
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  useEffect(() => setLocal(jobs), [jobs])

  const channels = useMemo(() => channelsInJobs(jobs), [jobs])

  const visible = useMemo(
    () => local.filter((j) => (!channel || j.channel === channel) && laneForStatus(j.status)),
    [local, channel],
  )

  const byLane = useMemo(() => {
    const map: Record<BoardLaneKey, DevJob[]> = {
      todo: [],
      in_progress: [],
      blocked: [],
      backlog: [],
      done: [],
    }
    for (const j of visible) {
      const lane = laneForStatus(j.status)
      if (lane) map[lane].push(j)
    }
    // Finished cards read newest-first (most recently shipped on top).
    map.done.sort((a, b) => shippedSortKey(b).localeCompare(shippedSortKey(a)))
    return map
  }, [visible])

  async function patchStatus(id: string, status: string) {
    setLocal((prev) => prev.map((j) => (j.id === id ? { ...j, status } : j)))
    try {
      const res = await fetch(`/api/dev-board/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || "Update failed — please try again.")
      }
      router.refresh()
    } catch (err) {
      alert(err instanceof Error && err.message ? err.message : "Update failed.")
      router.refresh()
    }
  }

  function handleDragEnd(r: DropResult) {
    if (!r.destination) return
    const toLane = r.destination.droppableId as BoardLaneKey
    const fromLane = r.source.droppableId as BoardLaneKey
    if (toLane === fromLane) return
    patchStatus(r.draggableId, toLane) // lane key IS the target status
  }

  // Local calendar day, NOT toISOString() (UTC) — Antonio is UTC+1/+2 and the
  // overdue red must flip at his midnight, not London's.
  const nowLocal = new Date()
  const todayISO = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, "0")}-${String(nowLocal.getDate()).padStart(2, "0")}`

  function renderCard(j: DevJob, idx: number) {
    const ms = parseMilestones(j.milestones)
    const expanded = techView || expandedIds.has(j.id)
    const refreshing = refreshingIds.has(j.id)
    const isDone = laneForStatus(j.status) === "done"
    const overdue = Boolean(j.due_date && j.due_date < todayISO && !isDone)
    const trail = parseProgressLog(j.progress_log)
    return (
      <Draggable draggableId={j.id} index={idx} key={j.id}>
        {(dp) => (
          <div
            ref={dp.innerRef}
            {...dp.draggableProps}
            onClick={() => router.push(`/dev-board/${j.id}`)}
            className="bg-white rounded-md border border-zinc-200 p-2 mb-2 shadow-sm cursor-pointer hover:border-zinc-300"
          >
            {/* Drag handle = header row ONLY, so selecting/copying text in the
                expanded technical section can't start a drag (and accidentally
                move the card to another lane). */}
            <div {...dp.dragHandleProps} className="flex items-center gap-1 mb-1">
              <span
                className={cn(
                  "text-[9px] font-semibold uppercase px-1 rounded",
                  PRIORITY_CHIP[j.priority] || PRIORITY_CHIP.low,
                )}
              >
                {j.priority}
              </span>
              {j.channel && (
                <span className="text-[9px] text-zinc-500 bg-zinc-100 px-1 rounded">{j.channel}</span>
              )}
              {j.parent_task_id && (
                <GitBranch className="h-3 w-3 text-violet-400" aria-label="child job" />
              )}
              <button
                type="button"
                aria-label="Refresh the plain-English summary"
                title="Refresh summary (re-runs the AI on this card)"
                disabled={refreshing}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!refreshing) refreshPlain(j.id)
                }}
                className="ml-auto p-0.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 disabled:opacity-60"
              >
                {refreshing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
              </button>
              {!techView && (
                <button
                  type="button"
                  aria-label={expanded ? "Hide technical details" : "Show technical details"}
                  aria-expanded={expanded}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleExpanded(j.id)
                  }}
                  className="p-0.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100"
                >
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
                </button>
              )}
            </div>

            {/* ── Plain-English layer (Human view, for Antonio) — hidden in
                Technical view so each view stays crisp. ── */}
            <div className="text-xs font-medium text-zinc-900 line-clamp-2">{j.title}</div>
            {!techView && j.summary_plain && (
              <p className="text-[11px] text-zinc-600 mt-1 line-clamp-3">{j.summary_plain}</p>
            )}
            {!techView && j.business_impact && (
              <div className="flex items-start gap-1 mt-1">
                <TrendingUp className="h-3 w-3 text-amber-500 shrink-0 mt-[1px]" aria-label="business impact" />
                <span className="text-[10px] text-zinc-600 line-clamp-2">{j.business_impact}</span>
              </div>
            )}
            {/* A finished card has no next step by definition — suppressing it
                here also hides any stale "waiting on QA" text on cards that
                were dragged to done without an AI refresh. */}
            {!techView && j.simple_next_step && !isDone && (
              <div className="flex items-start gap-1 mt-0.5">
                <ArrowRight className="h-3 w-3 text-blue-500 shrink-0 mt-[1px]" aria-label="next step" />
                <span className="text-[10px] text-zinc-700 line-clamp-2">{j.simple_next_step}</span>
              </div>
            )}

            <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1.5">
              {ms && (
                <span className="text-[10px] text-zinc-500">{labelForStage(DEFAULT_STAGE_SET, ms.current)}</span>
              )}
              {j.owner && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500">
                  <User className="h-3 w-3" /> {j.owner}
                </span>
              )}
              {j.due_date && (
                <span
                  className={cn(
                    "inline-flex items-center gap-0.5 text-[10px]",
                    overdue ? "text-red-600 font-semibold" : "text-zinc-500",
                  )}
                >
                  <CalendarClock className="h-3 w-3" /> {j.due_date}
                </span>
              )}
              {/* Render-side guard mirrors the write-side one: never emit a
                  non-relative href in a staff session (javascript:/https!//). */}
              {j.origin_url && isSafeInternalUrl(j.origin_url) && (
                <a
                  href={j.origin_url}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-0.5 text-[10px] text-blue-600 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" /> origin
                </a>
              )}
            </div>

            {/* ── Technical layer (expand-on-demand, for the coding session) ── */}
            {expanded && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="mt-2 pt-2 border-t border-zinc-100 space-y-1.5 cursor-default"
              >
                <TechBlock label="Request" text={j.description} />
                <TechBlock label="Findings" text={j.findings} />
                <TechBlock label="Plan" text={j.plan} />
                <TechBlock label="Decisions" text={j.decisions} />
                <TechBlock label="Blockers" text={j.blockers} />
                {trail.length > 0 && (
                  <div>
                    <div className="text-[9px] font-semibold uppercase text-zinc-400">Trail</div>
                    <ul className="mt-0.5 space-y-0.5">
                      {trail.slice(-6).map((e, i) => (
                        <li key={i} className="text-[10px] text-zinc-600">
                          <span className="text-zinc-400">{e.date}</span> {e.action}
                          {e.result ? ` → ${e.result}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {j.related_files && j.related_files.length > 0 && (
                  <div>
                    <div className="text-[9px] font-semibold uppercase text-zinc-400">Code refs</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {j.related_files.map((f) => (
                        <code key={f} className="text-[9px] bg-zinc-100 text-zinc-600 px-1 rounded break-all">
                          {f}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    router.push(`/dev-board/${j.id}`)
                  }}
                  className="text-[10px] text-blue-600 hover:underline"
                >
                  Open full stage board →
                </button>
              </div>
            )}
          </div>
        )}
      </Draggable>
    )
  }

  const shipped = byLane.done
  const shippedShown = shippedAll ? shipped : shipped.slice(0, SHIPPED_PREVIEW)
  const activeCount = visible.length - shipped.length

  return (
    <>
      <div className="flex items-center flex-wrap gap-2 mb-3">
        <span className="text-xs text-zinc-500">Channel:</span>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="text-xs border border-zinc-200 rounded px-2 py-1 bg-white"
        >
          <option value="">All channels</option>
          {channels.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-400">{activeCount} active</span>

        {/* Human view (plain English, default) vs Technical view (all cards
            open their technical layer). Client-side only — no data change. */}
        <div className="ml-auto flex rounded-md border border-zinc-200 overflow-hidden">
          <button
            type="button"
            onClick={() => setTechView(false)}
            className={cn(
              "px-2 py-1 text-xs",
              !techView ? "bg-zinc-800 text-white" : "bg-white text-zinc-600 hover:bg-zinc-50",
            )}
          >
            Human view
          </button>
          <button
            type="button"
            onClick={() => setTechView(true)}
            className={cn(
              "px-2 py-1 text-xs",
              techView ? "bg-zinc-800 text-white" : "bg-white text-zinc-600 hover:bg-zinc-50",
            )}
          >
            Technical view
          </button>
        </div>
      </div>

      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {ACTIVE_BOARD_LANES.map((lane) => (
            <Droppable droppableId={lane.key} key={lane.key}>
              {(provided) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={cn("bg-zinc-50 rounded-lg border-t-2 p-2 min-h-[120px]", lane.accent)}
                >
                  <div className="flex items-center justify-between mb-2 px-1">
                    <span className="text-xs font-semibold text-zinc-700">{lane.label}</span>
                    <span className={cn("text-[10px] px-1.5 rounded", lane.badge)}>
                      {byLane[lane.key].length}
                    </span>
                  </div>
                  {byLane[lane.key].map((j, idx) => renderCard(j, idx))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          ))}
        </div>

        {/* Finished work — folded away by default; still a drag target so
            drag-to-complete keeps working even while collapsed. */}
        <Droppable droppableId="done">
          {(provided) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className={cn("mt-4 bg-zinc-50 rounded-lg border-t-2 p-2", DONE_LANE.accent)}
            >
              <button
                type="button"
                onClick={() => setShippedOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-1 py-1 text-left"
              >
                <ChevronRight
                  className={cn("h-3.5 w-3.5 text-zinc-500 transition-transform", shippedOpen && "rotate-90")}
                />
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                <span className="text-xs font-semibold text-zinc-700">Recently shipped</span>
                <span className={cn("text-[10px] px-1.5 rounded", DONE_LANE.badge)}>{shipped.length}</span>
                {!shippedOpen && (
                  <span className="text-[10px] text-zinc-400">— click to view finished work</span>
                )}
              </button>

              {shippedOpen && (
                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-x-3">
                  {shippedShown.map((j, idx) => renderCard(j, idx))}
                </div>
              )}
              {shippedOpen && shipped.length > SHIPPED_PREVIEW && (
                <button
                  type="button"
                  onClick={() => setShippedAll((v) => !v)}
                  className="mt-1 text-[11px] text-blue-600 hover:underline px-1"
                >
                  {shippedAll ? "Show fewer" : `Show all ${shipped.length}`}
                </button>
              )}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>
    </>
  )
}
