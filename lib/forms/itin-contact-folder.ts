/**
 * Resolve WHERE an ITIN package files (2026-07-25; Stop-Drive S1a 2026-10-18).
 *
 * Antonio's rule: ITIN belongs to the PERSON, never the company's main area — and (2026-10-18) nothing new is created in Google Drive.
 * The package goes to the PERSON'S OWN STORAGE (their ITIN folder, else Personal documents): the destination is the marker
 * "person-storage:<contactId>", opened on first use exactly as for any new client. The old Drive folders ("2. Contacts" of the
 * company, "Individual Clients/<name> (<id>)") are no longer created or written; with no contact there is nowhere to file, so it
 * THROWS (loud + retryable: the sweep alerts) — it never falls back to Drive and never guesses a person.
 * Shared by the ITIN completion route (inline save + document generation) AND the durable archive recipe.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** The person's display name for an ITIN submission — lead first, then contact,
 *  else the token. ONE function so the completion route's inline save and the
 *  durable recipe always resolve the SAME name (→ the same folder). */
export async function resolveItinClientName(params: {
  leadId: string | null
  contactId: string | null
  token: string | null
}): Promise<string> {
  if (params.leadId) {
    const { data } = await supabaseAdmin.from("leads").select("full_name").eq("id", params.leadId).maybeSingle()
    if (data?.full_name) return data.full_name
  }
  if (params.contactId) {
    const { data } = await supabaseAdmin.from("contacts").select("full_name").eq("id", params.contactId).maybeSingle()
    if (data?.full_name) return data.full_name
  }
  return String(params.token ?? "")
}


/**
 * The ITIN package's destination: the person's storage marker. THROWS when there is no contact to file under, or when the person's
 * only storage is a hidden study copy (held, alarmed, retried).
 */
export async function resolveItinContactFolder(params: {
  accountId: string | null
  contactId: string | null
  leadId?: string | null
  token?: string | null
  clientName: string
}): Promise<string> {
  if (!params.contactId) throw new Error("itin folder: no contact record to file this ITIN package under — needs a contact first")
  const { storageDestinationForForm } = await import("@/lib/crm-store/lead-form-store")
  const dest = await storageDestinationForForm({ contactId: params.contactId, personName: params.clientName })
  if (!dest.marker) throw new Error("itin folder: this person only has a hidden study-copy storage — the ITIN package was not filed; staff decide where it goes")
  return dest.marker
}
