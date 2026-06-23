import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/database.types"

export interface PaymentRecipient {
  email: string
  name: string
  /** Resolved contact's language ("en"/"it"); null when resolved via
   *  account.communication_email (no contact). Callers default to "en". */
  language: string | null
}

/**
 * Resolve the email recipient for a payment.
 *
 * This is the SINGLE source of truth for "who does an invoice email go to".
 * Every invoice-send path (CRM resend route, sendTDInvoice, sendPaidReceipt,
 * pay-link, checkout) MUST go through here — never hand-roll an
 * `account_contacts` role lookup, and NEVER use an exact-case `role = 'Owner'`
 * match (roles are stored inconsistently, e.g. lowercase "owner"; the brittle
 * match silently resolves zero rows and breaks resend — the ADWise incident,
 * 2026-06-18).
 *
 * Priority:
 *   1. payment.contact_id  → contacts.email                    (direct — always safe)
 *   2. payment.account_id  → owner-role contact (CASE-INSENSITIVE), else any
 *                            linked contact with an email
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
      .select("email, full_name, language")
      .eq("id", payment.contact_id)
      .single()
    if (data?.email) return { email: data.email, name: data.full_name ?? "Client", language: data.language ?? null }
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
      .select("role, contacts(email, full_name, language)")
      .eq("account_id", payment.account_id)
      .limit(10),
  ])

  const accountName = accountRes.data?.company_name ?? "Client"

  // Path 2 — prefer the owner-role contact (case-insensitive: "Owner",
  // "owner", "Co-Owner" all qualify), then fall back to any linked contact
  // that has an email. Carries the role so we can rank.
  const links = (contactsRes.data ?? [])
    .map((row) => ({
      role: (row as { role: string | null }).role ?? null,
      contact: row.contacts as { email: string | null; full_name: string | null; language: string | null } | null,
    }))
    .filter(
      (l): l is { role: string | null; contact: { email: string; full_name: string | null; language: string | null } } =>
        !!l.contact?.email,
    )

  if (links.length > 0) {
    const owner = links.find((l) => l.role?.toLowerCase().includes("owner"))
    const chosen = owner ?? links[0]
    return { email: chosen.contact.email, name: chosen.contact.full_name ?? accountName, language: chosen.contact.language ?? null }
  }

  // Path 3 — account-level communication email (no contact → no language)
  if (accountRes.data?.communication_email) {
    return { email: accountRes.data.communication_email, name: accountName, language: null }
  }

  return null
}
