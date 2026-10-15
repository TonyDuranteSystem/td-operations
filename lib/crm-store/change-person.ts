/**
 * "Belongs to another person" — a personal document (passport, ID …) that sits in ONE person's storage but is really
 * another person's (Reset Formula 2026-10-15: Maggiorino's passport was filed under Stella). The SAME file is re-homed into the
 * other person's storage (record, versions, backup stay attached) and its CRM record follows to that person. Only people of a
 * company the current person is in can be chosen — never an arbitrary contact. Dev job ad09ea91.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export interface PersonChoice { contactId: string; name: string }

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
  return peopleChoices(f.ownerContactId, ((links ?? []) as Array<{ contact_id: string; contacts: { full_name: string | null } | Array<{ full_name: string | null }> | null }>).map((l) => ({
    contactId: l.contact_id, name: (Array.isArray(l.contacts) ? l.contacts[0]?.full_name : l.contacts?.full_name) ?? null,
  })))
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
  const { data: clash } = await db().from("store_files").select("id").eq("folder_id", target.id).eq("state", "live").eq("name", f.name).maybeSingle()
  if (clash) throw new Error(`"${target.name}" of ${who.name} already has a file called "${f.name}".`)
  const { error: rhErr } = await db().rpc("store_rehome_file", { p_file_id: f.id, p_to_folder: target.id, p_actor: actorId, p_reason: `Belongs to ${who.name}` })
  if (rhErr) throw new Error(`The file could not be moved (${rhErr.message.replace(/^store: /, "")}).`)
  // the CRM record follows the file (a later failure puts the file back — never half-done)
  const { storePointer } = await import("./document-pointer")
  const { error: rErr } = await db().from("documents").update({ contact_id: who.contactId, updated_at: new Date().toISOString() }).eq("drive_file_id", storePointer(f.id))
  if (rErr) {
    await db().rpc("store_rehome_file", { p_file_id: f.id, p_to_folder: f.folder_id, p_actor: actorId, p_reason: "Change person failed — put back" })
    throw new Error(`The CRM list could not be updated, so the file was not moved (${rErr.message}) — please try again.`)
  }
  return { person: who.name, folder: target.name }
}
