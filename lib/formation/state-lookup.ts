/**
 * Server-side formation-state lookups (WS-B, dev job c0a61e44).
 *
 * Kept separate from lib/formation/states.ts on purpose: states.ts is pure and
 * client-safe (the Create Offer dialog imports it); this file touches the
 * database and must never reach a client bundle.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { normalizeFormationState, type FormationStateCode } from "./states"

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

  const { data } = await supabaseAdmin
    .from("offers")
    .select("formation_state, created_at")
    .in("status", ["signed", "completed"])
    .not("formation_state", "is", null)
    .or(ors.join(","))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return normalizeFormationState(
    (data as { formation_state?: string | null } | null)?.formation_state,
  )
}
