/**
 * Staff-added document types for the NEW store (Antonio 2026-09-27: "add custom"). Today's Drive upload lets
 * staff type a new type name ("Custom…") that then appears for everyone; the store's types are a catalog, so a
 * custom name becomes a catalog entry — through the catalog framework (decision log, who added it). The
 * folder it is added from decides its nature: from "2. Contacts" / a person's storage it is a PERSONAL type
 * (only ever in a person's storage), from a company folder a company type of that folder's category. A new
 * type is never staff-only and never a draft; it is hidden from the client until staff share a file.
 */
const KIND_CATEGORY: Record<string, { num: number; folder: string }> = {
  company: { num: 1, folder: "1. Company" },
  contacts: { num: 2, folder: "2. Contacts" },
  personal: { num: 2, folder: "2. Contacts" },
  itin: { num: 2, folder: "2. Contacts" },
  tax: { num: 3, folder: "3. Tax" },
  tax_year: { num: 3, folder: "3. Tax" },
  person_tax: { num: 3, folder: "3. Tax" },
  banking: { num: 4, folder: "4. Banking" },
  correspondence: { num: 5, folder: "5. Correspondence" },
}

/** "Lease Amendment" → "lease_amendment" (ascii, lower case, underscores). */
export function customTypeSlug(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60)
}

export function cleanTypeName(name: string): string {
  const n = name.replace(/\s+/g, " ").trim()
  if (n.length < 2) throw new Error("Enter a name for the new document type.")
  if (n.length > 80) throw new Error("That name is too long.")
  return n
}

export async function addCustomDocumentType(p: { name: string; folderKind: string; actorId: string | null }): Promise<{ slug: string; name: string; personal: boolean; created: boolean }> {
  const name = cleanTypeName(p.name)
  const slug = customTypeSlug(name)
  if (!slug) throw new Error("Use letters or numbers in the type name.")
  const personal = ["contacts", "personal", "itin"].includes(p.folderKind)
  const cat = KIND_CATEGORY[p.folderKind] ?? KIND_CATEGORY.correspondence
  const { getEntry, addEntry } = await import("@/lib/catalog/framework")
  const existing = await getEntry("storage_document_types", slug)
  if (existing) {
    if (existing.status !== "active") throw new Error(`A type called "${existing.display_name}" exists but is switched off — ask an admin to restore it.`)
    const m = (existing.metadata ?? {}) as { personal?: boolean }
    return { slug, name: existing.display_name, personal: m.personal === true, created: false }
  }
  await addEntry("storage_document_types", {
    slug,
    display_name: name,
    metadata: {
      personal, legacy_category: cat.num, suggested_folder: cat.folder, default_folder_kind: personal ? "personal" : (p.folderKind || "company"),
      default_published: false, draft_never_visible: false, freeze_when_filed: false, proof_of_filing: false, staff_only: false,
      custom: true,
    },
  }, "Custom document type added by staff while uploading into the CRM storage", { kind: "ui", userId: p.actorId })
  return { slug, name, personal, created: true }
}
