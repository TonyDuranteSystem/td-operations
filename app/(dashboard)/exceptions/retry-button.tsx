"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog"
import type { DryRunResult } from "@/lib/operations/destructive"

interface ConfirmConfig {
  title: string
  description?: string
  severity?: "red" | "amber"
  preview?: DryRunResult
  confirmLabel?: string
}

export function RetryButton({
  action,
  label,
  successToast,
  variant = "primary",
  className,
  confirm,
}: {
  action: () => Promise<{ success: boolean; error?: string }>
  label: string
  successToast: string
  variant?: "primary" | "secondary" | "danger"
  className?: string
  /**
   * P3.7: when supplied, the button first opens a confirmation dialog with
   * the provided preview before invoking `action`.
   */
  confirm?: ConfirmConfig
}) {
  const [isPending, startTransition] = useTransition()
  const [confirmOpen, setConfirmOpen] = useState(false)

  const styles = {
    primary: "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300",
    secondary: "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 disabled:bg-zinc-50",
    danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
  }[variant]

  const fire = () => {
    startTransition(async () => {
      const result = await action()
      if (result.success) {
        toast.success(successToast)
      } else {
        toast.error(result.error || "Action failed")
      }
    })
  }

  const handleClick = () => {
    if (confirm) {
      setConfirmOpen(true)
      return
    }
    fire()
  }

  const handleConfirmAction = async () => {
    const result = await action()
    if (!result.success) {
      return { success: false, error: result.error || "Action failed" }
    }
    return { success: true, message: successToast }
  }

  return (
    <>
      <button
        type="button"
        disabled={isPending}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
          styles,
          className,
        )}
        onClick={handleClick}
      >
        {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
        {label}
      </button>
      {confirm && (
        <ConfirmDestructiveDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title={confirm.title}
          description={confirm.description}
          severity={confirm.severity ?? "amber"}
          staticPreview={confirm.preview}
          confirmLabel={confirm.confirmLabel ?? label}
          onConfirm={handleConfirmAction}
        />
      )}
    </>
  )
}
