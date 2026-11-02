"use client"

import { useState } from "react"

interface Preview { to: string; from: string; replyTo: string | null; subject: string; html: string; lang: "en" | "it" }

/**
 * "Send by email" under a freshly made password-reset link (dev job 9aec66fa). Same idea as the invitation email: he presses the button, SEES the exact email (an isolated frame, no scripts) and
 * presses Send now. Nothing leaves before that. The recipient is the login's own address (the server decides, it is never typed here); the link stays available to copy.
 */
export function ResetEmailPanel({ url }: { url: string }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [sent, setSent] = useState<{ to: string; from: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const token = (() => { try { return new URL(url).searchParams.get("token") ?? "" } catch { return "" } })()

  async function call(send: boolean, fallback: string, lang?: "en" | "it"): Promise<Record<string, unknown> | null> {
    setBusy(true); setError(null)
    try {
      const res = await fetch("/api/marketing-admin/resets/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, send, lang }) })
      const d = await res.json().catch(() => ({})) as Record<string, unknown>
      if (!res.ok) throw new Error(typeof d.error === "string" && d.error ? d.error : fallback)
      return d
    } catch (e) { setError(e instanceof Error && e.message ? e.message : fallback); return null } finally { setBusy(false) }
  }
  async function showPreview(lang?: "en" | "it") {
    const d = await call(false, "Could not prepare the email. Please try again, or copy the link.", lang)
    if (d) setPreview(d as unknown as Preview)
  }
  async function send() {
    const d = await call(true, "The email could not be sent. Please try again, or copy the link.", preview?.lang)
    if (d) { setSent({ to: String(d.to), from: String(d.from ?? preview?.from ?? "") }); setPreview(null) }
  }

  const btn = "rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50"
  if (sent) {
    return <div className="mt-3 rounded-lg border border-emerald-300 bg-white p-3 text-sm text-emerald-800" role="status" data-testid="reset-email-sent">Sent to {sent.to} from {sent.from}. You can still copy the link.</div>
  }
  return (
    <div className="mt-3" data-testid="reset-email-panel">
      {!preview && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy || !token} onClick={() => showPreview()} data-testid="reset-email-open">&#9993; Send by email</button>
          <span className="text-xs text-slate-500">You see the email first. Nothing is sent until you press Send.</span>
        </div>
      )}
      {preview && (
        <div className="rounded-lg border bg-white p-3" data-testid="reset-email-preview">
          <p className="mb-2 text-xs text-slate-500">This is exactly what will be sent:</p>
          <dl className="mb-2 grid grid-cols-[96px_1fr] gap-y-0.5 text-sm">
            <dt className="text-slate-500">From</dt><dd>{preview.from}</dd>
            <dt className="text-slate-500">To</dt><dd data-testid="reset-email-to">{preview.to}</dd>
            {preview.replyTo && <><dt className="text-slate-500">Replies go to</dt><dd>{preview.replyTo}</dd></>}
            <dt className="text-slate-500">Subject</dt><dd data-testid="reset-email-subject">{preview.subject}</dd>
            <dt className="text-slate-500">Language</dt>
            <dd className="flex gap-1">
              {(["it", "en"] as const).map(l => (
                <button key={l} type="button" disabled={busy || preview.lang === l} data-testid={`reset-email-lang-${l}`} onClick={() => showPreview(l)}
                  className={`rounded border px-2 text-xs ${preview.lang === l ? "bg-slate-900 text-white" : ""}`}>{l === "it" ? "Italian" : "English"}</button>
              ))}
            </dd>
          </dl>
          <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[330px] w-full rounded-lg border bg-white" data-testid="reset-email-frame" />
          <div className="mt-3 flex gap-2">
            <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy} onClick={send} data-testid="reset-email-send">Send now</button>
            <button type="button" className={btn} disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="reset-email-error">{error}</p>}
    </div>
  )
}
