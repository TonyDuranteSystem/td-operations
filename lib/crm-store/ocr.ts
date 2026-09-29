/**
 * OCR a CRM document wherever its bytes live (job 685467b5): a `store:<fileId>` pointer is read from the
 * NEW store (never from Drive); anything else is a Drive file id, read through Document AI as before.
 * Dependencies are injectable so the routing is unit-testable without Drive, the store or Document AI.
 */
import type { OcrResult } from "@/lib/docai"

export interface OcrByPointerDeps {
  ocrDrive: (driveFileId: string) => Promise<OcrResult>
  readStore: (fileId: string) => Promise<{ bytes: Buffer; mimeType: string | null; name: string }>
  ocrBytes: (content: ArrayBuffer, mimeType: string, fileName: string) => Promise<OcrResult>
}

async function defaultDeps(): Promise<OcrByPointerDeps> {
  const { ocrDriveFile, ocrRawContent } = await import("@/lib/docai")
  const { readStoreFile } = await import("./document-pointer")
  return { ocrDrive: (id) => ocrDriveFile(id), readStore: readStoreFile, ocrBytes: ocrRawContent }
}

export async function ocrByPointer(pointer: string, deps?: OcrByPointerDeps): Promise<OcrResult> {
  const { parseStorePointer } = await import("./document-pointer")
  const d = deps ?? (await defaultDeps())
  const fileId = parseStorePointer(pointer)
  if (fileId) {
    const f = await d.readStore(fileId)
    const ab = f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer
    return d.ocrBytes(ab, f.mimeType || "application/pdf", f.name)
  }
  // a malformed store: value must never be sent to Drive as if it were a Drive id
  if (pointer.startsWith("store:")) throw new Error("This document's storage reference is not valid.")
  return d.ocrDrive(pointer)
}
