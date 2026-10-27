/**
 * What a team member may do with a lead (pure; TD Marketing, dev job 9aec66fa, Slice 2a). Decides, from the lead as it is NOW, who is
 * acting and the team's settings, whether the action is allowed and exactly what to write. No database here: `lead-actions-server.ts`
 * loads the facts, calls this, and writes the result. Stage names, reasons and the checklist are SETTINGS, never fixed in this file.
 */
import { z } from "zod"
import type { MarketingPermission } from "@/lib/marketing/permissions"
import type { SellerResultStages } from "@/lib/marketing/settings-schema"

export interface Option { key: string; label: string }

export interface ActionSettings {
  stages: readonly Option[]
  reasons: readonly Option[]
  checklist: readonly string[]
  outcomeStages: { good: string; not_in_target: string; call_back: string }
  /** the stages a paid sale moves a lead to: a paid lead is not pulled out of Paid by a result */
  paidStages?: readonly string[]
  /** where the seller's results after the call put a lead */
  sellerStages?: SellerResultStages
}

const note = z.string().trim().max(2000)
export const leadActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim") }),
  z.object({ action: z.literal("release") }),
  z.object({ action: z.literal("note"), note: note.min(1) }),
  z.object({ action: z.literal("good"), ticked: z.array(z.string().max(200)).max(60).default([]), note: note.optional() }),
  z.object({ action: z.literal("not_in_target"), reason: z.string().trim().min(1).max(40), note: note.optional() }),
  z.object({ action: z.literal("call_back"), callbackAt: z.string().min(10).max(40), note: note.optional() }),
  // the seller's results after the call: not ready now (come back on a day), the sale closed, the sale not closed
  z.object({ action: z.literal("not_ready"), callbackAt: z.string().min(10).max(40), note: note.optional() }),
  z.object({ action: z.literal("closed"), note: note.optional() }),
  z.object({ action: z.literal("not_closed"), note: note.optional() }),
  // Rocco's path after the handover (27 Oct 2026): he has reached the lead; after the lead PAID he sends his booking (Calendly) link; after the consultation: upsell, waiting, or archive
  z.object({ action: z.literal("contacted"), note: note.optional() }),
  z.object({ action: z.literal("booking_link"), url: z.string().trim().max(500).refine(u => /^https:\/\/[^\s/]+\.[^\s/]+\S*$/i.test(u), "Use a link that starts with https://"), via: z.enum(["whatsapp", "email", "copied"]).default("whatsapp"), note: note.optional() }),
  z.object({ action: z.literal("upsell"), note: note.optional() }),
  z.object({ action: z.literal("waiting"), note: note.optional() }),
  z.object({ action: z.literal("archive"), note: note.optional() }),
  // reaching out (the team's sheet: "WhatsApp sent / no WhatsApp", "NR + date", the booked call)
  z.object({ action: z.literal("whatsapp"), state: z.enum(["sent", "no_wa", "opened"]), template: z.string().trim().max(60).optional(), note: note.optional() }),
  z.object({ action: z.literal("no_answer"), via: z.enum(["whatsapp", "call"]).default("call"), note: note.optional() }),
  // at = a day and time; null cancels the booked call
  z.object({ action: z.literal("appointment"), at: z.string().min(10).max(40).nullable(), note: note.optional() }),
  // move a booked call or a call back to another day or time: the reason is REQUIRED (it goes in the history and in the notification); `from` is the old time, for the history line only
  z.object({ action: z.literal("reschedule"), target: z.enum(["appointment", "callback"]), at: z.string().min(10).max(40), reason: z.string().trim().min(1).max(200), note: note.optional(), from: z.string().max(40).nullable().optional() }),
  // the setter passes an in-target lead to the seller without booking a call (the seller then fixes the call himself)
  z.object({ action: z.literal("handover"), note: note.optional() }),
])
export type LeadActionInput = z.infer<typeof leadActionSchema>

/** The permission each action needs. */
export function permissionFor(a: LeadActionInput["action"]): MarketingPermission {
  // the seller's own buttons need the seller's right to pick leads (a setter has leads.mark but not leads.pick): the screen hides them from her, and the server refuses them too
  return a === "claim" || a === "release" || SELLER_ONLY_ACTIONS.has(a) ? "leads.pick" : "leads.mark"
}
const SELLER_ONLY_ACTIONS: ReadonlySet<string> = new Set(["not_ready", "closed", "not_closed", "contacted", "booking_link", "upsell", "waiting", "archive"])

/** `callback_at` and `appointment_at` (the booked call that still stands) are only given when moving a call needs them. */
export interface LeadFacts { claimed_by: string | null; status: string; callback_at?: string | null; appointment_at?: string | null }
export interface Actor { id: string; email: string | null; role: "owner" | "member" }

export interface PlannedChange {
  /** columns to set on the lead */
  patch: Record<string, unknown>
  /** the history row to write */
  event: { kind: string; data: Record<string, unknown> }
}
export type Plan = { ok: true; change: PlannedChange } | { ok: false; status: 400 | 409; error: string }

const fail = (status: 400 | 409, error: string): Plan => ({ ok: false, status, error })
const MAX_AHEAD_MS = 180 * 24 * 3600 * 1000
const NOT_READY_MAX_AHEAD_MS = 366 * 24 * 3600 * 1000 // "not ready now" may be a year away: Rocco: "today no, maybe in six months"
const GRACE_MS = 5 * 60 * 1000

const SELLER_DEFAULTS: Required<SellerResultStages> = { not_ready: "not_ready", closed: "closed", not_closed: "not_closed", contacted: "seller_contacted", booking_link: "booking_link", upsell: "upsell", waiting: "waiting", archived: "archived" }
/** Where each seller result puts a lead: the team's setting, with the built-in key for any result a stored setting does not have yet. */
export type StageFacts = Pick<ActionSettings, "sellerStages" | "paidStages">
export const sellerOf = (s: StageFacts): Required<SellerResultStages> => ({ ...SELLER_DEFAULTS, ...(s.sellerStages ?? {}) })
/** The stages a lead is in once it has PAID (the booking link, the upsell and waiting follow): no payment link, no "link sent" and no "contacted" pulls it back. Archived is NOT one of them: a lead archived without paying can be worked again. */
const afterPaymentStages = (s: StageFacts): string[] => [...(s.paidStages ?? ["paid_call", "upsell_won"]), sellerOf(s).booking_link, sellerOf(s).upsell, sellerOf(s).waiting]
export const hasPaidOrLater = (status: string, s: StageFacts): boolean => afterPaymentStages(s).includes(status)
/** Every stage on Rocco's side of the road (contacted, link sent, not ready, not closed, the paid ones, archived): the setter's Good / Call back later do not pull such a lead back to hers. */
export const onSellerSide = (status: string, s: StageFacts): boolean => [sellerOf(s).contacted, sellerOf(s).closed, sellerOf(s).not_ready, sellerOf(s).not_closed, sellerOf(s).archived, ...afterPaymentStages(s)].includes(status)
const keyIndex = (stages: readonly Option[], k: string) => stages.findIndex(x => x.key === k)

/** "Contacted" has one meaning: the FIRST reach-out moves a brand-new lead out of the first stage (to the stage the team uses for "contacted"); a lead already further along is left where it is. */
function movedToContacted(lead: LeadFacts, s: ActionSettings): Record<string, unknown> {
  const first = s.stages[0]?.key
  const target = s.outcomeStages.call_back
  return first && lead.status === first && target && target !== first && keyIndex(s.stages, target) >= 0 ? { status: target } : {}
}

/** A booked call moves the lead to the "booked" stage when the team has one and the lead is not already there, past it, or out of target. A lead the seller put aside ("not ready now", "not closed") comes back to the booked calls when a new call is booked. */
function movedToBooked(lead: LeadFacts, s: ActionSettings): Record<string, unknown> {
  const booked = keyIndex(s.stages, "booked")
  const cur = keyIndex(s.stages, lead.status)
  if (booked < 0 || lead.status === s.outcomeStages.not_in_target) return {}
  if (lead.status === sellerOf(s).not_ready || lead.status === sellerOf(s).not_closed) return { status: "booked", callback_at: null }
  if (cur >= 0 && cur >= booked) return {}
  return { status: "booked" }
}

/** The seller's results never undo a payment: a lead that has paid stays in Paid, and pressing the result a lead already has changes nothing (a new day for "not ready now" is allowed). */
function sellerResultGuard(action: "closed" | "not_closed" | "not_ready", lead: LeadFacts, s: ActionSettings): Plan | null {
  if ((s.paidStages ?? ["paid_call", "upsell_won"]).includes(lead.status)) return fail(409, "This lead has already paid, so nothing is changed.")
  if (action !== "not_ready" && lead.status === (action === "closed" ? sellerOf(s).closed : sellerOf(s).not_closed)) return fail(409, "This lead already has this result.")
  return null
}

export function planLeadAction(input: LeadActionInput, lead: LeadFacts, actor: Actor, s: ActionSettings, now: Date): Plan {
  const mine = lead.claimed_by === actor.id
  const someoneElse = lead.claimed_by !== null && !mine
  const stageExists = (k: string) => s.stages.some(x => x.key === k)
  const nowIso = now.toISOString()

  switch (input.action) {
    case "claim":
      if (mine) return fail(409, "You already picked this lead.")
      if (someoneElse) return fail(409, "Someone else already picked this lead.")
      return { ok: true, change: {
        patch: { claimed_by: actor.id, claimed_by_label: actor.email, claimed_at: nowIso },
        event: { kind: "claimed", data: {} },
      } }

    case "release":
      if (lead.claimed_by === null) return fail(409, "Nobody has picked this lead.")
      if (someoneElse && actor.role !== "owner") return fail(409, "Only the person who picked it, or the team owner, can give it back.")
      return { ok: true, change: {
        patch: { claimed_by: null, claimed_by_label: null, claimed_at: null },
        event: { kind: "released", data: { was: lead.claimed_by } },
      } }
  }

  // Every other action: a lead someone else picked is theirs to work (the owner can always step in). Moving a call is the exception: the setter and the seller both work the same call, so either may move it.
  if (someoneElse && actor.role !== "owner" && input.action !== "reschedule") return fail(409, "Someone else picked this lead, so only they (or the team owner) can change it.")

  switch (input.action) {
    case "note":
      return { ok: true, change: { patch: {}, event: { kind: "note", data: { text: input.note } } } }

    case "good": {
      if (onSellerSide(lead.status, s)) return fail(409, "This lead has already moved on to Rocco, so nothing is changed.")
      const unknown = input.ticked.filter(t => !s.checklist.includes(t))
      if (unknown.length) return fail(400, "That checklist item does not exist any more. Reload the page.")
      const target = s.outcomeStages.good
      if (!stageExists(target)) return fail(400, "The stage for \"Good\" is not set up. Ask Antonio.")
      const qualification = s.checklist.map(item => ({ item, ticked: input.ticked.includes(item) }))
      return { ok: true, change: {
        patch: { status: target, qualification, callback_at: null, not_in_target_reason: null },
        event: { kind: "status_changed", data: { from: lead.status, to: target, outcome: "good", qualification, note: input.note ?? null } },
      } }
    }

    case "not_in_target": {
      if (!s.reasons.some(r => r.key === input.reason)) return fail(400, "Pick one of the reasons in the list.")
      const target = s.outcomeStages.not_in_target
      if (!stageExists(target)) return fail(400, "The stage for \"Not in target\" is not set up. Ask Antonio.")
      return { ok: true, change: {
        patch: { status: target, not_in_target_reason: input.reason, callback_at: null },
        event: { kind: "status_changed", data: { from: lead.status, to: target, outcome: "not_in_target", reason: input.reason, note: input.note ?? null } },
      } }
    }

    case "whatsapp": {
      return { ok: true, change: {
        patch: input.state === "opened" ? {} : movedToContacted(lead, s), // only opening WhatsApp Web is not yet a reach-out
        event: { kind: "whatsapp", data: { state: input.state, template: input.template ?? null, note: input.note ?? null } },
      } }
    }

    case "no_answer": {
      return { ok: true, change: {
        patch: movedToContacted(lead, s),
        event: { kind: "attempt", data: { result: "no_answer", via: input.via, note: input.note ?? null } },
      } }
    }

    case "appointment": {
      if (input.at === null) return { ok: true, change: { patch: {}, event: { kind: "appointment", data: { at: null, note: input.note ?? null } } } }
      const at = new Date(input.at)
      if (Number.isNaN(at.getTime())) return fail(400, "Pick a valid day and time.")
      if (at.getTime() < now.getTime() - GRACE_MS) return fail(400, "That time has already passed. Pick a day and time in the future.")
      if (at.getTime() > now.getTime() + MAX_AHEAD_MS) return fail(400, "That is too far away. Pick a day within the next six months.")
      return { ok: true, change: {
        patch: movedToBooked(lead, s),
        event: { kind: "appointment", data: { at: at.toISOString(), note: input.note ?? null } },
      } }
    }

    case "reschedule": {
      // a full day AND time (a bare date would silently become midnight UTC)
      if (!/T\d{2}:\d{2}/.test(input.at)) return fail(400, "Pick a valid day and time.")
      const at = new Date(input.at)
      if (Number.isNaN(at.getTime())) return fail(400, "Pick a valid day and time.")
      if (at.getTime() < now.getTime() - GRACE_MS) return fail(400, "That time has already passed. Pick a day and time in the future.")
      const farOk = input.target === "callback" && lead.status === sellerOf(s).not_ready ? NOT_READY_MAX_AHEAD_MS : MAX_AHEAD_MS // a "not ready now" day was allowed up to a year, so it can be moved up to a year
      if (at.getTime() > now.getTime() + farOk) return fail(400, farOk === NOT_READY_MAX_AHEAD_MS ? "That is too far away. Pick a day within the next year." : "That is too far away. Pick a day within the next six months.")
      if (input.reason === "Other" && !input.note) return fail(400, "Tell us why: write a few words.")
      const from = typeof input.from === "string" && !Number.isNaN(Date.parse(input.from)) ? new Date(input.from).toISOString() : null
      // only a call that STILL STANDS can be moved: a stale page must never bring back a cancelled booking or reopen a lead that has moved on
      const stale = "This call was changed by someone else. Reload the calendar and try again."
      const differs = (stored: string) => from !== null && Math.abs(Date.parse(stored) - Date.parse(from)) > 60_000
      const moved = { note: input.note ?? null, reason: input.reason, rescheduled: true }
      if (input.target === "appointment") {
        if (!lead.appointment_at) return fail(409, "This call is no longer booked. Reload the calendar.")
        if (Date.parse(lead.appointment_at) < now.getTime() - GRACE_MS) return fail(409, "This call has already taken place. Book a new one from the lead.")
        if (differs(lead.appointment_at)) return fail(409, stale)
        return { ok: true, change: { patch: movedToBooked(lead, s), event: { kind: "appointment", data: { at: at.toISOString(), from, ...moved } } } }
      }
      // a call back still stands only while the lead is at the call back stage with its time set; the stage itself is never touched
      if (!lead.callback_at || (lead.status !== s.outcomeStages.call_back && lead.status !== sellerOf(s).not_ready)) return fail(409, "This call back is no longer on this lead. Reload the calendar.")
      if (differs(lead.callback_at)) return fail(409, stale)
      return { ok: true, change: { patch: { callback_at: at.toISOString() }, event: { kind: "callback_moved", data: { callback_at: at.toISOString(), from, ...moved } } } }
    }

    case "handover": {
      // passing a lead on means it is in target: a lead still before the "Good" stage is moved there (one that is further along, or out of target, stays)
      const good = s.outcomeStages.good
      const cur = keyIndex(s.stages, lead.status)
      const target = keyIndex(s.stages, good)
      if (lead.status === s.outcomeStages.not_in_target) return fail(409, "This lead is marked Not in target. Change that first if you want to pass it on.")
      const patch: Record<string, unknown> = target >= 0 && cur >= 0 && cur < target ? { status: good, callback_at: null, not_in_target_reason: null } : {}
      return { ok: true, change: { patch, event: { kind: "handover", data: { note: input.note ?? null, from: lead.status, to: typeof patch.status === "string" ? patch.status : lead.status } } } }
    }

    case "closed":
    case "not_closed": {
      const refused = sellerResultGuard(input.action, lead, s)
      if (refused) return refused
      const target = input.action === "closed" ? sellerOf(s).closed : sellerOf(s).not_closed
      if (!stageExists(target)) return fail(400, `The stage for "${input.action === "closed" ? "Link sent" : "Not closed"}" is not set up. Ask Antonio.`)
      return { ok: true, change: {
        patch: { status: target, callback_at: null, not_in_target_reason: null },
        event: { kind: "status_changed", data: { from: lead.status, to: target, outcome: input.action, note: input.note ?? null } },
      } }
    }

    case "contacted": {
      if (lead.status === s.outcomeStages.not_in_target) return fail(409, "This lead is marked Not in target. Change that first if you want to mark it Contacted.")
      if (hasPaidOrLater(lead.status, s)) return fail(409, "This lead has already paid, so nothing is changed.")
      const target = sellerOf(s).contacted
      if (lead.status === target) return fail(409, "This lead already has this result.")
      if (!stageExists(target)) return fail(400, "The stage for \"Contacted\" is not set up. Ask Antonio.")
      return { ok: true, change: {
        patch: { status: target, callback_at: null, not_in_target_reason: null },
        event: { kind: "status_changed", data: { from: lead.status, to: target, outcome: "contacted", note: input.note ?? null } },
      } }
    }

    case "booking_link": {
      // only after the lead has PAID: the link is what Rocco sends once the payment is in
      if (!hasPaidOrLater(lead.status, s)) return fail(409, "Send the booking link after the lead has paid.")
      const target = sellerOf(s).booking_link
      // a lead that has just paid moves to "Booking link sent"; one that is already further along (upsell, waiting) stays where it is, the link is only written in the history
      const moves = (s.paidStages ?? ["paid_call", "upsell_won"]).includes(lead.status) && stageExists(target)
      return { ok: true, change: {
        patch: moves ? { status: target, callback_at: null } : {},
        event: { kind: "booking_link", data: { url: input.url, via: input.via, from: lead.status, to: moves ? target : lead.status, note: input.note ?? null } },
      } }
    }

    case "upsell":
    case "waiting":
    case "archive": {
      const target = input.action === "upsell" ? sellerOf(s).upsell : input.action === "waiting" ? sellerOf(s).waiting : sellerOf(s).archived
      const word = input.action === "upsell" ? "Upsell" : input.action === "waiting" ? "Waiting" : "Archived"
      // upsell and waiting are what follows a consultation: only a lead that has paid
      if (input.action !== "archive" && !hasPaidOrLater(lead.status, s)) return fail(409, `Only a lead that has paid can go to ${word}.`)
      if (lead.status === target) return fail(409, "This lead already has this result.")
      if (!stageExists(target)) return fail(400, `The stage for "${word}" is not set up. Ask Antonio.`)
      return { ok: true, change: {
        patch: { status: target, callback_at: null },
        event: { kind: "status_changed", data: { from: lead.status, to: target, outcome: input.action, note: input.note ?? null } },
      } }
    }

    case "not_ready":
    case "call_back": {
      if (input.action === "call_back" && onSellerSide(lead.status, s)) return fail(409, "This lead has already moved on to Rocco, so nothing is changed.")
      if (input.action === "not_ready") { const refused = sellerResultGuard("not_ready", lead, s); if (refused) return refused }
      const at = new Date(input.callbackAt)
      if (Number.isNaN(at.getTime())) return fail(400, "Pick a valid day and time.")
      if (at.getTime() < now.getTime() - GRACE_MS) return fail(400, "That time has already passed. Pick a day and time in the future.")
      if (at.getTime() > now.getTime() + (input.action === "not_ready" ? NOT_READY_MAX_AHEAD_MS : MAX_AHEAD_MS)) return fail(400, input.action === "not_ready" ? "That is too far away. Pick a day within the next year." : "That is too far away. Pick a day within the next six months.")
      const target = input.action === "not_ready" ? sellerOf(s).not_ready : s.outcomeStages.call_back
      if (!stageExists(target)) return fail(400, `The stage for "${input.action === "not_ready" ? "Not ready now" : "Call back later"}" is not set up. Ask Antonio.`)
      return { ok: true, change: {
        patch: { status: target, callback_at: at.toISOString(), not_in_target_reason: null },
        event: { kind: "status_changed", data: { from: lead.status, to: target, outcome: input.action, callback_at: at.toISOString(), note: input.note ?? null } },
      } }
    }
  }
}
