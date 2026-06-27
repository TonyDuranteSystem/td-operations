"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

/** Staff button: email the signing link to pending signers. */
export function SendButton({ envelopeId, label = "Send for signature" }: { envelopeId: string; label?: string }) {
  const router = useRouter()
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  async function send() {
    setSending(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/esign/envelopes/${envelopeId}/send`, { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not send.")
      const parts = [`${data.queued} email${data.queued === 1 ? "" : "s"} queued`]
      if (data.noEmail) parts.push(`${data.noEmail} signer(s) have no email — copy their link instead`)
      setMsg({ kind: "ok", text: parts.join(" · ") })
      router.refresh()
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "Could not send." })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={send}
        disabled={sending}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {sending ? "Sending…" : label}
      </button>
      {msg && <span className={`text-xs ${msg.kind === "ok" ? "text-green-600" : "text-red-600"}`}>{msg.text}</span>}
    </div>
  )
}
