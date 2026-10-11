/**
 * ONE way to open a document by its `drive_file_id` pointer (cutover safety layer, dev job ad09ea91).
 *
 * The CRM keeps a document's location in one column that holds three shapes:
 *   `store:<file id>`   — the new CRM storage (checked FIRST: it is one letter from `storage:`)
 *   `storage:<path>`    — the older Supabase bucket (onboarding-uploads)
 *   anything else       — a Google Drive file id
 * Every reader that handed the raw value to Drive would fail (or silently swallow the error) for a switched
 * company. Readers call this instead; a unit test (drive-access-ratchet) stops new code from bypassing it.
 */

import { parseStorePointer, readStoreFile, StoreFileUnavailableError } from "@/lib/crm-store/document-pointer"

export type DocumentSource = "store" | "storage" | "drive"

export interface OpenedDocument {
  buffer: Buffer
  mimeType: string | null
  fileName: string | null
  source: DocumentSource
}

export class DocumentUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DocumentUnavailableError"
  }
}

const OLDER_BUCKET = "onboarding-uploads"
const OLDER_PREFIX = "storage:"

/** Pure: which place a pointer value names. */
export function classifyPointer(value: string | null | undefined): DocumentSource | null {
  if (!value) return null
  if (parseStorePointer(value) !== null) return "store"
  if (value.startsWith("store:")) return null // a malformed store pointer is never a Drive id
  if (value.startsWith(OLDER_PREFIX)) return "storage"
  return "drive"
}

/** Read a document's bytes from wherever its pointer says. Unknown / unavailable → DocumentUnavailableError. */
export async function openDocument(pointer: string | null | undefined): Promise<OpenedDocument> {
  const source = classifyPointer(pointer)
  if (!pointer || !source) throw new DocumentUnavailableError("This document has no readable location.")

  if (source === "store") {
    try {
      const f = await readStoreFile(parseStorePointer(pointer) as string)
      return { buffer: f.bytes, mimeType: f.mimeType, fileName: f.name, source }
    } catch (e) {
      if (e instanceof StoreFileUnavailableError) throw new DocumentUnavailableError(e.message)
      throw e
    }
  }

  if (source === "storage") {
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    const { data, error } = await supabaseAdmin.storage.from(OLDER_BUCKET).download(pointer.slice(OLDER_PREFIX.length))
    if (error || !data) throw new DocumentUnavailableError("This document's file was not found.")
    return { buffer: Buffer.from(await data.arrayBuffer()), mimeType: data.type || null, fileName: null, source }
  }

  const { downloadFileBinary } = await import("@/lib/google-drive")
  const d = await downloadFileBinary(pointer)
  return { buffer: d.buffer, mimeType: d.mimeType, fileName: d.fileName, source }
}
