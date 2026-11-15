/**
 * "Passport on file" — worked out from the real files, not from the saved Yes/No flag.
 *
 * The flag on the contact (`contacts.passport_on_file`) is only set by a few older upload paths, so a
 * passport saved through the CRM Storage left it empty and the contact page said "No" while the file
 * was sitting in the person's folder. A contact HAS a passport when any of these is true:
 *   - the saved flag is Yes (kept — it also covers passports recorded by hand),
 *   - a live file of type passport sits in the person's own storage,
 *   - a legacy documents row of type passport exists (Drive era; `store:` pointer rows are skipped because
 *     the store file they point to is already counted above — and a trashed file must not count).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// store_* tables are not in the generated types until they reach production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const CHUNK = 200

/** Pure: the final Yes/No for one contact. */
export function passportOnFile(flag: boolean | null | undefined, hasPassportFile: boolean): boolean {
  return flag === true || hasPassportFile
}

/** Pure: does a documents row count as a (legacy, non-Storage) passport? */
export function isLegacyPassportDoc(d: { document_type_name?: string | null; drive_file_id?: string | null }): boolean {
  if (!/passport/i.test(d.document_type_name ?? "")) return false
  return !(d.drive_file_id ?? "").startsWith("store:")
}

/** The ids (out of `contactIds`) that have a passport FILE today — Storage first, then legacy documents. */
export async function contactsWithPassportFile(contactIds: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  const ids = Array.from(new Set(contactIds.filter(Boolean)))
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)

    const { data: owners } = await db().from("store_owners").select("id, contact_id").in("contact_id", part)
    const contactByOwner = new Map<string, string>(((owners ?? []) as Array<{ id: string; contact_id: string }>).map((o) => [o.id, o.contact_id]))
    if (contactByOwner.size > 0) {
      const { data: files } = await db()
        .from("store_files")
        .select("owner_id")
        .in("owner_id", Array.from(contactByOwner.keys()))
        .eq("document_type", "passport")
        .eq("state", "live")
      for (const f of (files ?? []) as Array<{ owner_id: string }>) {
        const c = contactByOwner.get(f.owner_id)
        if (c) found.add(c)
      }
    }

    const { data: docs } = await db()
      .from("documents")
      .select("contact_id, document_type_name, drive_file_id")
      .in("contact_id", part)
      .ilike("document_type_name", "%passport%")
    for (const d of (docs ?? []) as Array<{ contact_id: string | null; document_type_name: string | null; drive_file_id: string | null }>) {
      if (d.contact_id && isLegacyPassportDoc(d)) found.add(d.contact_id)
    }
  }
  return found
}
