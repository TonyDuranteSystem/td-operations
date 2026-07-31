"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { DEFAULT_EXPIRY_DAYS, EXPIRY_DAY_CHOICES, type ExpiryDays } from "@/lib/esign/expiry"

/**
 * Staff button: put an expired document back in flight with a fresh deadline,
 * instead of recreating it. Confirms first — reopening notifies the client, so
 * it is not a silent action.
 */
export function ReopenButton({ envelopeId }: { envelopeId: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [days, setDays] = useState<ExpiryDays>(DEFAULT_EXPIRY_DAYS)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  async function reopen() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/esign/envelopes/${envelopeId}/reopen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not reopen this document.")

      const parts: string[] = ["Reopened"]
      if (data.emailed) parts.push(`${data.emailed} emailed`)
      if (data.portal) parts.push(`${data.portal} nudged in the portal`)
      if (data.undeliverable) parts.push(`${data.undeliverable} undeliverable — copy their link`)
      if (Array.isArray(data.duplicates) && data.duplicates.length) {
        parts.push(
          `⚠ ${data.duplicates.length} other live cop${data.duplicates.length === 1 ? "y" : "ies"} of this document — void the stale one`,
        )
      }
      setMsg({ kind: data.duplicates?.length || data.undeliverable ? "err" : "ok", text: parts.join(" · ") })
      setConfirming(false)
      router.refresh()
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "Could not reopen this document." })
    } finally {
      setBusy(false)
    }
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => setConfirming(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Reopen
        </button>
        {msg && <span className={`text-xs ${msg.kind === "ok" ? "text-green-600" : "text-red-600"}`}>{msg.text}</span>}
      </div>
    )
  }

  return (
    <div className="flex w-72 flex-col items-end gap-1.5 rounded-md border bg-zinc-50 p-2">
      <p className="self-start text-xs text-zinc-600">
        Give this document a new deadline and put it back in front of the signer. Anything already signed is kept, and
        the original signing link keeps working. The signer is notified.
      </p>
      <div className="w-full">
        <label className="text-[11px] text-zinc-500">Time to sign</label>
        <div className="mt-1 inline-flex rounded-md border bg-white p-0.5">
          {EXPIRY_DAY_CHOICES.map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded px-2.5 py-1 text-xs font-medium ${days === d ? "bg-blue-600 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => { setConfirming(false); setMsg(null) }}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-white"
        >
          Cancel
        </button>
        <button
          onClick={reopen}
          disabled={busy}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Reopening…" : "Confirm reopen"}
        </button>
      </div>
      {msg && <span className="self-start text-xs text-red-600">{msg.text}</span>}
    </div>
  )
}
