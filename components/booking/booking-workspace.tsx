"use client"

/**
 * Booking page (Stage 1b) — the screen: "Make a link" on the left, "Links I made" on the right, and the "calls need you" line underneath.
 * "Calls to check" is a section of this page (Antonio, 14 Nov: the day-to-day work Calendar is a different page and stays as it is). The words are Antonio's, from the approved mockup. Parts that belong to later stages (the week calendar, clients' referral links, paying, a referrer) are not here.
 * A computer screen only: nothing is drawn for a phone.
 */

import { useCallback, useState } from "react"
import type { KindDto } from "@/lib/booking/kinds-admin"
import type { LinkDto } from "@/lib/booking/links"
import { callApi, messageOf } from "@/components/booking/api"
import { LinkMaker } from "@/components/booking/link-maker"
import { LinksMade } from "@/components/booking/links-made"
import { CallsToCheckTab } from "@/components/calls-to-check/calls-tab"
import type { CardDto } from "@/lib/booking/checks"

export interface MakeAgain {
  nonce: number
  contactId: string | null
  leadId: string | null
  name: string | null
  email: string | null
  kindSlug: string | null
  minutes: number | null
  once: boolean
}

export function BookingWorkspace({
  dateText,
  kinds: initialKinds,
  kindsError,
  links: initialLinks,
  linksError,
  callTypesReady,
  cards,
}: {
  dateText: string
  kinds: KindDto[] | null
  kindsError: string | null
  links: LinkDto[] | null
  linksError: string | null
  callTypesReady: boolean
  /** the bookings waiting for a look; null = they could not be read */
  cards: CardDto[] | null
}) {
  const [kinds, setKinds] = useState<KindDto[] | null>(initialKinds)
  const [links, setLinks] = useState<LinkDto[] | null>(initialLinks)
  const [linksProblem, setLinksProblem] = useState<string | null>(linksError)
  const [again, setAgain] = useState<MakeAgain | null>(null)

  const refreshLinks = useCallback(async () => {
    try {
      const r = await callApi<{ links: LinkDto[] }>("/api/booking/links", {}, "The links could not be read. Try again.")
      setLinks(r.links)
      setLinksProblem(null)
    } catch (e) {
      setLinksProblem(messageOf(e, "The links could not be read. Try again."))
    }
  }, [])

  const refreshKinds = useCallback(async () => {
    const r = await callApi<{ kinds: KindDto[] }>("/api/booking/kinds", {}, "The kinds could not be read. Try again.")
    setKinds(r.kinds)
    return r.kinds
  }, [])

  return (
    <div className="mx-auto max-w-[1360px] space-y-5" data-testid="booking-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Booking <span className="ml-1 rounded-full bg-zinc-200 px-2 py-0.5 align-middle text-xs font-semibold text-zinc-700">Only you</span>
          </h1>
          <p className="text-sm text-zinc-600">A link for every kind of call. Only you can see this page.</p>
        </div>
        <p className="text-sm text-zinc-600">{dateText} · times in New York</p>
      </div>

      {!callTypesReady && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status" data-testid="call-types-missing">
          The Calendly call types for this page are not set up yet, so a link cannot be made. Ask Claude to set them.
        </div>
      )}

      <div className="grid grid-cols-[minmax(380px,460px)_minmax(0,1fr)] items-start gap-5">
        <LinkMaker kinds={kinds} kindsError={kindsError} refreshKinds={refreshKinds} onMade={refreshLinks} again={again} callTypesReady={callTypesReady} />
        <LinksMade links={links} error={linksProblem} onChanged={refreshLinks} onMakeAgain={(l) => setAgain({ nonce: Date.now(), contactId: l.contactId, leadId: l.leadId, name: l.personName, email: l.email, kindSlug: l.kindSlug, minutes: l.minutes, once: l.once })} />
      </div>

      <section id="calls" className="space-y-3" data-testid="calls-section">
        <div>
          <h2 className="text-base font-semibold">
            Calls to check{" "}
            {cards !== null && (
              <span className={`ml-1 rounded-full px-2 py-0.5 align-middle font-mono text-xs ${cards.length > 0 ? "bg-red-100 text-red-700" : "bg-zinc-100 text-zinc-600"}`} data-testid="calls-count">{cards.length}</span>
            )}
          </h2>
          <p className="text-sm text-zinc-600">{cards === null ? "The calls to check could not be read." : cards.length === 0 ? "Nothing needs you." : `${cards.length} call${cards.length === 1 ? "" : "s"} need${cards.length === 1 ? "s" : ""} you.`}</p>
        </div>
        <CallsToCheckTab cards={cards} />
      </section>
    </div>
  )
}
