/**
 * What a team member may do with a lead (pure; TD Marketing, dev job 9aec66fa, Slice 2a). Decides, from the lead as it is NOW, who is
 * acting and the team's settings, whether the action is allowed and exactly what to write. No database here: `lead-actions-server.ts`
 * loads the facts, calls this, and writes the result. Stage names, reasons and the checklist are SETTINGS, never fixed in this file.
 */
import { z } from "zod"
import type { MarketingPermission } from "@/lib/marketing/permissions"

export interface Option { key: string; label: string }

export interface ActionSettings {
  stages: readonly Option[]
  reasons: readonly Option[]
  checklist: readonly string[]
  outcomeStages: { good: string; not_in_target: string; call_back: string }
}

const note = z.string().trim().max(2000)
export const leadActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim") }),
  z.object({ action: z.literal("release") }),
  z.object({ action: z.literal("note"), note: note.min(1) }),
  z.object({ action: z.literal("good"), ticked: z.array(z.string().max(200)).max(60).default([]), note: note.optional() }),
  z.object({ action: z.literal("not_in_target"), reason: z.string().trim().min(1).max(40), note: note.optional() }),
  z.object({ action: z.literal("call_back"), callbackAt: z.string().min(10).max(40), note: note.optional() }),
])
export type LeadActionInput = z.infer<typeof leadActionSchema>

/** The permission each action needs. */
export function permissionFor(a: LeadActionInput["action"]): MarketingPermission {
  return a === "claim" || a === "release" ? "leads.pick" : "leads.mark"
}

export interface LeadFacts { claimed_by: string | null; status: string }
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
const GRACE_MS = 5 * 60 * 1000

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

  // Every other action: a lead someone else picked is theirs to work (the owner can always step in).
  if (someoneElse && actor.role !== "owner") return fail(409, "Someone else picked this lead, so only they (or the team owner) can change it.")

  switch (input.action) {
    case "note":
      return { ok: true, change: { patch: {}, event: { kind: "note", data: { text: input.note } } } }

    case "good": {
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

    case "call_back": {
      const at = new Date(input.callbackAt)
      if (Number.isNaN(at.getTime())) return fail(400, "Pick a valid day and time.")
      if (at.getTime() < now.getTime() - GRACE_MS) return fail(400, "That time has already passed. Pick a day and time in the future.")
      if (at.getTime() > now.getTime() + MAX_AHEAD_MS) return fail(400, "That is too far away. Pick a day within the next six months.")
      const target = s.outcomeStages.call_back
      if (!stageExists(target)) return fail(400, "The stage for \"Call back later\" is not set up. Ask Antonio.")
      return { ok: true, change: {
        patch: { status: target, callback_at: at.toISOString(), not_in_target_reason: null },
        event: { kind: "status_changed", data: { from: lead.status, to: target, outcome: "call_back", callback_at: at.toISOString(), note: input.note ?? null } },
      } }
    }
  }
}
