"use client"

/**
 * "Unlock Confirm" for a failed statement-ingest job (card 4a39e0fd W9):
 * prompts for the MANDATORY reason, then runs the server action. Kept apart
 * from RetryButton because the reason prompt is part of the ruling — an
 * unlock without a typed reason must be impossible from the UI too.
 */

import { useState, useTransition } from "react"
import { toast } from "sonner"
import type { ActionResult } from "@/lib/server-action"

export function UnlockConfirmButton({
  action,
}: {
  action: (reason: string) => Promise<ActionResult>
}) {
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState(false)

  const onClick = () => {
    const reason = window.prompt(
      "Unlock the client's Confirm despite the failed statement file?\n\nType the reason (required, min 10 characters) — it is logged and the client is notified:",
    )
    if (reason === null) return
    startTransition(async () => {
      const r = await action(reason)
      if (r.success) {
        setDone(true)
        toast.success("Confirm unlocked — the client has been notified")
      } else {
        toast.error(r.error || "Could not unlock")
      }
    })
  }

  return (
    <button
      onClick={onClick}
      disabled={pending || done}
      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
    >
      {done ? "Unlocked" : pending ? "Unlocking…" : "Unlock Confirm"}
    </button>
  )
}
