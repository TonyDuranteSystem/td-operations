"use client"

import { useState, useTransition } from "react"
import { X, Loader2, Save, Pencil } from "lucide-react"
import { toast } from "sonner"
import { savePipelineStage } from "./actions"

export interface PipelineStageRow {
  id: string
  service_type: string
  stage_order: number
  stage_name: string
  stage_description: string | null
  client_description: string | null
  sla_days: number | null
  auto_advance: boolean | null
  requires_approval: boolean | null
}

export function PipelineStageEditButton({ row }: { row: PipelineStageRow }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-blue-600 hover:text-blue-800 text-xs inline-flex items-center gap-1"
      >
        <Pencil className="h-3 w-3" /> Edit
      </button>
      {open && <PipelineStageEditDialog row={row} onClose={() => setOpen(false)} />}
    </>
  )
}

function PipelineStageEditDialog({
  row,
  onClose,
}: {
  row: PipelineStageRow
  onClose: () => void
}) {
  const [stageName, setStageName] = useState(row.stage_name)
  const [stageDescription, setStageDescription] = useState(row.stage_description ?? "")
  const [clientDescription, setClientDescription] = useState(row.client_description ?? "")
  const [slaDays, setSlaDays] = useState<string>(row.sla_days?.toString() ?? "")
  const [autoAdvance, setAutoAdvance] = useState(row.auto_advance ?? false)
  const [requiresApproval, setRequiresApproval] = useState(row.requires_approval ?? false)
  const [isPending, startTransition] = useTransition()

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    startTransition(async () => {
      const slaNum = slaDays.trim() ? parseInt(slaDays, 10) : null
      const result = await savePipelineStage(row.id, {
        stage_name: stageName.trim(),
        stage_description: stageDescription.trim() || null,
        client_description: clientDescription.trim() || null,
        sla_days: slaNum,
        auto_advance: autoAdvance,
        requires_approval: requiresApproval,
      })
      if (result.success) {
        toast.success("Pipeline stage saved")
        onClose()
      } else {
        toast.error(result.error ?? "Save failed")
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <form
        onSubmit={handleSave}
        className="relative bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">
            Edit Stage — {row.service_type} #{row.stage_order}
          </h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Stage Name</label>
            <input
              type="text"
              value={stageName}
              onChange={e => setStageName(e.target.value)}
              required
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Internal Description</label>
            <textarea
              value={stageDescription}
              onChange={e => setStageDescription(e.target.value)}
              rows={3}
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 mb-1">Client-facing Description</label>
            <textarea
              value={clientDescription}
              onChange={e => setClientDescription(e.target.value)}
              rows={3}
              placeholder="Shown to the client in their portal."
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">SLA Days</label>
              <input
                type="number"
                min="0"
                value={slaDays}
                onChange={e => setSlaDays(e.target.value)}
                className="w-full border rounded-md px-3 py-2 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-sm mt-5">
              <input
                type="checkbox"
                checked={autoAdvance}
                onChange={e => setAutoAdvance(e.target.checked)}
              />
              Auto advance
            </label>
            <label className="flex items-center gap-2 text-sm mt-5">
              <input
                type="checkbox"
                checked={requiresApproval}
                onChange={e => setRequiresApproval(e.target.checked)}
              />
              Requires approval
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t bg-zinc-50">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border hover:bg-zinc-100">
            Cancel
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300 inline-flex items-center gap-1.5"
          >
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
