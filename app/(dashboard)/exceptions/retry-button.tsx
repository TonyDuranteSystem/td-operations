"use client"

import { useTransition } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export function RetryButton({
  action,
  label,
  successToast,
  variant = "primary",
  className,
}: {
  action: () => Promise<{ success: boolean; error?: string }>
  label: string
  successToast: string
  variant?: "primary" | "secondary" | "danger"
  className?: string
}) {
  const [isPending, startTransition] = useTransition()

  const styles = {
    primary: "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300",
    secondary: "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 disabled:bg-zinc-50",
    danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
  }[variant]

  return (
    <button
      type="button"
      disabled={isPending}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        styles,
        className,
      )}
      onClick={() => {
        startTransition(async () => {
          const result = await action()
          if (result.success) {
            toast.success(successToast)
          } else {
            toast.error(result.error || "Action failed")
          }
        })
      }}
    >
      {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
    </button>
  )
}
