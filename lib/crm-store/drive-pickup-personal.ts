/**
 * Drive pickup for PERSONAL documents (dev job ad09ea91, item 3 of the last storage items; Antonio 2026-10-17).
 *
 * Two personal card statements ("Jayesh Hans Amex.pdf", "Manuel Severino Capital One.pdf") were saved by staff into a company's old Drive
 * folder after the company switched, so their CRM record still points at Drive. The company pickup (drive-pickup.ts) cannot take them:
 * a personal document belongs in the PERSON'S storage (Personal documents folder), never a company's.
 *
 * The list lives in ONE sysdoc row, `drive-pickup-personal` ({ items: [...] }), read by the same cron/switch as the company pickup. Each item
 * names the CRM record, the person and the exact Drive file id — nothing is searched or guessed. For each pending item: save the bytes into the
 * person's storage (made if they have none), then re-point THAT record at the stored copy (no second record). Idempotent: the caller key is
 * the Drive file id, and the re-point only happens while the record still points at that Drive file. Drive is never written.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export const PERSONAL_PICKUP_SLUG = "drive-pickup-personal"

export interface PersonalPickupItem {
  /** the CRM record (documents.id) that points at the Drive file */
  documentId: string
  /** the person whose storage receives it (contacts.id) */
  contactId: string
  /** the exact Drive file id the record points at */
  driveFileId: string
  name: string
  /** storage document type slug — must be a personal type (e.g. credit_card_statement) */
  documentType: string
  status?: "pending" | "done" | "skipped" | "failed"
  note?: string
  storeFileId?: string
}
export interface PersonalPickupState { items: PersonalPickupItem[]; updatedAt?: string }

/** Pure: may this item be run? (a plain reason otherwise — the item is skipped, never guessed) */
export function checkPersonalItem(item: PersonalPickupItem, row: { drive_file_id: string | null; contact_id: string | null } | null): { ok: true } | { ok: false; reason: string } {
  if (!row) return { ok: false, reason: "the CRM record no longer exists" }
  if (row.drive_file_id !== item.driveFileId) return { ok: false, reason: "the record no longer points at that Drive file (already moved?)" }
  if (row.contact_id && row.contact_id !== item.contactId) return { ok: false, reason: "the record belongs to a different person than the list says" }
  return { ok: true }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- system_docs row shape
const sys = () => supabaseAdmin as any

async function load(): Promise<PersonalPickupState | null> {
  const { data, error } = await sys().from("system_docs").select("content").eq("slug", PERSONAL_PICKUP_SLUG).maybeSingle()
  if (error) throw new Error("Could not read the personal pickup list.")
  if (!data?.content) return null
  try { return JSON.parse(data.content as string) as PersonalPickupState } catch { return null }
}
async function save(state: PersonalPickupState): Promise<void> {
  const { error } = await sys().from("system_docs").update({ content: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), updated_at: new Date().toISOString() }).eq("slug", PERSONAL_PICKUP_SLUG)
  if (error) throw new Error("Could not save the personal pickup list.")
}

const counts = (s: PersonalPickupState) => ({
  pending: s.items.filter((i) => (i.status ?? "pending") === "pending").length,
  done: s.items.filter((i) => i.status === "done").length,
  failed: s.items.filter((i) => i.status === "failed").length,
  skipped: s.items.filter((i) => i.status === "skipped").length,
})

export async function runPersonalPickupBatch(opts: { budgetMs: number }): Promise<{ pending: number; done: number; failed: number; skipped: number }> {
  const t0 = Date.now()
  const state = await load()
  if (!state) return { pending: 0, done: 0, failed: 0, skipped: 0 }
  const pilot = await import("./formation-pilot")
  const { downloadBinaryAnyDrive } = await import("@/lib/google-drive")
  const { storePointer, storeDocumentLink } = await import("./document-pointer")
  for (const item of state.items.filter((i) => (i.status ?? "pending") === "pending")) {
    if (Date.now() - t0 > opts.budgetMs) break
    try {
      const { data: row } = await sys().from("documents").select("id, drive_file_id, contact_id, mime_type, portal_visible").eq("id", item.documentId).maybeSingle()
      const verdict = checkPersonalItem(item, row ?? null)
      if ("reason" in verdict) { item.status = "skipped"; item.note = verdict.reason; await save(state); continue }
      const { data: person } = await sys().from("contacts").select("full_name").eq("id", item.contactId).maybeSingle()
      if (!person) { item.status = "skipped"; item.note = "the person no longer exists"; await save(state); continue }
      const ownerId = await pilot.ensurePersonOwner(item.contactId, (person.full_name as string) || "Person")
      const bytes = await downloadBinaryAnyDrive(item.driveFileId)
      const mime = (row.mime_type as string | null) || "application/pdf"
      const w = await pilot.savePilotFile({
        ownerId, folderKind: "personal", name: item.name, bytes, mimeType: mime, documentType: item.documentType,
        callerKey: `drive-pickup-personal:${item.driveFileId}`, published: row.portal_visible === true, actor: null,
      })
      // the SAME record follows the file — only while it still points at that Drive file
      const { data: moved, error: upErr } = await sys().from("documents")
        .update({ drive_file_id: storePointer(w.fileId), drive_link: storeDocumentLink(item.documentId), updated_at: new Date().toISOString() })
        .eq("id", item.documentId).eq("drive_file_id", item.driveFileId).select("id")
      if (upErr) throw new Error(`saved in the storage, but the CRM record could not be re-pointed — ${upErr.message}`)
      item.status = "done"; item.storeFileId = w.fileId
      item.note = `${w.status} (${bytes.length} bytes)${moved && moved.length === 0 ? " — record already moved" : ""}`
    } catch (e) {
      item.status = "failed"; item.note = e instanceof Error ? e.message : String(e)
    }
    await save(state)
  }
  return counts(state)
}
