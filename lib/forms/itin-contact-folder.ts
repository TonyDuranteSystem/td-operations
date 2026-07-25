/**
 * Resolve WHERE an ITIN package files in Drive (2026-07-25).
 *
 * Antonio's rule: ITIN belongs to the PERSON, never the company's main area.
 *  - Company-owner (the person's contact has a linked account with a Drive
 *    folder) → the company's "2. Contacts" subfolder.
 *  - Individual (no company) → a per-person folder under "Individual Clients".
 *
 * This corrects the old ITIN behaviour, which filed a company-owner's ITIN into
 * the company's MAIN folder and an individual's into a Leads folder. Shared by
 * the ITIN completion route (inline save + downstream doc generation) AND the
 * durable archive recipe, so both resolve the SAME folder.
 *
 * SAFETY (bug-hunter, 2026-07-25):
 *  - The individual folder is keyed to the PERSON, not just their name: two
 *    different people with the same legal name must NEVER share a folder (their
 *    W-7 / passport PDFs would overwrite each other — cross-client exposure). A
 *    contact's folder id is persisted so a resubmit reuses it; a name collision
 *    with someone else disambiguates with a short identity suffix.
 *  - A company-owner whose account has NO Drive folder yet THROWS (retryable +
 *    loud) rather than misfiling into Individual Clients — the durable job waits
 *    for the folder, and the sweep alerts if it never appears.
 *  - Folder reads throw (retryable); an ambiguous duplicate throws (needs human).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** "Individual Clients" root under TD Clients (verified prod Drive, 2026-07-25).
 *  Overridable via env ONLY so the isolated sandbox test drive can point it at a
 *  test folder; production leaves it unset and uses the real folder id. */
export const INDIVIDUAL_CLIENTS_ROOT =
  process.env.INDIVIDUAL_CLIENTS_ROOT_ID || "1P7omomS8yBb8vkSmirwTj1AdcSXDraqv"
/** The contact subfolder inside every standard company folder. */
export const COMPANY_CONTACTS_SUBFOLDER = "2. Contacts"

interface DriveItem { id: string; name: string; mimeType: string }
const FOLDER_MIME = "application/vnd.google-apps.folder"

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

async function listChildFolders(parentId: string): Promise<DriveItem[]> {
  const { listFolder } = await import("@/lib/google-drive")
  const res = (await listFolder(parentId, 200)) as { files?: DriveItem[] }
  return (res.files ?? []).filter(f => f.mimeType === FOLDER_MIME)
}

/** Find a child folder by exact name, or create it. Throws on multiple matches. */
async function findOrCreateChildFolder(parentId: string, name: string): Promise<string> {
  const { createFolder } = await import("@/lib/google-drive")
  const matches = (await listChildFolders(parentId)).filter(f => f.name === name)
  if (matches.length === 1) return matches[0].id
  if (matches.length > 1) {
    throw new Error(`itin folder: multiple folders named "${name}" under ${parentId} (${matches.map(m => m.id).join(", ")}) — needs manual resolution`)
  }
  const created = (await createFolder(parentId, name)) as { id: string }
  return created.id
}

function shortId(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "x"
}

/**
 * Resolve the individual (no-company) folder under Individual Clients.
 *
 * The folder name is keyed to the PERSON'S IDENTITY, not just their legal name:
 * `{name} ({shortId})` where shortId derives from the contact/lead/token. This
 * makes it:
 *  - collision-safe — two different people with the SAME legal name get DIFFERENT
 *    folders (their W-7/passport can never overwrite each other), even under a
 *    concurrent same-name submission (the names differ by construction).
 *  - resubmit-safe / sweep-safe — deterministic, so the inline save, the durable
 *    job, and the backstop sweep all resolve the SAME folder with no stored state.
 *
 * Deliberately does NOT persist onto contacts.drive_folder_id: that column is
 * read+reused by formation's ensureContactFolder, so writing an Individual
 * Clients link there would later hijack the client's company contact folder.
 */
async function resolveIndividualFolder(params: {
  identityKey: string
  clientName: string
}): Promise<string> {
  const clientName = params.clientName.trim()
  if (!clientName) throw new Error("itin folder: cannot resolve an Individual Clients folder without a client name")
  const key = params.identityKey || clientName
  return findOrCreateChildFolder(INDIVIDUAL_CLIENTS_ROOT, `${clientName} (${shortId(key)})`)
}

/**
 * Resolve the person's ITIN contact folder id. Reads the account link when the
 * submission itself carries no account_id (ITIN is person-keyed).
 */
export async function resolveItinContactFolder(params: {
  accountId: string | null
  contactId: string | null
  leadId?: string | null
  token?: string | null
  clientName: string
}): Promise<string> {
  const { contactId } = params

  // Resolve the company account: the submission's own, else the contact's link.
  let accountId = params.accountId ?? null
  if (!accountId && contactId) {
    const { data: link, error } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id")
      .eq("contact_id", contactId)
      .order("is_primary", { ascending: false })
      .order("account_id", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`itin folder: account_contacts read failed (retryable): ${error.message}`)
    accountId = link?.account_id ?? null
  }

  // Company-owner → the company's "2. Contacts" subfolder.
  if (accountId) {
    const { data: acc, error } = await supabaseAdmin
      .from("accounts")
      .select("drive_folder_id, company_name")
      .eq("id", accountId)
      .maybeSingle()
    if (error) throw new Error(`itin folder: account read failed (retryable): ${error.message}`)
    if (acc?.drive_folder_id) {
      return findOrCreateChildFolder(acc.drive_folder_id, COMPANY_CONTACTS_SUBFOLDER)
    }
    // Account exists but has NO Drive folder yet — DON'T misfile into Individual
    // Clients (it would strand the ITIN outside the company permanently). Throw
    // loud/retryable: the durable job waits for the folder; the sweep alerts.
    throw new Error(`itin folder: account ${accountId} (${acc?.company_name ?? "?"}) has NO drive_folder_id yet — ITIN belongs in its "2. Contacts"; retry once the company folder exists`)
  }

  // Individual (no company) → per-person folder under Individual Clients.
  return resolveIndividualFolder({
    identityKey: contactId || params.leadId || params.token || "",
    clientName: params.clientName,
  })
}
