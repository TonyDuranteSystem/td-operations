"use client"

/**
 * Booking page, section "Calls to check" — the booked calls the system could not settle by itself, one card each, with Antonio's own buttons.
 * (The day-to-day work Calendar is a different page and is not touched by the Booking page.)
 * `cards` is null when the read failed — the section says so, it never says "nothing needs you" then.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { CardDto, PaidCardInfo } from "@/lib/booking/checks"
import { callApi, dataOf, messageOf } from "@/components/booking/api"
import { OFF_REASON } from "@/lib/booking/mode-text"

const callWhen = (iso: string | null): string | null =>
  iso ? `${new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET` : null

export function CallsToCheckTab({ cards, off = false }: { cards: CardDto[] | null; off?: boolean }) {
  const router = useRouter()
  const [done, setDone] = useState<Array<{ id: string; question: string; message: string }>>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!cards) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
        <p className="font-medium">Could not load the calls to check.</p>
        <p className="mt-1">Nothing was changed. This is not &quot;nothing needs you&quot;: reload the page.</p>
      </div>
    )
  }

  const answer = async (card: CardDto, key: string) => {
    setBusy(`${card.id}:${key}`)
    setErrors((e) => { const n = { ...e }; delete n[card.id]; return n })
    try {
      const r = await callApi<{ message: string }>(`/api/booking/checks/${card.id}/answer`, { method: "POST", body: { answer: key } }, "The answer could not be saved. Try again.")
      setDone((d) => [...d, { id: card.id, question: card.question, message: r.message }])
      router.refresh()
    } catch (e) {
      setErrors((x) => ({ ...x, [card.id]: messageOf(e, "The answer could not be saved. Try again.") }))
    } finally {
      setBusy(null)
    }
  }

  // a card answered here stays on screen as "Done: …" even after the page refreshes (the refreshed list no longer holds it)
  const doneIds = new Set(done.map((d) => d.id))
  const open = cards.filter((c) => !doneIds.has(c.id))

  return (
    <div className="space-y-3" data-testid="calls-tab">
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
        Paid calls nobody has paid yet, and bookings made through a link you sent that the system could not settle by itself. <b>Nothing was dropped</b>: each booking was saved as usual, and these cards ask you what to do.
      </div>
      {off && open.length > 0 && <p className="text-sm font-semibold text-amber-900" data-testid="calls-off">{OFF_REASON}: you can read the cards, but not answer them yet.</p>}
      {open.length === 0 && done.length === 0 && <p className="rounded-lg border p-4 text-sm text-zinc-600" data-testid="calls-empty">Nothing needs you.</p>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-3">
        {open.map((c) => c.paid ? (
          <PaidCard key={c.id} card={c} paid={c.paid} off={off} onDone={(message) => { setDone((d) => [...d, { id: c.id, question: c.question, message }]); router.refresh() }}></PaidCard>
        ) : (
          <div key={c.id} className="grid content-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3.5" data-testid="call-card" data-kind={c.kind}>
            <p className="font-semibold">{c.question}</p>
            <p className="text-[12.5px] text-zinc-600">{c.why}</p>
            {callWhen(c.callAt) && <p className="text-[12.5px] text-zinc-600">The call is on {callWhen(c.callAt)}.</p>}
            {c.note && <p className="text-[12.5px] text-amber-900">{c.note}</p>}
            {errors[c.id] && <p className="text-sm text-red-700" role="alert">{errors[c.id]}</p>}
            <div className="flex flex-wrap gap-2">
              {c.answers.map((a) => (
                <button key={a.key} type="button" disabled={off || busy !== null} onClick={() => answer(c, a.key)} data-testid={`answer-${a.key}`} className={`rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${a.primary ? "border-zinc-900 bg-zinc-900 text-white" : "bg-white"}`}>
                  {busy === `${c.id}:${a.key}` ? "Saving…" : a.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        {done.map((d) => (
          <div key={d.id} className="grid content-start gap-2 rounded-lg border bg-zinc-50 p-3.5" data-testid="call-card-done">
            <p className="font-semibold text-zinc-500">{d.question}</p>
            <p className="text-[12.5px] text-zinc-600">Done: {d.message}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

const CARD_BTN = "rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"

/**
 * An unpaid paid call: the person booked, nobody has paid yet. Four buttons: Send payment link (shows the message first; nothing is sent from this page — it opens
 * Antonio's own email, or WhatsApp), Copy payment link, Cancel the call and Not charging. A portal client has no Send: the link is copied and sent in the portal chat by hand.
 */
function PaidCard({ card, paid, off, onDone }: { card: CardDto; paid: PaidCardInfo; off: boolean; onDone: (message: string) => void }) {
  const [panel, setPanel] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [sure, setSure] = useState<"cancel" | "stop" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [handCancel, setHandCancel] = useState<string | null>(null)

  const act = async (key: "sent" | "cancel-call" | "not-charging", fallback: string) => {
    setBusy(key)
    setError(null)
    setHandCancel(null)
    try {
      const r = await callApi<{ message: string }>(`/api/booking/links/${paid.linkId}/${key}`, { method: "POST", body: {} }, fallback)
      onDone(r.message)
    } catch (e) {
      setError(messageOf(e, fallback))
      const url = dataOf(e).cancelUrl
      if (key === "cancel-call" && typeof url === "string" && url.startsWith("https://")) setHandCancel(url)
    } finally {
      setBusy(null)
    }
  }

  const twoStep = (which: "cancel" | "stop", run: () => void) => {
    if (sure !== which) {
      setSure(which)
      setTimeout(() => setSure((s) => (s === which ? null : s)), 6000)
      return
    }
    setSure(null)
    run()
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(paid.payUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setError("Could not copy. Select the link in the message and press Cmd+C.")
    }
  }

  // The address came from what the booker typed on Calendly: only a plain address goes into the link (a "?", "&" or "," in it could add a Cc or a body to the draft).
  const plainEmail = paid.email && /^[^\s@,;?&=<>()"']+@[^\s@,;?&=<>()"']+\.[^\s@,;?&=<>()"']{2,}$/.test(paid.email) ? paid.email : ""
  const mailto = `mailto:${plainEmail}?subject=${encodeURIComponent(paid.draft.subject)}&body=${encodeURIComponent(paid.draft.body)}`
  return (
    <div className="grid content-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3.5" data-testid="call-card" data-kind="unpaid_call">
      <p className="font-semibold">{card.question}</p>
      <p className="text-[12.5px] text-zinc-600">{card.why}</p>
      {callWhen(card.callAt) && <p className="text-[12.5px] text-zinc-600">The call is on {callWhen(card.callAt)}.</p>}
      {card.note && <p className="text-[12.5px] text-amber-900" data-testid="paid-note">{card.note}</p>}
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      {handCancel && <a href={handCancel} target="_blank" rel="noreferrer" className="text-xs font-semibold text-blue-700 underline">Open the booker&apos;s cancel page</a>}
      <div className="flex flex-wrap gap-2">
        {!paid.copyOnly && <button type="button" disabled={off || busy !== null} onClick={() => setPanel((p) => !p)} className={`${CARD_BTN} border-zinc-900 bg-zinc-900 text-white`} data-testid="paid-send">Send payment link</button>}
        <button type="button" onClick={copy} className={`${CARD_BTN} ${paid.copyOnly ? "border-zinc-900 bg-zinc-900 text-white" : "bg-white"}`} data-testid="paid-copy">{copied ? "Copied" : "Copy payment link"}</button>
        <button type="button" disabled={off || busy !== null} onClick={() => twoStep("cancel", () => act("cancel-call", "The call could not be cancelled. Nothing was cancelled. Try again."))} className={`${CARD_BTN} bg-white`} data-testid="paid-cancel">{busy === "cancel-call" ? "Cancelling…" : sure === "cancel" ? "Sure? Calendly emails the booker" : "Cancel the call"}</button>
        <button type="button" disabled={off || busy !== null} onClick={() => twoStep("stop", () => act("not-charging", "That could not be saved. Try again."))} className={`${CARD_BTN} bg-white`} data-testid="paid-stop">{busy === "not-charging" ? "Saving…" : sure === "stop" ? "Sure? No payment will be taken" : "Not charging"}</button>
      </div>
      {panel && !paid.copyOnly && (
        <div className="grid gap-2 rounded-md border bg-white p-3 text-sm" data-testid="paid-message">
          <p className="text-xs text-zinc-500">Nothing is sent from this page. Read the message, open it in your own email (or WhatsApp), send it, then press &quot;I sent it&quot;.</p>
          <p><b>To:</b> {paid.email ?? <span className="text-amber-700">no email known: copy the link instead</span>}</p>
          <p><b>Subject:</b> {paid.draft.subject}</p>
          <pre className="whitespace-pre-wrap break-words rounded bg-zinc-50 p-2 font-sans text-[13px]" data-testid="paid-body">{paid.draft.body}</pre>
          <div className="flex flex-wrap gap-2">
            <a href={mailto} className={`${CARD_BTN} bg-white`} data-testid="paid-mailto">Open in my email</a>
            <a href={`https://wa.me/?text=${encodeURIComponent(paid.draft.body)}`} target="_blank" rel="noreferrer" className={`${CARD_BTN} bg-white`}>WhatsApp</a>
            <button type="button" disabled={off || busy !== null} onClick={() => act("sent", "That could not be saved. Try again.")} className={`${CARD_BTN} border-zinc-900 bg-zinc-900 text-white`} data-testid="paid-sent">{busy === "sent" ? "Saving…" : "I sent it"}</button>
          </div>
        </div>
      )}
    </div>
  )
}
