"use client"

/**
 * Booking page, section "Calls to check" — the booked calls the system could not settle by itself, one card each, with Antonio's own buttons.
 * (The day-to-day work Calendar is a different page and is not touched by the Booking page.)
 * `cards` is null when the read failed — the section says so, it never says "nothing needs you" then.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { CardDto } from "@/lib/booking/checks"
import { callApi, messageOf } from "@/components/booking/api"

const callWhen = (iso: string | null): string | null =>
  iso ? `${new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET` : null

export function CallsToCheckTab({ cards }: { cards: CardDto[] | null }) {
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
        Bookings made through a link you sent that the system could not settle by itself. <b>Nothing was dropped</b>: each booking was saved as usual, and these cards ask you what it really was.
      </div>
      {open.length === 0 && done.length === 0 && <p className="rounded-lg border p-4 text-sm text-zinc-600" data-testid="calls-empty">Nothing needs you.</p>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-3">
        {open.map((c) => (
          <div key={c.id} className="grid content-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3.5" data-testid="call-card" data-kind={c.kind}>
            <p className="font-semibold">{c.question}</p>
            <p className="text-[12.5px] text-zinc-600">{c.why}</p>
            {callWhen(c.callAt) && <p className="text-[12.5px] text-zinc-600">The call is on {callWhen(c.callAt)}.</p>}
            {c.note && <p className="text-[12.5px] text-amber-900">{c.note}</p>}
            {errors[c.id] && <p className="text-sm text-red-700" role="alert">{errors[c.id]}</p>}
            <div className="flex flex-wrap gap-2">
              {c.answers.map((a) => (
                <button key={a.key} type="button" disabled={busy !== null} onClick={() => answer(c, a.key)} data-testid={`answer-${a.key}`} className={`rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${a.primary ? "border-zinc-900 bg-zinc-900 text-white" : "bg-white"}`}>
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
