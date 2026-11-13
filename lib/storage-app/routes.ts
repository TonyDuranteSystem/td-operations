/**
 * Which "company › 2. Contacts › person" places show a person's storage (dev job 1992a087, 2026-11-13).
 *
 * A person's storage appears in Finder twice: under People, and under every company the person belongs to (company › 2. Contacts › person).
 * The change feed names the plain item only, so the Mac must also update the copy under each company. Until now the Mac learned those
 * places only when Finder happened to open the company's Contacts folder, so a folder Finder had already cached (and never re-listed)
 * stayed out of date for good. Now the Mac asks the CRM, which knows: a company lists a person when the person is linked to the company
 * (`account_contacts`) and the company's storage has a "2. Contacts" folder.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export interface CompanyRoute { owner: string; company: string; folder: string }

/** PURE: the routes for one person storage, from the companies that list the person and each company's Contacts folder. Companies this login may not open are left out. */
export function buildRoutes(personOwner: string, companyOwnerIds: string[], contactsFolderByCompany: Map<string, string>, mayOpen: (companyOwnerId: string) => boolean): CompanyRoute[] {
  const out: CompanyRoute[] = []
  for (const company of Array.from(new Set(companyOwnerIds)).sort()) {
    const folder = contactsFolderByCompany.get(company)
    if (!folder || !mayOpen(company)) continue
    out.push({ owner: personOwner, company, folder })
  }
  return out
}

/** At most this many storages per question (the Mac asks for a whole batch of changes at once). */
export const MAX_OWNERS_PER_QUESTION = 40

/** PURE: the storage ids in `?owner=a,b,c` — valid ids only, no repeats, never more than the limit. */
export function parseOwnerList(raw: string | null, isId: (s: string) => boolean): string[] {
  if (!raw) return []
  return Array.from(new Set(raw.split(",").map((s) => s.trim()).filter(isId))).slice(0, MAX_OWNERS_PER_QUESTION)
}

/**
 * The places each of these person storages is shown under a company. A storage that is not a person's gives nothing. `mayOpen` is asked once per
 * company (the same access test the Storage page applies), so this never names a company the login could not open.
 */
export async function companyRoutesFor(personOwnerIds: string[], mayOpen: (companyOwnerId: string) => Promise<boolean>, liveIds: (ids: string[]) => Promise<Set<string>>): Promise<CompanyRoute[]> {
  if (personOwnerIds.length === 0) return []
  const { data: people, error: pErr } = await db().from("store_owners").select("id, contact_id").eq("kind", "person").in("id", personOwnerIds)
  if (pErr) throw new Error(`Could not read the storages (${pErr.message}).`)
  const contactOf = new Map<string, string>()
  for (const p of (people ?? []) as { id: string; contact_id: string | null }[]) if (p.contact_id) contactOf.set(p.id, p.contact_id)
  if (contactOf.size === 0) return []

  const { data: links, error: lErr } = await db().from("account_contacts").select("contact_id, account_id").in("contact_id", Array.from(new Set(contactOf.values())))
  if (lErr) throw new Error(`Could not read the people (${lErr.message}).`)
  const accountsOfContact = new Map<string, string[]>()
  for (const l of (links ?? []) as { contact_id: string; account_id: string }[]) accountsOfContact.set(l.contact_id, [...(accountsOfContact.get(l.contact_id) ?? []), l.account_id])
  const accountIds = Array.from(new Set(Array.from(accountsOfContact.values()).flat()))
  if (accountIds.length === 0) return []

  const { data: companies, error: cErr } = await db().from("store_owners").select("id, account_id").eq("kind", "company").in("account_id", accountIds)
  if (cErr) throw new Error(`Could not read the companies (${cErr.message}).`)
  const companiesOfAccount = new Map<string, string[]>()
  for (const c of (companies ?? []) as { id: string; account_id: string }[]) companiesOfAccount.set(c.account_id, [...(companiesOfAccount.get(c.account_id) ?? []), c.id])
  const companyIds = Array.from(new Set(Array.from(companiesOfAccount.values()).flat()))
  if (companyIds.length === 0) return []

  const live = await liveIds(companyIds)
  const { data: folders, error: fErr } = await db().from("store_folders").select("id, owner_id").eq("kind", "contacts").is("trashed_at", null).in("owner_id", companyIds)
  if (fErr) throw new Error(`Could not read the folders (${fErr.message}).`)
  const contactsFolder = new Map<string, string>()
  for (const f of (folders ?? []) as { id: string; owner_id: string }[]) if (!contactsFolder.has(f.owner_id)) contactsFolder.set(f.owner_id, f.id)

  const allowed = new Map<string, boolean>()
  for (const id of companyIds) allowed.set(id, live.has(id) && contactsFolder.has(id) && (await mayOpen(id)))

  const out: CompanyRoute[] = []
  for (const [person, contact] of Array.from(contactOf.entries())) {
    const ids = (accountsOfContact.get(contact) ?? []).flatMap((a) => companiesOfAccount.get(a) ?? [])
    out.push(...buildRoutes(person, ids, contactsFolder, (c) => allowed.get(c) === true))
  }
  return out
}
