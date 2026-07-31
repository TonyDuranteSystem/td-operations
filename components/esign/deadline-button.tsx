"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { EXPIRY_DAY_CHOICES, type ExpiryDays } from "@/lib/esign/expiry"

/**
 * Staff control: change the deadline of a document already out with a client.
 * The client is not notified either way — it is an administrative change, and
 * the deadline is visible in their portal regardless.
 */
export function DeadlineButton({ envelopeId }: { envelopeId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExpiryDays | null>(null)
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  async function apply(days: ExpiryDays) {
    setBusy(days)
    setMsg(null)
    try {
      const res = await fetch(`/api/esign/envelopes/${envelopeId}/deadline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not change the deadline.")
      const when = data.expires_at
        ? new Date(data.expires_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
        : ""
      setMsg({ kind: "ok", text: when ? `Now due ${when}` : "Deadline updated" })
      setOpen(false)
      router.refresh()
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "Could not change the deadline." })
    } finally {
      setBusy(null)
    }
  }

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => setOpen(true)}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
        >
          Change deadline
        </button>
        {msg && <span className={`text-xs ${msg.kind === "ok" ? "text-green-600" : "text-red-600"}`}>{msg.text}</span>}
      </div>
    )
  }

  return (
    <div className="flex w-64 flex-col items-end gap-1.5 rounded-md border bg-zinc-50 p-2">
      <p className="self-start text-xs text-zinc-600">
        New deadline, counted from today. The client isn&apos;t notified — they just see the new date in their portal.
      </p>
      <div className="inline-flex rounded-md border bg-white p-0.5">
        {EXPIRY_DAY_CHOICES.map(d => (
          <button
            key={d}
            onClick={() => apply(d)}
            disabled={busy !== null}
            className="rounded px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-blue-600 hover:text-white disabled:opacity-50"
          >
            {busy === d ? "…" : `${d} days`}
          </button>
        ))}
      </div>
      <button onClick={() => { setOpen(false); setMsg(null) }} className="text-xs text-zinc-500 hover:text-zinc-700">
        Cancel
      </button>
      {msg && msg.kind === "err" && <span className="self-start text-xs text-red-600">{msg.text}</span>}
    </div>
  )
}
