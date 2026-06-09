import type { SupabaseClient } from "@supabase/supabase-js"
// Slice 0 (2026-06-09): augmented Database so the augmented supabaseAdmin is an accepted
// argument. Revert to "@/lib/database.types" after Phase 2 regen.
import type { Database } from "@/lib/database.types.augmented"

export interface PaymentRecipient {
  email: string
  name: string
}

/**
 * Resolve the email recipient for a payment.
 *
 * Priority:
 *   1. payment.contact_id  → contacts.email          (direct — always safe)
 *   2. payment.account_id  → any linked contact with an email (no role filter)
 *   3. account.communication_email
 *
 * Returns null if no email can be found.
 */
export async function resolvePaymentRecipient(
  payment: { contact_id: string | null; account_id: string | null },
  supabase: SupabaseClient<Database>,
): Promise<PaymentRecipient | null> {
  // Path 1 — direct contact on the payment (most reliable)
  if (payment.contact_id) {
    const { data } = await supabase
      .from("contacts")
      .select("email, full_name")
      .eq("id", payment.contact_id)
      .single()
    if (data?.email) return { email: data.email, name: data.full_name ?? "Client" }
  }

  if (!payment.account_id) return null

  // Fetch account name + communication_email in parallel with contacts lookup
  const [accountRes, contactsRes] = await Promise.all([
    supabase
      .from("accounts")
      .select("company_name, communication_email")
      .eq("id", payment.account_id)
      .single(),
    supabase
      .from("account_contacts")
      .select("contacts(email, full_name)")
      .eq("account_id", payment.account_id)
      .limit(10),
  ])

  const accountName = accountRes.data?.company_name ?? "Client"

  // Path 2 — any linked contact with an email (no role filter, no case sensitivity)
  const contacts = (contactsRes.data ?? [])
    .map((row) => (row.contacts as { email: string | null; full_name: string | null } | null))
    .filter((c): c is { email: string; full_name: string | null } => !!c?.email)

  if (contacts.length > 0) {
    return { email: contacts[0].email, name: accountName }
  }

  // Path 3 — account-level communication email
  if (accountRes.data?.communication_email) {
    return { email: accountRes.data.communication_email, name: accountName }
  }

  return null
}
