"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd"
import { cn } from "@/lib/utils"
import { GitBranch } from "lucide-react"
import {
  BOARD_LANES,
  laneForStatus,
  channelsInJobs,
  type BoardLaneKey,
} from "@/lib/dev-tracker/board"
import { DEFAULT_STAGE_SET, labelForStage, parseMilestones } from "@/lib/dev-tracker/milestones"
import type { DevJob } from "./types"

export type { DevJob } from "./types"

const PRIORITY_CHIP: Record<string, string> = {
  critical: "bg-red-100 text-red-700",
  high: "bg-amber-100 text-amber-700",
  medium: "bg-blue-100 text-blue-700",
  low: "bg-zinc-100 text-zinc-600",
}

export function DevBoard({ jobs, initialChannel }: { jobs: DevJob[]; initialChannel: string }) {
  const router = useRouter()
  const [channel, setChannel] = useState(initialChannel)
  const [local, setLocal] = useState<DevJob[]>(jobs)

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

  return (
    <>
      <div className="flex items-center gap-2 mb-3">
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
        <span className="text-xs text-zinc-400">{visible.length} jobs</span>
      </div>

      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          {BOARD_LANES.map((lane) => (
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
                  {byLane[lane.key].map((j, idx) => {
                    const ms = parseMilestones(j.milestones)
                    return (
                      <Draggable draggableId={j.id} index={idx} key={j.id}>
                        {(dp) => (
                          <div
                            ref={dp.innerRef}
                            {...dp.draggableProps}
                            {...dp.dragHandleProps}
                            onClick={() => router.push(`/dev-board/${j.id}`)}
                            className="bg-white rounded-md border border-zinc-200 p-2 mb-2 shadow-sm cursor-pointer hover:border-zinc-300"
                          >
                            <div className="flex items-center gap-1 mb-1">
                              <span
                                className={cn(
                                  "text-[9px] font-semibold uppercase px-1 rounded",
                                  PRIORITY_CHIP[j.priority] || PRIORITY_CHIP.low,
                                )}
                              >
                                {j.priority}
                              </span>
                              {j.channel && (
                                <span className="text-[9px] text-zinc-500 bg-zinc-100 px-1 rounded">
                                  {j.channel}
                                </span>
                              )}
                              {j.parent_task_id && (
                                <GitBranch className="h-3 w-3 text-violet-400" aria-label="child job" />
                              )}
                            </div>
                            <div className="text-xs font-medium text-zinc-900 line-clamp-2">
                              {j.title}
                            </div>
                            {ms && (
                              <div className="text-[10px] text-zinc-500 mt-1">
                                {labelForStage(DEFAULT_STAGE_SET, ms.current)}
                              </div>
                            )}
                          </div>
                        )}
                      </Draggable>
                    )
                  })}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          ))}
        </div>
      </DragDropContext>
    </>
  )
}
