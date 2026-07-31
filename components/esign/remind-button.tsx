"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

/** Staff button: nudge whoever is still holding this document up. */
export function RemindButton({ envelopeId }: { envelopeId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  async function remind() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/esign/envelopes/${envelopeId}/remind`, { method: "POST" })
      const data = await res.json().catch(() => ({}))
      // Surface the server's own reason — a throttle and a dead envelope are
      // very different problems and a generic failure message hides both.
      if (!res.ok) throw new Error(data.error || "Could not send the reminder.")
      const parts: string[] = []
      if (data.emailed) parts.push(`${data.emailed} emailed`)
      if (data.portal) parts.push(`${data.portal} nudged in the portal`)
      if (data.throttled) parts.push(`${data.throttled} skipped (reminded recently)`)
      if (data.undeliverable) parts.push(`${data.undeliverable} undeliverable — copy their link`)
      setMsg({
        kind: data.undeliverable ? "err" : "ok",
        text: parts.length ? parts.join(" · ") : "Nothing to send.",
      })
      router.refresh()
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "Could not send the reminder." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={remind}
        disabled={busy}
        className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send reminder"}
      </button>
      {msg && <span className={`text-xs ${msg.kind === "ok" ? "text-green-600" : "text-red-600"}`}>{msg.text}</span>}
    </div>
  )
}
