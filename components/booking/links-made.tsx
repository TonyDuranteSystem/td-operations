"use client"

/** Booking page — "Links I made": every link Antonio made and what happened to it. Copy it again, stop it, or make it again. */

import { useState } from "react"
import type { LinkDto } from "@/lib/booking/links"
import { callApi, messageOf } from "@/components/booking/api"

const STATUS_CLASS: Record<string, string> = {
  open: "text-amber-700",
  claimed: "text-green-700",
  revoked: "text-zinc-500",
  expired: "text-zinc-500",
}

const BADGE = "rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700"

function madeText(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })
}

function callText(l: LinkDto): string {
  const len = l.minutes === null ? "" : l.minutes === 60 ? "1 hour" : l.minutes === 120 ? "2 hours" : `${l.minutes} min`
  return `${len}${len ? " · " : ""}${l.once ? "first booking only" : "every booking"}`
}

export function LinksMade({ links, error, onChanged, onMakeAgain }: { links: LinkDto[] | null; error: string | null; onChanged: () => Promise<void> | void; onMakeAgain: (l: LinkDto) => void }) {
  const [sure, setSure] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ id: string; text: string; bad: boolean } | null>(null)

  const copy = async (l: LinkDto) => {
    try {
      await navigator.clipboard.writeText(l.url)
      setNote({ id: l.id, text: "Copied", bad: false })
    } catch {
      setNote({ id: l.id, text: "Could not copy. Select the link in the page and press Cmd+C.", bad: true })
    }
    setTimeout(() => setNote((n) => (n && n.id === l.id ? null : n)), 2200)
  }

  const stop = async (l: LinkDto) => {
    if (sure !== l.id) {
      setSure(l.id)
      setTimeout(() => setSure((s) => (s === l.id ? null : s)), 4000)
      return
    }
    setBusy(l.id)
    setSure(null)
    try {
      const r = await callApi<{ message: string }>(`/api/booking/links/${l.id}/revoke`, { method: "POST", body: {} }, "The link could not be stopped. Try again.")
      setNote({ id: l.id, text: r.message, bad: false })
      await onChanged()
    } catch (e) {
      setNote({ id: l.id, text: messageOf(e, "The link could not be stopped. Try again."), bad: true })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section id="links" className="min-w-0 rounded-lg border bg-white" data-testid="links-made">
      <div className="px-4 pt-4">
        <h2 className="text-base font-semibold">Links I made</h2>
        <p className="text-sm text-zinc-600">Every link you sent, and what happened to it.</p>
      </div>
      <div className="overflow-x-auto px-4 pb-4 pt-3">
        {error && <p className="mb-2 text-sm text-red-700" role="alert">{error}</p>}
        {links === null ? (
          <p className="text-sm text-zinc-500">The links could not be read. This is not &quot;no links&quot;: reload the page.</p>
        ) : links.length === 0 ? (
          <p className="text-sm text-zinc-500" data-testid="no-links">No link made yet. The ones you make will appear here.</p>
        ) : (
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-zinc-500">
                <th className="border-b px-2.5 py-2">For</th><th className="border-b px-2.5 py-2">Kind</th><th className="border-b px-2.5 py-2">Call</th><th className="border-b px-2.5 py-2">Made</th><th className="border-b px-2.5 py-2">What happened</th><th className="border-b px-2.5 py-2" />
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id} className="align-middle" data-testid="link-row" data-status={l.status}>
                  <td className="border-b px-2.5 py-2"><b>{l.personName ?? "Someone new"}</b></td>
                  <td className="border-b px-2.5 py-2"><span className={BADGE}>{l.kindLabel}</span></td>
                  <td className="border-b px-2.5 py-2 text-zinc-700">{callText(l)}</td>
                  <td className="border-b px-2.5 py-2 text-zinc-700">{madeText(l.madeAt)}</td>
                  <td className="border-b px-2.5 py-2">
                    <span className={`text-[12.5px] font-semibold ${STATUS_CLASS[l.status] ?? ""}`}>{l.what}</span>
                    {note?.id === l.id && <span className={`mt-1 block max-w-[260px] text-xs font-semibold ${note.bad ? "text-red-700" : "text-green-700"}`} role={note.bad ? "alert" : "status"}>{note.text}</span>}
                  </td>
                  <td className="whitespace-nowrap border-b px-2.5 py-2 text-right">
                    {l.status === "open" && (
                      <>
                        <button type="button" onClick={() => copy(l)} className="mr-1.5 rounded-md border px-2.5 py-1 text-xs font-medium">Copy</button>
                        <button type="button" disabled={busy === l.id} onClick={() => stop(l)} className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50" data-testid="stop-link">{sure === l.id ? "Sure? Stop it" : "Stop link"}</button>
                      </>
                    )}
                    {(l.status === "revoked" || l.status === "expired") && <button type="button" onClick={() => onMakeAgain(l)} className="rounded-md border px-2.5 py-1 text-xs font-medium">Make again</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
