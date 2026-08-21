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
import { matchContactByName, normalizeEmail, escapeLikePattern } from '@/lib/members/member-identity'

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
  // Escaped + re-verified by exact equality below — an unescaped `_`/`%` in a
  // real email (e.g. "jane_doe@gmail.com") would otherwise be read as a LIKE
  // wildcard and could over-match an unrelated contact (found in a council
  // review, 2026-08-19, dev_task 693273fd, tracing a real misattribution
  // scenario through this exact query).
  const { data: sameEmailCandidates } = await supabaseAdmin
    .from('contacts')
    .select('id, full_name, email')
    .ilike('email', `%${escapeLikePattern(email)}%`)
    .is('merged_into', null)
  const sameEmailContacts = (sameEmailCandidates || []).filter(
    (c) => (c.email || '').trim().toLowerCase() === email
  )

  const matchedId = matchContactByName(sameEmailContacts, name)

  if (matchedId) {
    // Refresh only fields that are currently BLANK on the matched contact —
    // never overwrite real data with whatever this caller happens to submit.
    // (The comment above always claimed this; the code never actually
    // checked the existing value until this fix — same council review.)
    if (input.refresh) {
      const { data: existing, error: existingErr } = await supabaseAdmin
        .from('contacts')
        .select(Object.keys(input.refresh).join(', ') || 'id')
        .eq('id', matchedId)
        .maybeSingle()
      if (existingErr) {
        console.error(`[resolveMemberContactId] existing-value read failed for ${matchedId}, skipping refresh:`, existingErr.message)
      }
      // A failed or missing read must NOT be treated as "everything is
      // blank" — that would silently overwrite real data on a transient
      // failure, the exact bug class this refresh logic was fixed for
      // (Senior Engineer review, 2026-08-19, dev_task 693273fd).
      if (existing) {
        const updates: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(input.refresh)) {
          const incomingVal = typeof v === 'string' ? v.trim() : v
          const hasValue = incomingVal !== null && incomingVal !== undefined && incomingVal !== ''
          const existingRaw = existing[k as keyof typeof existing]
          // Trim before judging blankness — a whitespace-only existing value
          // must count as blank too (Bug Hunter review, same pass).
          const existingVal = typeof existingRaw === 'string' ? existingRaw.trim() : existingRaw
          const existingIsBlank = existingVal === null || existingVal === undefined || existingVal === ''
          if (hasValue && existingIsBlank) updates[k] = incomingVal
        }
        if (Object.keys(updates).length > 0) {
          updates.updated_at = input.now
          // eslint-disable-next-line no-restricted-syntax -- shared member provisioning; deferred migration per dev_task 7ebb1e0c
          await supabaseAdmin.from('contacts').update(updates).eq('id', matchedId)
        }
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
