/**
 * Server-side formation-state lookups (WS-B, dev job c0a61e44).
 *
 * Kept separate from lib/formation/states.ts on purpose: states.ts is pure and
 * client-safe (the Create Offer dialog imports it); this file touches the
 * database and must never reach a client bundle.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { FORMATION_STATE_CODES, normalizeFormationState, type FormationStateCode } from "./states"

/**
 * The pinned formation state from the client's newest SIGNED/COMPLETED offer,
 * or null when no signed offer carries one. Signed-only on purpose: the pinned
 * state is a contract fact — a draft's state is not authoritative.
 *
 * Accepts a lead id and/or contact id; when only the contact is known, offers
 * hung on the pre-conversion lead are found via leads.converted_to_contact_id.
 */
export async function formationStateForClient(opts: {
  leadId?: string | null
  contactId?: string | null
}): Promise<FormationStateCode | null> {
  const leadIds: string[] = []
  if (opts.leadId) leadIds.push(opts.leadId)

  if (!opts.leadId && opts.contactId) {
    const { data: leads } = await supabaseAdmin
      .from("leads")
      .select("id")
      .eq("converted_to_contact_id", opts.contactId)
    for (const l of leads ?? []) leadIds.push((l as { id: string }).id)
  }

  const ors: string[] = []
  if (opts.contactId) ors.push(`contact_id.eq.${opts.contactId}`)
  if (leadIds.length) ors.push(`lead_id.in.(${leadIds.join(",")})`)
  if (!ors.length) return null

  // The doubled .in() filter pushes supabase-js generic inference past TS's
  // instantiation-depth limit (TS2589, broke the next build). Query on an
  // untyped handle — the result row is cast on read regardless (the column is
  // newer than the generated types).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate: breaks TS2589 on the doubled .in(); column newer than generated types
  const untyped = supabaseAdmin as unknown as { from: (t: string) => any }
  const { data, error } = await untyped
    .from("offers")
    .select("formation_state, created_at")
    .in("status", ["signed", "completed"])
    // Formation deals only — a state that leaked onto a non-formation offer must
    // never become a client's formation default (adversarial QA finding 7a).
    .eq("contract_type", "formation")
    // Valid codes only, filtered in the QUERY: a junk value on the newest signed
    // offer must not mask an older valid one behind limit(1) (finding 7c).
    .in("formation_state", [...FORMATION_STATE_CODES])
    .or(ors.join(","))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // A query failure must be visible, not silently identical to "no state"
  // (finding 5 — the fallback target is a legal filing state).
  if (error) {
    console.error("[formationStateForClient] offers lookup failed:", error.message)
  }

  return normalizeFormationState(
    (data as { formation_state?: string | null } | null)?.formation_state,
  )
}
