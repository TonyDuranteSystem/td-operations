/**
 * Move a file out of a PERSON's storage into a COMPANY's storage (Antonio 2026-10-21, Gold Waves: a bank application's proof of
 * address was filed under the person; staff must be able to put it with the company's bank application).
 * The SAME file is re-homed (record, versions and backup stay attached) and its CRM row follows. Refused unless:
 *   - the person is a live member of that company (never an arbitrary company);
 *   - the file is NOT an ID paper (a passport / ID / licence stays in the person's own storage) — by its document type AND by its name;
 *   - the target is a folder that takes company files (not the top, not "2. Contacts").
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { looksLikeIdPaper } from "./id-papers"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export async function moveFileToCompany(fileId: string, toFolderId: string, actorId: string | null): Promise<{ folderName: string; company: string; note: string | null }> {
  const { data: f, error } = await db().from("store_files").select("id, name, owner_id, folder_id, state, document_type, store_owners!inner(kind, contact_id)").eq("id", fileId).maybeSingle()
  if (error) throw new Error(`Could not read the file — please try again (${error.message}).`)
  if (!f) throw new Error("File not found.")
  if (f.state !== "live") throw new Error("Restore the file from the trash first.")
  if (f.store_owners.kind !== "person" || !f.store_owners.contact_id) throw new Error("This file is not in a person's storage.")
  const { data: to, error: tErr } = await db().from("store_folders").select("id, owner_id, name, kind, trashed_at, store_owners!inner(kind, account_id)").eq("id", toFolderId).maybeSingle()
  if (tErr) throw new Error(`Could not read the folder — please try again (${tErr.message}).`)
  if (!to || to.trashed_at) throw new Error("That folder is not available.")
  const accountId = to.store_owners.account_id as string | null
  if (!["company", "formation"].includes(to.store_owners.kind) || !accountId) throw new Error("A person's file can only move into another person's storage or a company's storage.")
  if (to.kind === "root") throw new Error("Files go inside a folder, not at the top.")
  if (to.kind === "contacts") throw new Error("\"2. Contacts\" shows the people's own documents — a file cannot go there.")

  // an ID paper never leaves the person: by its type (the catalog's personal types) and by its name (a file may have no type)
  const { personalTypes } = await import("./structure")
  const personal = !!f.document_type && (await personalTypes()).has(f.document_type)
  if (personal || looksLikeIdPaper(f.name)) throw new Error("This looks like an ID paper (passport, ID, licence …). ID papers stay in the person's own storage — they cannot go into a company's.")

  const { data: link, error: lErr } = await db().from("account_contacts").select("account_id").eq("account_id", accountId).eq("contact_id", f.store_owners.contact_id).is("ended_at", null).limit(1)
  if (lErr) throw new Error(`Could not check the company's people — please try again (${lErr.message}).`)
  if ((link ?? []).length === 0) throw new Error("That company is not one of this person's companies.")

  const { data: clash } = await db().from("store_files").select("id").eq("folder_id", to.id).eq("state", "live").eq("name", f.name).maybeSingle()
  if (clash) throw new Error(`"${to.name}" already has a file called "${f.name}".`)

  const { data: acc } = await db().from("accounts").select("company_name").eq("id", accountId).maybeSingle()
  const company = (acc?.company_name as string | undefined) ?? "the company"
  const { categoryForFolder } = await import("./structure")
  const cat = await categoryForFolder(to.id)
  // the old audience does not follow the file into a company every member sees: hide it first (staff show it again on purpose)
  const { hideForOwnerChange } = await import("./owner-change-hide")
  const hidden = await hideForOwnerChange(f.id, actorId)
  const { error: rhErr } = await db().rpc("store_rehome_file", { p_file_id: f.id, p_to_folder: to.id, p_actor: actorId, p_reason: `Moved to ${company}` })
  if (rhErr) {
    await hidden.restore().catch((b) => console.error("[crm-store] could not restore visibility after a refused move:", b))
    throw new Error(`The file could not be moved (${String(rhErr.message).replace(/^store: /, "")}).`)
  }
  const { storePointer } = await import("./document-pointer")
  const { error: rErr } = await db().from("documents").update({ account_id: accountId, category: cat.num, category_name: cat.name, updated_at: new Date().toISOString() }).eq("drive_file_id", storePointer(f.id))
  if (rErr) {
    // never half-done: the file goes back where it was
    const { rollBackOrAlarm, unexpectedPlaceMessage } = await import("./event-log")
    const back = await rollBackOrAlarm("move-to-company put-back", { fileId: f.id, fromFolder: f.folder_id, toFolder: to.id },
      () => db().rpc("store_rehome_file", { p_file_id: f.id, p_to_folder: f.folder_id, p_actor: actorId, p_reason: "Move failed — put back" }))
    // the put-back failed: the file stays hidden from the client (it is in an unexpected place) and staff are told plainly
    if (!back) throw new Error(unexpectedPlaceMessage(`The CRM list could not be updated (${rErr.message}).`))
    await hidden.restore().catch((b) => console.error("[crm-store] could not restore visibility after a failed move:", b))
    throw new Error(`The CRM list could not be updated, so the file was not moved (${rErr.message}) — please try again.`)
  }
  return { folderName: to.name, company, note: hidden.note }
}
