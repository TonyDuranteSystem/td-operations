/**
 * "Belongs to another person" — a personal document (passport, ID …) that sits in ONE person's storage but is really
 * another person's (Reset Formula 2026-10-15: Maggiorino's passport was filed under Stella). The SAME file is re-homed into the
 * other person's storage (record, versions, backup stay attached) and its CRM record follows to that person. Only people of a
 * company the current person is in can be chosen — never an arbitrary contact. Dev job ad09ea91.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export interface PersonChoice { contactId: string; name: string; hasStorage?: boolean }

interface PersonFile { id: string; name: string; owner_id: string; folder_id: string; state: string; ownerContactId: string; folderKind: string }

async function personFile(fileId: string): Promise<PersonFile> {
  const { data, error } = await db().from("store_files").select("id, name, owner_id, folder_id, state, store_owners!inner(kind, contact_id), store_folders!inner(kind)").eq("id", fileId).maybeSingle()
  if (error) throw new Error(`Could not read the file — please try again (${error.message}).`)
  if (!data) throw new Error("File not found.")
  if (data.state !== "live") throw new Error("Restore the file from the trash first.")
  if (data.store_owners.kind !== "person" || !data.store_owners.contact_id) throw new Error("This file is not in a person's storage.")
  return { id: data.id, name: data.name, owner_id: data.owner_id, folder_id: data.folder_id, state: data.state, ownerContactId: data.store_owners.contact_id, folderKind: data.store_folders.kind }
}

/** Pure: the people offered — those who share a company with the current person, without the current person, sorted, no repeats. */
export function peopleChoices(currentContactId: string, rows: Array<{ contactId: string; name: string | null }>): PersonChoice[] {
  const seen = new Set<string>()
  const out: PersonChoice[] = []
  for (const r of rows) {
    if (r.contactId === currentContactId || seen.has(r.contactId)) continue
    seen.add(r.contactId)
    out.push({ contactId: r.contactId, name: r.name || "Person" })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The people this file can be given to. */
export async function peopleForFile(fileId: string): Promise<PersonChoice[]> {
  const f = await personFile(fileId)
  const { data: mine, error } = await db().from("account_contacts").select("account_id").eq("contact_id", f.ownerContactId).is("ended_at", null)
  if (error) throw new Error(`Could not read the person's companies — please try again (${error.message}).`)
  const accountIds = ((mine ?? []) as Array<{ account_id: string }>).map((r) => r.account_id)
  if (accountIds.length === 0) return []
  const { data: links, error: lErr } = await db().from("account_contacts").select("contact_id, contacts(full_name)").in("account_id", accountIds).is("ended_at", null)
  if (lErr) throw new Error(`Could not read the companies' people — please try again (${lErr.message}).`)
  const choices = peopleChoices(f.ownerContactId, ((links ?? []) as Array<{ contact_id: string; contacts: { full_name: string | null } | Array<{ full_name: string | null }> | null }>).map((l) => ({
    contactId: l.contact_id, name: (Array.isArray(l.contacts) ? l.contacts[0]?.full_name : l.contacts?.full_name) ?? null,
  })))
  if (choices.length === 0) return choices
  const { data: owners, error: oErr } = await db().from("store_owners").select("contact_id").eq("kind", "person").in("contact_id", choices.map((c) => c.contactId))
  if (oErr) throw new Error(`Could not read the people's storages — please try again (${oErr.message}).`)
  const have = new Set(((owners ?? []) as Array<{ contact_id: string }>).map((o) => o.contact_id))
  return choices.map((c) => ({ ...c, hasStorage: have.has(c.contactId) }))
}

/**
 * Move a file out of one person's storage into a folder the staff member CHOSE in another person's storage (the Move picker).
 * Refused unless both storages are people's and the other person is in one of the first person's companies.
 */
export async function moveFileToOtherPerson(fileId: string, toFolderId: string, actorId: string | null): Promise<{ folderName: string; person: string }> {
  const f = await personFile(fileId)
  const { data: to, error: tErr } = await db().from("store_folders").select("id, owner_id, name, kind, trashed_at, store_owners!inner(kind, contact_id)").eq("id", toFolderId).maybeSingle()
  if (tErr) throw new Error(`Could not read the folder — please try again (${tErr.message}).`)
  if (!to || to.trashed_at) throw new Error("That folder is not available.")
  if (to.store_owners.kind !== "person" || !to.store_owners.contact_id) throw new Error("A person's file can only move into another person's storage (of the same company) — not into a company, Business or My files.")
  const who = (await peopleForFile(fileId)).find((c) => c.contactId === to.store_owners.contact_id)
  if (!who) throw new Error("That person is not in one of this person's companies.")
  if (to.kind === "root") throw new Error("Files go inside a folder, not at the top.")
  if (to.kind === "contacts") throw new Error("\"2. Contacts\" shows the people's own documents — a file cannot go there.")
  const { data: clash } = await db().from("store_files").select("id").eq("folder_id", to.id).eq("state", "live").eq("name", f.name).maybeSingle()
  if (clash) throw new Error(`"${to.name}" already has a file called "${f.name}".`)
  // a personal TYPE keeps its CRM category ("Contacts"); any other file follows its new folder (as the normal move does)
  const { categoryForFolder, personalTypes } = await import("./structure")
  const { data: ft } = await db().from("store_files").select("document_type").eq("id", f.id).maybeSingle()
  const isPers = !!ft?.document_type && (await personalTypes()).has(ft.document_type)
  const cat = isPers ? null : await categoryForFolder(to.id)
  const { error: rhErr } = await db().rpc("store_rehome_file", { p_file_id: f.id, p_to_folder: to.id, p_actor: actorId, p_reason: `Moved to ${who.name}` })
  if (rhErr) throw new Error(`The file could not be moved (${rhErr.message.replace(/^store: /, "")}).`)
  // the CRM record follows the file (a later failure puts the file back — never half-done)
  const { storePointer } = await import("./document-pointer")
  const patch: Record<string, unknown> = { contact_id: who.contactId, updated_at: new Date().toISOString() }
  if (cat) { patch.category = cat.num; patch.category_name = cat.name }
  const { error: rErr } = await db().from("documents").update(patch).eq("drive_file_id", storePointer(f.id))
  if (rErr) {
    await db().rpc("store_rehome_file", { p_file_id: f.id, p_to_folder: f.folder_id, p_actor: actorId, p_reason: "Move failed — put back" })
    throw new Error(`The CRM list could not be updated, so the file was not moved (${rErr.message}) — please try again.`)
  }
  return { folderName: to.name, person: who.name }
}

export async function changeFilePerson(fileId: string, toContactId: string, actorId: string | null): Promise<{ person: string; folder: string }> {
  const f = await personFile(fileId)
  const choices = await peopleForFile(fileId)
  const who = choices.find((c) => c.contactId === toContactId)
  if (!who) throw new Error("That person is not in one of this person's companies.")
  const { ensurePersonOwner } = await import("./formation-pilot")
  const toOwner = await ensurePersonOwner(who.contactId, who.name)
  // the same kind of folder in the other person's storage (the personal folder when that kind is not there)
  const { data: folders, error: fErr } = await db().from("store_folders").select("id, kind, name").eq("owner_id", toOwner).is("trashed_at", null).in("kind", Array.from(new Set([f.folderKind, "personal"])))
  if (fErr) throw new Error(`Could not read the other person's folders — please try again (${fErr.message}).`)
  const list = (folders ?? []) as Array<{ id: string; kind: string; name: string }>
  const target = list.find((x) => x.kind === f.folderKind) ?? list.find((x) => x.kind === "personal")
  if (!target) throw new Error("The other person's storage has no personal folder.")
  const r = await moveFileToOtherPerson(fileId, target.id, actorId)
  return { person: r.person, folder: r.folderName }
}
