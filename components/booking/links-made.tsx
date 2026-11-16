"use client"

/**
 * Booking page — "Links I made": every link Antonio made and what happened to it. Copy it again, stop it, make it again, or — once someone has booked — cancel the call.
 * The "What happened" words come from the server (the stored booking + Calendly), so a booked or cancelled call is no longer shown as "Waiting" (dev job a9285887, 15 Nov 2026).
 * Pointing at a name shows the same little card as the Contacts list.
 */

import { useRef, useState } from "react"
import type { LinkDto } from "@/lib/booking/links"
import { callApi, dataOf, messageOf } from "@/components/booking/api"
import { ListHoverCard } from "@/components/lists/hover-card"
import { OFF_REASON } from "@/lib/booking/mode-text"

const STATUS_CLASS: Record<string, string> = {
  open: "text-amber-700",
  claimed: "text-green-700",
  revoked: "text-zinc-500",
  expired: "text-zinc-500",
}

/** Colour of "What happened" once a booking is known: booked = green, could not check = amber, cancelled = grey. */
function bookingClass(l: LinkDto): string {
  const state = l.booking?.state
  if (!state) return STATUS_CLASS[l.status] ?? ""
  if (state === "booked") return "text-green-700"
  if (state === "booked_unchecked") return "text-amber-700"
  return "text-zinc-500"
}

/** a second click sooner than this after the first one is a double-click, not a confirmation */
const SECOND_CLICK_MS = 700

const BADGE = "rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700"
const BTN = "rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50"

function madeText(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })
}

function callText(l: LinkDto): string {
  const len = l.minutes === null ? "" : l.minutes === 60 ? "1 hour" : l.minutes === 120 ? "2 hours" : `${l.minutes} min`
  return `${len}${len ? " · " : ""}${l.once ? "first booking only" : "every booking"}`
}

const ASKS_TEXT = { full: "Asks the full questions", short: "Asks only the short note" } as const

export function LinksMade({ links, error, off, onChanged, onMakeAgain }: { links: LinkDto[] | null; error: string | null; off: boolean; onChanged: () => Promise<void> | void; onMakeAgain: (l: LinkDto) => void }) {
  const [sure, setSure] = useState<string | null>(null)
  const [sureCancel, setSureCancel] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ id: string; text: string; bad: boolean } | null>(null)
  /** the booker's own cancel page, offered only after the app was refused */
  const [handCancel, setHandCancel] = useState<{ id: string; url: string } | null>(null)

  const copy = async (l: LinkDto) => {
    try {
      await navigator.clipboard.writeText(l.url)
      setNote({ id: l.id, text: "Copied", bad: false })
    } catch {
      setNote({ id: l.id, text: "Could not copy. Select the link in the page and press Cmd+C.", bad: true })
    }
    setTimeout(() => setNote((n) => (n && n.id === l.id ? null : n)), 2200)
  }

  const copyPay = async (l: LinkDto) => {
    if (!l.pay) return
    try {
      await navigator.clipboard.writeText(l.pay.payUrl)
      setNote({ id: l.id, text: "Payment link copied", bad: false })
    } catch {
      setNote({ id: l.id, text: "Could not copy. Select the link in the page and press Cmd+C.", bad: true })
    }
    setTimeout(() => setNote((n) => (n && n.id === l.id ? null : n)), 2200)
  }

  // a mouse double-click must not count as the deliberate second click ("Sure?" never read)
  const armedAt = useRef(0)

  const stop = async (l: LinkDto) => {
    if (sure !== l.id) {
      armedAt.current = Date.now()
      setSure(l.id)
      setTimeout(() => setSure((s) => (s === l.id ? null : s)), 4000)
      return
    }
    if (Date.now() - armedAt.current < SECOND_CLICK_MS) return
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

  const cancelCall = async (l: LinkDto) => {
    if (sureCancel !== l.id) {
      armedAt.current = Date.now()
      setSureCancel(l.id)
      setTimeout(() => setSureCancel((s) => (s === l.id ? null : s)), 6000)
      return
    }
    if (Date.now() - armedAt.current < SECOND_CLICK_MS) return
    setBusy(l.id)
    setSureCancel(null)
    setHandCancel(null)
    try {
      const r = await callApi<{ message: string }>(`/api/booking/links/${l.id}/cancel-call`, { method: "POST", body: {} }, "The call could not be cancelled. Nothing was cancelled. Try again.")
      setNote({ id: l.id, text: r.message, bad: false })
      await onChanged()
    } catch (e) {
      setNote({ id: l.id, text: messageOf(e, "The call could not be cancelled. Nothing was cancelled. Try again."), bad: true })
      const url = dataOf(e).cancelUrl
      if (typeof url === "string" && url.startsWith("https://")) setHandCancel({ id: l.id, url })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section id="links" className="min-w-0 rounded-lg border bg-white" data-testid="links-made">
      <div className="px-4 pt-4">
        <h2 className="text-base font-semibold">Links I made</h2>
        <p className="text-sm text-zinc-600">Every link you sent, and what happened to it.</p>
        {off && <p className="mt-1 text-sm font-semibold text-amber-900" data-testid="links-off">{OFF_REASON}: you can look, but not stop a link, cancel a call or make one again yet.</p>}
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
              {links.map((l) => {
                const booked = !!l.booking && l.booking.canCancel
                const cancelled = !!l.booking && !l.booking.canCancel
                return (
                  <tr key={l.id} className="align-middle" data-testid="link-row" data-status={l.status} data-booking={l.booking?.state ?? "none"}>
                    <td className="border-b px-2.5 py-2">
                      <ListHoverCard card={l.card}><b>{l.who.primary}</b></ListHoverCard>
                      {l.who.secondary && <span className={`block max-w-[210px] break-words text-xs ${l.who.differs ? "font-semibold text-amber-700" : "text-zinc-500"}`} data-testid="link-booker">{l.who.secondary}</span>}
                    </td>
                    <td className="border-b px-2.5 py-2"><span className={BADGE}>{l.kindLabel}</span></td>
                    <td className="border-b px-2.5 py-2 text-zinc-700">
                      {callText(l)}
                      {l.asks && <span className="block text-xs text-zinc-500" data-testid="link-asks">{ASKS_TEXT[l.asks]}</span>}
                    </td>
                    <td className="border-b px-2.5 py-2 text-zinc-700">{madeText(l.madeAt)}</td>
                    <td className="border-b px-2.5 py-2">
                      <span className={`text-[12.5px] font-semibold ${bookingClass(l)}`} data-testid="link-what">{l.what}</span>
                      {l.pay && <span className={`block text-xs font-semibold ${l.pay.state === "paid" ? "text-green-700" : l.pay.state === "not_charging" ? "text-zinc-500" : "text-amber-700"}`} data-testid="link-pay">{l.pay.text}</span>}
                      {note?.id === l.id && <span className={`mt-1 block max-w-[260px] text-xs font-semibold ${note.bad ? "text-red-700" : "text-green-700"}`} role={note.bad ? "alert" : "status"}>{note.text}</span>}
                      {handCancel?.id === l.id && <a href={handCancel.url} target="_blank" rel="noreferrer" className="mt-1 block text-xs font-semibold text-blue-700 underline" data-testid="hand-cancel">Open the booker&apos;s cancel page</a>}
                    </td>
                    <td className="whitespace-nowrap border-b px-2.5 py-2 text-right">
                      {l.pay?.state === "unpaid" && booked && <button type="button" onClick={() => copyPay(l)} className={`mr-1.5 ${BTN}`} data-testid="copy-pay">Copy payment link</button>}
                      {booked && (
                        <>
                          {!l.once && <button type="button" onClick={() => copy(l)} className={`mr-1.5 ${BTN}`}>Copy</button>}
                          <button type="button" disabled={off || busy === l.id} onClick={() => cancelCall(l)} className={BTN} data-testid="cancel-call">{sureCancel === l.id ? "Sure? Calendly emails the booker" : "Cancel the call"}</button>
                        </>
                      )}
                      {!booked && !cancelled && l.status === "open" && (
                        <>
                          <button type="button" onClick={() => copy(l)} className={`mr-1.5 ${BTN}`}>Copy</button>
                          <button type="button" disabled={off || busy === l.id} onClick={() => stop(l)} className={BTN} data-testid="stop-link">{sure === l.id ? "Sure? Stop it" : "Stop link"}</button>
                        </>
                      )}
                      {(cancelled || l.status === "revoked" || l.status === "expired") && !booked && <button type="button" disabled={off} onClick={() => onMakeAgain(l)} className={BTN}>Make again</button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
