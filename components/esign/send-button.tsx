"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

/** Staff button: send the document to pending signers (CRM clients with a portal
 *  login → portal; everyone else → email the signing link). */
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
      // The send route routes each signer by channel: CRM clients with a portal
      // login → portal; everyone else → email. Response: { emailed, portal, undeliverable }.
      const emailed = data.emailed ?? 0
      const portal = data.portal ?? 0
      const undeliverable = data.undeliverable ?? 0
      const parts: string[] = []
      if (emailed) parts.push(`${emailed} emailed`)
      if (portal) parts.push(`${portal} sent to portal`)
      if (undeliverable) parts.push(`${undeliverable} undeliverable (no email/portal — copy their link)`)
      if (!parts.length) parts.push("Nothing to send (no pending signers)")
      setMsg({ kind: undeliverable ? "err" : "ok", text: parts.join(" · ") })
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
