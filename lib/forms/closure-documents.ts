/**
 * Show the client's closure package on the JOB (Company Closure part B, QA fix 2026-11-06).
 *
 * The wizard's files (the summary PDF, the Articles, the EIN letter, anything else) are filed in the CRM storage by `saveFormToStore`, which
 * does not make a CRM `documents` row — so the job's workspace "Documents" box (it lists `documents` by service delivery) said "0 documents"
 * while staff were asked to check them. This lists each filed file on the job:
 *   - staff-only (`portal_visible: false`; "Company Closure" has no client-safe stage in lib/flows/flow-doc-visibility.ts);
 *   - NO `flow_stage` — "Go Back" deletes the documents stamped with the step it re-opens, and these belong to the whole job;
 *   - idempotent (one row per stored file, `upsertStoreDocumentRow`), so a retry or a correction never doubles them.
 * The files are found by the exact keys the saver gave them (`form-summary:<owner>:closure:<token>` / `form-upload:<owner>:closure:<token>:<path>`).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { escapeLikeExact } from "@/lib/crm-store/lead-form-store"
import type { DocumentsRow } from "@/lib/crm-store/formation-pilot"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types
const db = () => supabaseAdmin as any

export interface RegisterClosureDocumentsInput {
  /**
   * The owner id the saver put in the files' keys (ClosureDestination.storageOwnerId): the person, or the company — also for a company that
   * kept a Drive folder id, where the destination string is NOT a storage marker but the files still went into the company's storage.
   * null = the package was not filed in the CRM storage: nothing to list.
   */
  storageOwnerId: string | null
  token: string
  contactId: string | null
  /** the job's / submission's explicit company link, if any */
  accountId: string | null
  serviceDeliveryId: string
}

export interface RegisterClosureDocumentsDeps {
  upsert: (fileId: string, row: DocumentsRow) => Promise<{ id: string; inserted: boolean }>
}

/** THROWS on a read or write error (the caller reports an error step, and the job retries — every write is idempotent). */
export async function registerClosurePackageDocuments(
  p: RegisterClosureDocumentsInput,
  deps?: RegisterClosureDocumentsDeps,
): Promise<{ registered: number; inserted: number }> {
  if (!p.storageOwnerId) return { registered: 0, inserted: 0 } // not filed in the CRM storage: nothing to list
  const upsert = deps?.upsert ?? (async (id: string, row: DocumentsRow) => (await import("@/lib/crm-store/formation-pilot")).upsertStoreDocumentRow(id, row))

  const key = `${p.storageOwnerId}:closure:${p.token}`
  const { data: summary, error: sErr } = await db().from("store_files").select("id, name").eq("caller_key", `form-summary:${key}`).is("trashed_at", null)
  if (sErr) throw new Error(`closure documents: could not read the filed summary: ${sErr.message}`)
  const { data: uploads, error: uErr } = await db().from("store_files").select("id, name").like("caller_key", `form-upload:${escapeLikeExact(key)}:%`).is("trashed_at", null)
  if (uErr) throw new Error(`closure documents: could not read the filed uploads: ${uErr.message}`)

  const files = [...((summary ?? []) as Array<{ id: string; name: string }>), ...((uploads ?? []) as Array<{ id: string; name: string }>)]
  let inserted = 0
  for (const f of files) {
    const r = await upsert(f.id, {
      file_name: f.name,
      account_id: p.accountId,
      contact_id: p.contactId,
      service_delivery_id: p.serviceDeliveryId,
      flow_stage: null,
      portal_visible: false,
    })
    if (r.inserted) inserted++
  }
  return { registered: files.length, inserted }
}
