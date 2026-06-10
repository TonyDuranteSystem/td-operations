import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Find an existing contact by email — CASE-INSENSITIVELY and alias-aware — so the
 * activation / portal-creation flow REUSES the real person instead of spawning a
 * duplicate contact (and a duplicate portal login) when an offer or lead carries
 * a differently-cased or post-merge-alias email.
 *
 * This was the duplicate-identity footgun behind Michele Cotti's orphan contact
 * (2026-06-10): `lib/portal/auto-create.ts` resolved contacts with exact
 * `.eq('email', …)`, so any case variant created a brand-new contact + auth user.
 *
 * Matching:
 *   1. primary `contacts.email`, case-insensitively. PostgREST `ilike` treats
 *      `_` (common in local-parts, e.g. `cotti_michele@…`) as a wildcard, so we
 *      narrow with ilike then compare EXACTLY (lowercased) in JS to avoid
 *      over-matching.
 *   2. folded `alt_emails` (written lowercased by the merge_contacts() DB
 *      function) so a merged person is still found by an old address.
 *
 * Merged tombstones (`merged_into IS NOT NULL`) are never returned. On ties the
 * oldest contact wins (the canonical record).
 */
export async function findContactIdByEmail(
  email: string | null | undefined,
): Promise<string | null> {
  const e = (email ?? "").trim()
  if (!e) return null
  const lower = e.toLowerCase()

  const { data: byEmail } = await supabaseAdmin
    .from("contacts")
    .select("id, email, created_at")
    .is("merged_into", null)
    .ilike("email", e)
    .order("created_at", { ascending: true })
    .limit(25)
  const exact = (byEmail ?? []).find((c) => (c.email ?? "").toLowerCase() === lower)
  if (exact) return exact.id

  const { data: byAlt } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .is("merged_into", null)
    .contains("alt_emails", [lower])
    .order("created_at", { ascending: true })
    .limit(1)
  return byAlt?.[0]?.id ?? null
}
