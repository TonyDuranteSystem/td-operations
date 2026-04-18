"use client"

/**
 * P3.7 — Generic destructive-action confirmation dialog.
 *
 * One component, every destructive CRM surface. Pattern derived from
 * the existing StatusChangeDialog (accounts) and DeleteLeadDialog (leads).
 *
 * Usage:
 *   const [open, setOpen] = useState(false)
 *   <ConfirmDestructiveDialog
 *     open={open}
 *     onClose={() => setOpen(false)}
 *     title="Delete Offer"
 *     description={`Delete offer ${offerToken} for ${leadName}?`}
 *     severity="red"
 *     loadPreview={async () => {
 *       const res = await fetch('/api/.../offer-delete-preview', ...)
 *       return await res.json()
 *     }}
 *     requireTypeToConfirm={offerToken}
 *     confirmLabel="Delete Offer"
 *     onConfirm={async () => {
 *       const res = await fetch('/api/.../delete-offer', ...)
 *       const data = await res.json()
 *       return { success: res.ok, error: data.error }
 *     }}
 *   />
 */

import { useEffect, useState, useTransition } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { totalAffected, type DryRunResult } from "@/lib/operations/destructive"

export type ConfirmSeverity = "red" | "amber"

export interface ConfirmDestructiveDialogProps {
  open: boolean
  onClose: () => void

  title: string
  description?: string
  severity?: ConfirmSeverity

  loadPreview?: () => Promise<DryRunResult>
  staticPreview?: DryRunResult

  requireTypeToConfirm?: string
  confirmLabel?: string

  onConfirm: () => Promise<{ success: boolean; error?: string; message?: string }>
  onSuccess?: () => void
}

export function ConfirmDestructiveDialog({
  open,
  onClose,
  title,
  description,
  severity = "red",
  loadPreview,
  staticPreview,
  requireTypeToConfirm,
  confirmLabel,
  onConfirm,
  onSuccess,
}: ConfirmDestructiveDialogProps) {
  const [preview, setPreview] = useState<DryRunResult | null>(staticPreview ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState("")
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) {
      setPreview(staticPreview ?? null)
      setConfirmText("")
      setError(null)
      return
    }
    if (!loadPreview) return

    setLoading(true)
    setError(null)
    loadPreview()
      .then((result) => setPreview(result))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load preview"))
      .finally(() => setLoading(false))
  }, [open, loadPreview, staticPreview])

  if (!open) return null

  const typeMatches =
    !requireTypeToConfirm ||
    confirmText.trim().toLowerCase() === requireTypeToConfirm.trim().toLowerCase()

  const blocked = Boolean(preview?.blocker)
  const canConfirm = typeMatches && !blocked && !loading && !isPending

  const colors =
    severity === "red"
      ? {
          headerText: "text-red-700",
          button: "bg-red-600 hover:bg-red-700",
          banner: "bg-red-50 border-red-200 text-red-800",
          bannerIcon: "text-red-600",
          focusRing: "focus:ring-red-500",
        }
      : {
          headerText: "text-amber-700",
          button: "bg-amber-600 hover:bg-amber-700",
          banner: "bg-amber-50 border-amber-200 text-amber-800",
          bannerIcon: "text-amber-600",
          focusRing: "focus:ring-amber-500",
        }

  const totalCount = preview ? totalAffected(preview) : 0

  const handleConfirm = () => {
    if (!canConfirm) return
    startTransition(async () => {
      try {
        const result = await onConfirm()
        if (!result.success) {
          toast.error(result.error || "Action failed")
          return
        }
        toast.success(result.message || `${title} — done`)
        onSuccess?.()
        onClose()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed")
      }
    })
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
            <h2 className={`text-lg font-semibold flex items-center gap-2 ${colors.headerText}`}>
              <Trash2 className="h-5 w-5" />
              {title}
            </h2>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-zinc-100"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            {description && (
              <p className="text-sm text-zinc-700">{description}</p>
            )}

            {/* Loading */}
            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                <span className="ml-2 text-sm text-zinc-500">
                  Calculating impact...
                </span>
              </div>
            )}

            {/* Preview fetch error */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                Preview unavailable: {error}
              </div>
            )}

            {/* Blocker (commit will be disabled) */}
            {preview?.blocker && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                  <div className="text-sm text-red-800">
                    <p className="font-semibold">Cannot proceed</p>
                    <p className="mt-1">{preview.blocker}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Warnings banner */}
            {preview && preview.warnings && preview.warnings.length > 0 && (
              <div className={`border rounded-lg p-3 ${colors.banner}`}>
                <div className="flex items-start gap-2">
                  <AlertTriangle className={`h-5 w-5 shrink-0 mt-0.5 ${colors.bannerIcon}`} />
                  <div className="text-sm flex-1">
                    <ul className="space-y-0.5 list-disc list-inside">
                      {preview.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* Items list */}
            {preview && preview.items.length > 0 && (
              <div className="border rounded-lg divide-y">
                <div className="px-4 py-2.5 bg-zinc-50 text-xs font-semibold text-zinc-600 uppercase tracking-wide">
                  This will affect {totalCount > 0 ? `${totalCount} item${totalCount !== 1 ? "s" : ""}` : "the following"}
                </div>
                {preview.items.map((item, i) => (
                  <div key={i} className="px-4 py-2.5">
                    <div className="text-sm text-zinc-800">{item.label}</div>
                    {item.details && item.details.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {item.details.map((d, j) => (
                          <span
                            key={j}
                            className="text-xs px-2 py-0.5 rounded bg-zinc-100 text-zinc-600"
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Type-to-confirm gate (only when we're not blocked) */}
            {!blocked && requireTypeToConfirm && (
              <div>
                <label className="block text-sm font-medium mb-1">
                  Type{" "}
                  <span className={`font-semibold ${colors.headerText}`}>
                    {requireTypeToConfirm}
                  </span>{" "}
                  to confirm
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoFocus
                  placeholder={requireTypeToConfirm}
                  className={`w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 ${colors.focusRing}`}
                />
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-6 py-3 border-t shrink-0">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm || isPending}
              className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white rounded-md disabled:opacity-50 ${colors.button}`}
            >
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Applying...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  {confirmLabel || "Confirm"}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
