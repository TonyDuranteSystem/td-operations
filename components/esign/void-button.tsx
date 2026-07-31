"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

/** Staff button: void an in-flight envelope so it can no longer be signed. */
export function VoidButton({ envelopeId }: { envelopeId: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function doVoid() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/esign/envelopes/${envelopeId}/void`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not void this envelope.")
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not void this envelope.")
    } finally {
      setBusy(false)
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
      >
        Void
      </button>
    )
  }

  return (
    <div className="flex w-72 flex-col items-end gap-1.5 rounded-md border border-red-200 bg-red-50 p-2">
      <p className="self-start text-xs text-red-700">
        Void this document? Signers can no longer sign it, and it can no longer be reopened. This cannot be undone.
      </p>
      <input
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Reason (optional)"
        className="h-8 w-full rounded border px-2 text-sm"
      />
      <div className="flex gap-2">
        <button onClick={() => { setConfirming(false); setErr(null) }} className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-white">
          Cancel
        </button>
        <button onClick={doVoid} disabled={busy} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
          {busy ? "Voiding…" : "Confirm void"}
        </button>
      </div>
      {err && <span className="self-start text-xs text-red-600">{err}</span>}
    </div>
  )
}
