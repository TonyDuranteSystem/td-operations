/**
 * resolveMemberContactId — the single find-or-create-contact procedure shared by
 * every surface that materializes LLC members (the member-info form route and the
 * onboarding setup job). Centralizing it prevents the two surfaces from drifting
 * apart (they previously each had their own copy with different write semantics).
 *
 * Identity rule (see lib/members/member-identity.ts): a member is matched to a
 * contact by EMAIL + NORMALIZED NAME, never email alone. Two members can share
 * one email (a family LLC) and must stay distinct people. So we fetch EVERY
 * contact on the email and pick the one whose name matches; only if none matches
 * do we create a new contact — biased toward keeping distinct people distinct.
 *
 * Email match is case-insensitive (contacts.email is stored as entered).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { matchContactByName, normalizeEmail } from '@/lib/members/member-identity'

export interface ResolveMemberContactInput {
  /** The member's email (individual member's email, or a company rep's email). */
  email: string | null | undefined
  /** The member's full name used for identity matching. */
  name: string | null | undefined
  /** Optional split-name fields written only when creating a NEW contact. */
  first_name?: string | null
  last_name?: string | null
  /**
   * Fields to refresh on an EXISTING matched contact (address, dob, citizenship,
   * phone…). Only keys with truthy values are written, so we never blank good
   * data. `updated_at` is added automatically. Ignored when a contact is created.
   */
  refresh?: Record<string, unknown>
  /** ISO timestamp to stamp created_at/updated_at with. */
  now: string
}

/**
 * Returns the contact id for this member, reusing the correct existing contact
 * or creating a new one. Returns null only when there is no email (the caller
 * then records the member with a null contact_id, which is unconstrained) or
 * when contact creation fails.
 */
export async function resolveMemberContactId(input: ResolveMemberContactInput): Promise<string | null> {
  const email = normalizeEmail(input.email)
  const name = (input.name || '').trim()
  if (!email) return null

  // Fetch ALL contacts on this email (case-insensitive), then match by name.
  const { data: sameEmailContacts } = await supabaseAdmin
    .from('contacts')
    .select('id, full_name')
    .ilike('email', email)

  const matchedId = matchContactByName(sameEmailContacts || [], name)

  if (matchedId) {
    // Refresh only the fields the caller actually provided.
    if (input.refresh) {
      const updates: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input.refresh)) {
        if (v !== null && v !== undefined && v !== '') updates[k] = v
      }
      if (Object.keys(updates).length > 0) {
        updates.updated_at = input.now
        // eslint-disable-next-line no-restricted-syntax -- shared member provisioning; deferred migration per dev_task 7ebb1e0c
        await supabaseAdmin.from('contacts').update(updates).eq('id', matchedId)
      }
    }
    return matchedId
  }

  // No name match on this email → create a distinct new contact.
  // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-explicit-any -- shared member provisioning; deferred migration per dev_task 7ebb1e0c
  const { data: created, error: createErr } = await supabaseAdmin
    .from('contacts')
    .insert({
      email,
      full_name: name || email,
      ...(input.first_name ? { first_name: input.first_name } : {}),
      ...(input.last_name ? { last_name: input.last_name } : {}),
      ...(input.refresh || {}),
      created_at: input.now,
      updated_at: input.now,
    } as any)
    .select('id')
    .single()

  if (createErr || !created) {
    console.error(`[resolveMemberContactId] contact create failed for ${email}:`, createErr?.message)
    return null
  }
  return created.id
}
