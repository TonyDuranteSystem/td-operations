/**
 * Resolve WHERE a closure package files (2026-07-26; Stop-Drive S1a 2026-10-18).
 *
 *  - Account linked with a Drive folder → the company folder (the company being
 *    closed; saveFormToDrive redirects a switched one into its storage). Its account
 *    is NOT inferred from a contact link (a person may own several companies; only an
 *    explicit account_id names THE one being closed).
 *  - Otherwise → the client's STORAGE: the company's when the account already has
 *    one, else the person's. The old "{client} - {llc} (Closure)" folder under Leads
 *    in Google Drive is gone — no Drive folder is created any more.
 *
 * THROWS on a read error (retryable) and when there is no company storage and no
 * contact record to file under (loud, so the sweep alerts — never a silent skip).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** The person's name for a closure — from the submitted data, else the lead /
 *  contact, else the token. Mirrors the completion route exactly so the inline
 *  save and the durable recipe resolve the SAME closure folder. */
export async function resolveClosureClientName(params: {
  submittedData: Record<string, unknown>
  leadId: string | null
  contactId: string | null
  token: string | null
}): Promise<string> {
  const d = params.submittedData
  let clientName = String((d.owner_name as string) || (d.owner_first_name as string) || "")
  if (d.owner_last_name) clientName += ` ${String(d.owner_last_name)}`
  if (!clientName.trim()) {
    if (params.leadId) {
      const { data: lead } = await supabaseAdmin.from("leads").select("full_name").eq("id", params.leadId).maybeSingle()
      clientName = lead?.full_name || ""
    } else if (params.contactId) {
      const { data: contact } = await supabaseAdmin.from("contacts").select("full_name").eq("id", params.contactId).maybeSingle()
      clientName = contact?.full_name || ""
    }
  }
  return clientName.trim() || String(params.token ?? "")
}

export async function resolveClosureFolder(params: {
  accountId: string | null
  contactId: string | null
  clientName: string
}): Promise<string> {
  // Account explicitly linked → the company being closed. Read error → retry.
  if (params.accountId) {
    const { data: acc, error } = await supabaseAdmin
      .from("accounts")
      .select("drive_folder_id")
      .eq("id", params.accountId)
      .maybeSingle()
    if (error) throw new Error(`closure folder: account read failed (retryable): ${error.message}`)
    if (acc?.drive_folder_id) return acc.drive_folder_id
  }

  const { storageDestinationForForm } = await import("@/lib/crm-store/lead-form-store")
  const dest = await storageDestinationForForm({ accountId: params.accountId, contactId: params.contactId, personName: params.clientName })
  if (!dest.marker) {
    throw new Error(
      dest.reason === "no_contact"
        ? "closure folder: no company storage and no contact record to file this closure under — needs a contact or company first"
        : "closure folder: this person still lives on Drive (no storage opened) — the closure package was not filed; staff decide where it goes",
    )
  }
  return dest.marker
}
