"use client"

import { useState } from "react"
import { ResetEmailPanel } from "./reset-email-panel"
import { KEEP_WHOLE, pinBodyCell } from "@/lib/ui/table-cells"

/**
 * One person in a team's People table, with the admin's "Reset password" (dev job 9aec66fa). Pressing it makes a one-time link; it is shown here once, Antonio copies it and sends it himself (it works
 * once, for 24 hours). Every server answer, including a refusal, is shown as written (R099). `canReset` is false for his own row and for a paused person (the server refuses both anyway).
 */
export function PersonRow({ teamId, userId, email, roleText, statusText, seenText, canReset }: {
  teamId: string; userId: string; email: string; roleText: string; statusText: string; seenText: string; canReset: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [link, setLink] = useState<{ url: string; email: string; expiresAt: string } | null>(null)

  async function reset() {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await fetch(`/api/marketing-admin/teams/${teamId}/members/${userId}/reset`, { method: "POST" })
      const d = await res.json().catch(() => ({})) as Record<string, unknown>
      if (!res.ok) throw new Error(typeof d.error === "string" && d.error ? d.error : "Could not make the link. Please try again.")
      setLink({ url: String(d.resetUrl), email: String(d.email ?? email), expiresAt: String(d.expiresAt) })
    } catch (e) { setError(e instanceof Error && e.message ? e.message : "Could not make the link. Please try again.") } finally { setBusy(false) }
  }

  const expires = link ? new Date(link.expiresAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Rome" }) : ""
  return (
    <>
      <tr className="group">
        <td className={`py-2 pr-3 font-medium ${KEEP_WHOLE} ${pinBodyCell("start", "none", "card")}`}>{email}</td>
        <td className={`pr-3 ${KEEP_WHOLE}`}>{roleText}</td>
        <td className={`pr-3 ${KEEP_WHOLE}`}>{statusText}</td>
        <td className={`pr-3 text-slate-500 ${KEEP_WHOLE}`}>{seenText}</td>
        <td className={`pl-3 text-right ${pinBodyCell("end", "none", "card")}`}>
          {canReset && <button type="button" className={`rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${KEEP_WHOLE}`} disabled={busy} onClick={reset} data-testid="admin-reset-password" aria-label={`Reset password for ${email}`}>Reset password</button>}
        </td>
      </tr>
      {(link || error || done) && (
        <tr>
          <td colSpan={5} className="pb-3">
            {link && (
              <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm" aria-label="Password reset link">
                <p className="font-medium">Password reset link for {link.email}</p>
                <p className="text-slate-700">Email it below, or copy the link and send it yourself (WhatsApp, anything). It works once and expires {expires} (Rome time). It is shown only now: press Reset password again for a new one.</p>
                <input readOnly aria-label="Password reset link" className="mt-2 w-full rounded-lg border bg-white px-3 py-2 text-xs" value={link.url} onFocus={e => e.currentTarget.select()} />
                <button type="button" className="mt-2 rounded-lg border px-3 py-2 text-sm font-medium" onClick={() => { void navigator.clipboard?.writeText(link.url).then(() => { setError(null); setDone("Link copied.") }).catch(() => setError("Could not copy. Select the link and copy it.")) }}>Copy link</button>
                <ResetEmailPanel url={link.url} />
              </div>
            )}
            {done && <p role="status" className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{done}</p>}
            {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
          </td>
        </tr>
      )}
    </>
  )
}
