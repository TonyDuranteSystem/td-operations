/**
 * Canonical "find an existing contact by email" used by every find-or-create
 * site (forms, formation/onboarding materialize, SS-4 provisioning). Matches:
 *   1. the primary email (case-insensitive), then
 *   2. a secondary "also-known-as" email in contacts.alt_emails (lowercased).
 * Always excludes merged-away contacts (merged_into IS NOT NULL) — a merged row
 * has its email blanked anyway, but we filter defensively.
 *
 * alt_emails are ONLY ever set by a deliberate contact merge (never free-typed),
 * so secondary matching can't silently glue two different people together.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** Normalize an email for matching: trim + lowercase. Returns null when empty. */
export function normalizeEmailForMatch(email: string | null | undefined): string | null {
  if (!email) return null
  const e = email.trim().toLowerCase()
  return e === "" ? null : e
}

/** Find a non-merged contact by primary email, then by also-known-as email.
 *  Returns the contact id or null. */
export async function findContactByEmail(
  email: string | null | undefined,
): Promise<{ id: string } | null> {
  const normalized = normalizeEmailForMatch(email)
  if (!normalized) return null

  // 1) Primary email — case-insensitive exact (ilike with no wildcards), non-merged.
  const { data: primary } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .is("merged_into", null)
    .ilike("email", normalized)
    .limit(1)
    .maybeSingle()
  if (primary) return { id: primary.id as string }

  // 2) Also-known-as — alt_emails stored lowercased; array-contains match, non-merged.
  const { data: alt } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .is("merged_into", null)
    .contains("alt_emails", [normalized])
    .limit(1)
    .maybeSingle()
  if (alt) return { id: alt.id as string }

  return null
}
