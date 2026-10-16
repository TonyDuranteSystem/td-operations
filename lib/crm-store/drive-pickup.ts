/**
 * Drive pickup (dev job ad09ea91; Antonio 2026-10-16: "bring them in" — the signed 2025 returns / 8879 / fax receipts that are in a
 * company's OLD Drive folder but not in its storage). A short, named list — never "everything in Drive".
 *
 * The list lives in ONE sysdoc row, `drive-pickup` ({ items: [...] }). A cron (`/api/cron/drive-pickup`, STORE_DRIVE_PICKUP=1) takes the
 * items that are `pending`, finds each file BY NAME inside the company's old Drive folder (read-only), saves its bytes into the company's
 * storage — "3. Tax › <year>", internal (hidden from the client) — and marks the item `done`. Idempotent: the caller key is the Drive file
 * id, so a second run says "unchanged". It never writes to Drive and never touches an item that is not in the list.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export const PICKUP_SLUG = "drive-pickup"

export interface PickupItem {
  accountId: string
  company: string
  /** the exact file name in the company's old Drive folder */
  name: string
  /** storage document type slug */
  documentType: string
  year: number
  status?: "pending" | "done" | "skipped" | "failed"
  note?: string
  storeFileId?: string
}
export interface PickupState { items: PickupItem[]; updatedAt?: string }

export function pickupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.STORE_DRIVE_PICKUP ?? "").trim() === "1"
}

export interface ScannedFile { id: string; name: string; path: string[]; mime: string | null }

/** Pure: the ONE file this item means. Several files with that name, or none → a reason (the item is skipped, never guessed). */
export function matchPickup(files: ScannedFile[], name: string): { file: ScannedFile } | { reason: string } {
  const hits = files.filter((f) => f.name === name)
  if (hits.length === 1) return { file: hits[0] }
  if (hits.length === 0) return { reason: "not found in the company's Drive folder" }
  return { reason: `${hits.length} files with that name in the Drive folder — not guessed` }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- system_docs row shape
const sys = () => supabaseAdmin as any

async function load(): Promise<PickupState | null> {
  const { data, error } = await sys().from("system_docs").select("content").eq("slug", PICKUP_SLUG).maybeSingle()
  if (error) throw new Error("Could not read the Drive pickup list.")
  if (!data?.content) return null
  try { return JSON.parse(data.content as string) as PickupState } catch { return null }
}
async function save(state: PickupState): Promise<void> {
  const { error } = await sys().from("system_docs").update({ content: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), updated_at: new Date().toISOString() }).eq("slug", PICKUP_SLUG)
  if (error) throw new Error("Could not save the Drive pickup list.")
}

export async function runPickupBatch(opts: { budgetMs: number }): Promise<{ pending: number; done: number; failed: number; skipped: number }> {
  const t0 = Date.now()
  const state = await load()
  const count = (s: PickupState) => ({
    pending: s.items.filter((i) => (i.status ?? "pending") === "pending").length,
    done: s.items.filter((i) => i.status === "done").length,
    failed: s.items.filter((i) => i.status === "failed").length,
    skipped: s.items.filter((i) => i.status === "skipped").length,
  })
  if (!state) return { pending: 0, done: 0, failed: 0, skipped: 0 }
  const accounts = Array.from(new Set(state.items.filter((i) => (i.status ?? "pending") === "pending").map((i) => i.accountId)))
  for (const accountId of accounts) {
    if (Date.now() - t0 > opts.budgetMs) break
    const mine = state.items.filter((i) => i.accountId === accountId && (i.status ?? "pending") === "pending")
    try {
      const { data: acct } = await sys().from("accounts").select("drive_folder_id").eq("id", accountId).maybeSingle()
      const folderId = acct?.drive_folder_id as string | undefined
      if (!folderId) throw new Error("this company has no old Drive folder")
      const { companyDocState, liveOwnerOfAccount } = await import("./switched-drive-guard")
      if ((await companyDocState(accountId)) !== "store") throw new Error("this company's files are not in the new storage")
      const ownerId = await liveOwnerOfAccount(accountId)
      if (!ownerId) throw new Error("the company's storage was not found")
      const { scanDrive } = await import("./drive-import")
      const scanned = await scanDrive(folderId)
      const files: ScannedFile[] = scanned.map((s) => ({ id: s.source_id, name: s.name, path: s.drive_path ?? [], mime: s.mime_type ?? null }))
      const { downloadBinaryAnyDrive } = await import("@/lib/google-drive")
      const pilot = await import("./formation-pilot")
      const { ensureYearFolder } = await import("./save-form")
      for (const item of mine) {
        try {
          const m = matchPickup(files, item.name)
          if ("reason" in m) { item.status = "skipped"; item.note = m.reason; continue }
          const bytes = await downloadBinaryAnyDrive(m.file.id)
          const yearFolder = await ensureYearFolder(await pilot.folderOfKind(ownerId, "tax"), String(item.year))
          const w = await pilot.savePilotFile({
            ownerId, folderKind: "tax", folderId: yearFolder, name: item.name, bytes, mimeType: m.file.mime || "application/pdf",
            documentType: item.documentType, callerKey: `drive-pickup:${m.file.id}`, published: false, periodYear: item.year, actor: null,
          })
          await pilot.upsertStoreDocumentRow(w.fileId, {
            file_name: item.name, mime_type: m.file.mime || "application/pdf", file_size: bytes.length, account_id: accountId,
            status: "classified", portal_visible: false,
          }, w.status)
          item.status = "done"; item.storeFileId = w.fileId; item.note = `${w.status} (${bytes.length} bytes)`
        } catch (e) {
          item.status = "failed"; item.note = e instanceof Error ? e.message : String(e)
        }
        await save(state)
      }
    } catch (e) {
      for (const item of mine) { item.status = "failed"; item.note = e instanceof Error ? e.message : String(e) }
    }
    await save(state)
  }
  return count(state)
}
