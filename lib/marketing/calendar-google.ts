/**
 * TD Marketing — the Google part of the Calendar (server; dev job 9aec66fa, Addendum K, B3 and B5). For one viewer it reads what Google holds that this viewer may see, and runs EVERY item through
 * the visibility rule (calendar-visibility.ts) before anything leaves the server: the owner reads his own calendar in full, the seller reads his work calendar in full, and each sees the other's
 * time only as "Busy"; the setter gets nothing. A personal calendar is only asked "when is he busy", and only while it is shared as "free/busy only". A failure never breaks the page: it comes back
 * as a plain warning, and nothing is shown as free because Google could not answer. Everything goes through `GcalApi`, so it is tested with a fake.
 */
import { checkShare, isWorkMailbox, itemFromBusy, itemFromEvent, shareOk, type GcalApi, type ShareResult } from "@/lib/marketing/gcal"
import { shownList, type GoogleItem, type Shown, type Viewer } from "@/lib/marketing/calendar-visibility"
import type { Taker, TimePrefs } from "@/lib/marketing/time-prefs"

export interface GoogleLayer {
  items: Shown[]
  /** plain sentences for the screen: what could not be read */
  warnings: string[]
  /** the state of each personal calendar's share (empty while the Busy switch is off or nobody has a personal calendar) */
  share: Array<ShareResult & { who: string }>
  /** every personal calendar is shared as free/busy only (or there is none): the Busy time can be trusted */
  shareOk: boolean
  /** the owner's own Google calendar was read (the Calendar shows "+ Add event" and a Move button on it) */
  ownerCalendar: boolean
}

const EMPTY: GoogleLayer = { items: [], warnings: [], share: [], shareOk: true, ownerCalendar: false }

export async function loadGoogleLayer(i: {
  api: GcalApi; viewer: Viewer; viewerUserId: string; viewerEmail: string | null; prefs: TimePrefs; takers: readonly Taker[]; fromMs: number; toMs: number
}): Promise<GoogleLayer> {
  if (i.viewer === "none") return { ...EMPTY }
  const isSetter = i.viewer === "setter" // she is asked about the SELLER only: nothing of the owner is read, kept or passed on
  const min = new Date(i.fromMs).toISOString(), max = new Date(i.toMs).toISOString()
  const owner = i.prefs.ownerClock
  const ownerEmail = isSetter ? null : owner.email ?? (i.viewer === "owner" ? i.viewerEmail : null)
  const sellers = i.viewer === "seller" ? i.takers.filter(t => t.userId === i.viewerUserId) : [...i.takers]
  const raw: GoogleItem[] = []
  const warnings: string[] = []
  const share: GoogleLayer["share"] = []
  let allShared = true
  let ownerCalendar = false

  if (isWorkMailbox(ownerEmail)) {
    if (i.viewer === "owner") {
      try {
        for (const e of await i.api.listEvents(ownerEmail, "primary", min, max)) { const it = itemFromEvent(e, "owner", "o"); if (it) raw.push(it) }
        ownerCalendar = true
      } catch { warnings.push("Could not read your Google calendar right now.") }
    } else if (i.prefs.busyEnabled) {
      // the seller sees the owner's time only as Busy: the question asked is free/busy, never the events
      try {
        const fb = (await i.api.freeBusy(ownerEmail, ["primary"], min, max)).primary
        // an answer with an error is not "free": warn, never show him as free
        if (!fb || fb.error) warnings.push(`Could not read ${owner.label}'s calendar right now.`)
        else fb.busy.forEach((b, k) => raw.push(itemFromBusy(b, "owner", "o", k)))
      } catch { warnings.push(`Could not read ${owner.label}'s calendar right now.`) }
    }
  }

  if (i.prefs.busyEnabled) {
    for (const s of sellers) {
      if (!isWorkMailbox(s.email)) continue
      const personal = i.prefs.personalCalendars[s.userId] ?? []
      const sr = await checkShare(i.api, s.email, personal)
      sr.forEach(r => share.push({ ...r, who: s.label }))
      const ok = shareOk(sr)
      allShared = allShared && ok
      try {
        for (const e of await i.api.listEvents(s.email, "primary", min, max)) {
          if (e.marketingLeadId) continue // a call Marketing wrote there: the Calendar already draws it from its own list
          const it = itemFromEvent(e, "seller_td", `t${s.userId}`)
          if (it) raw.push(it)
        }
      } catch { warnings.push(`Could not read ${s.label}'s work calendar right now.`) }
      if (ok && personal.length > 0) {
        try {
          const fb = await i.api.freeBusy(s.email, personal, min, max)
          for (const id of personal) {
            const r = fb[id]
            if (!r || r.error) { warnings.push(`Could not read ${s.label}'s personal calendar right now.`); allShared = false; continue }
            r.busy.forEach((b, k) => raw.push(itemFromBusy(b, "seller_personal", `p${s.userId}:${id}`, k)))
          }
        } catch { warnings.push(`Could not read ${s.label}'s personal calendar right now.`); allShared = false }
      }
    }
  }

  // an event both people are part of sits on BOTH calendars: draw it once (the seller's own copy for him, the owner's own copy for the owner), and drop the owner's Busy block that is only that event
  const withOwner = (it: GoogleItem) => ownerEmail !== null && it.guests.some(g => g.toLowerCase() === ownerEmail.toLowerCase())
  const sharedTd = raw.filter(it => it.kind === "seller_td" && withOwner(it))
  const deduped = raw.filter(it => {
    if (it.kind === "seller_td" && withOwner(it)) return i.viewer !== "owner" || !ownerCalendar
    if (it.kind === "owner" && it.title === "Busy") return !sharedTd.some(t => t.start === it.start && t.end === it.end)
    return true
  })
  const items = shownList(i.viewer, deduped, { shareOk: allShared, ownerEmail: ownerEmail ?? null, ownerLabel: isSetter ? "" : owner.label, sellerLabel: sellers[0]?.label ?? "Seller" })
  return { items, warnings, share, shareOk: allShared, ownerCalendar }
}
