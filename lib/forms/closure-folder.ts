/**
 * Resolve WHERE a closure package files in Drive (2026-07-26).
 *
 * Replicates the closure completion route's EXISTING target — made reliable, not
 * changed:
 *  - Account linked with a Drive folder → the company folder (the company being
 *    closed). Its account is NOT inferred from a contact link (a person may own
 *    several companies; only an explicit account_id names THE one being closed).
 *  - Otherwise → a deterministic closure folder under Leads, named
 *    "{client} - {llc} (Closure)". Stable, so the inline save, the durable job,
 *    and the sweep all resolve the SAME folder with no stored state.
 *
 * THROWS on a folder read error (retryable) and on an ambiguous duplicate.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** TD Clients root (Shared Drive). Overridable via env ONLY so the isolated
 *  sandbox test drive can point the Leads fallback at a test folder; production
 *  leaves it unset and uses the real root. */
const TD_CLIENTS_ROOT = process.env.TD_CLIENTS_ROOT_ID || "1mbz_bUDwC4K259RcC-tDKihjlvdAVXno"

interface DriveItem { id: string; name: string; mimeType: string }
const FOLDER_MIME = "application/vnd.google-apps.folder"

async function findOrCreateChildFolder(parentId: string, name: string): Promise<string> {
  const { listFolder, createFolder } = await import("@/lib/google-drive")
  const res = (await listFolder(parentId, 200)) as { files?: DriveItem[] }
  const matches = (res.files ?? []).filter(f => f.name === name && f.mimeType === FOLDER_MIME)
  if (matches.length === 1) return matches[0].id
  if (matches.length > 1) {
    throw new Error(`closure folder: multiple folders named "${name}" under ${parentId} (${matches.map(m => m.id).join(", ")}) — needs manual resolution`)
  }
  const created = (await createFolder(parentId, name)) as { id: string }
  return created.id
}

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
  clientName: string
  llcName: string
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
    // Account linked but no Drive folder yet → fall through to the closure folder.
  }

  // Deterministic closure folder under Leads (the route's existing fallback).
  const leadsId = await findOrCreateChildFolder(TD_CLIENTS_ROOT, "Leads")
  const folderName = `${params.clientName} - ${params.llcName} (Closure)`
  return findOrCreateChildFolder(leadsId, folderName)
}
