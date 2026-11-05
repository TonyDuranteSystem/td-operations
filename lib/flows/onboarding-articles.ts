/**
 * An onboarding submission's uploaded files, and which of them is the Articles of Organization (dev job 64d2be64).
 *
 * Pure helpers shared by the review screen's two routes: the documents list and the Filing ID check. The wizard names every
 * upload `{wizardType}/{identifier}/{fieldName}_{unique}_{filename}`, so the Articles slot's files start with `articles_of_organization`.
 */

import { isTraversalSafePath } from "@/lib/storage/safe-path"

export interface SubmissionUploadOwner {
  token: string | null
  account_id: string | null
  lead_id: string | null
  offer_id: string | null
  contact_id: string | null
}

/**
 * Only the paths that really belong to THIS submission. `upload_paths` is written from client-submitted data with only a prefix check
 * upstream, so a crafted submission could name another client's file — nothing is signed or read unless it sits under one of the
 * submission's own folders: the token folder, or `onboarding/<account | lead | offer | contact id>/`.
 */
export function ownedUploadPaths(sub: SubmissionUploadOwner, allPaths: string[]): { owned: string[]; rejected: number } {
  const prefixes = [
    sub.token ? `${sub.token}/` : null,
    sub.account_id ? `onboarding/${sub.account_id}/` : null,
    sub.lead_id ? `onboarding/${sub.lead_id}/` : null,
    sub.offer_id ? `onboarding/${sub.offer_id}/` : null,
    sub.contact_id ? `onboarding/${sub.contact_id}/` : null,
  ].filter((p): p is string => !!p)
  // a path that can walk out of its folder ("../") is never owned, whatever its prefix says
  const owned = allPaths.filter((p) => isTraversalSafePath(p) && prefixes.some((prefix) => p.startsWith(prefix)))
  return { owned, rejected: allPaths.length - owned.length }
}

/** The uploads in the wizard's Articles of Organization slot, in the order the client uploaded them. */
export function articlesUploads(paths: string[]): string[] {
  return paths.filter((p) => {
    const fileName = (p.split("/").pop() ?? p).toLowerCase()
    return fileName.startsWith("articles_of_organization")
  })
}

/** A mime type for a stored upload, from its extension (the signed link has none). Null when the extension says nothing. */
export function mimeTypeFromFileName(fileName: string): string | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? ""
  switch (ext) {
    case "pdf": return "application/pdf"
    case "png": return "image/png"
    case "jpg":
    case "jpeg": return "image/jpeg"
    case "webp": return "image/webp"
    case "gif": return "image/gif"
    case "heic": return "image/heic"
    case "tif":
    case "tiff": return "image/tiff"
    default: return null
  }
}

/**
 * The mime type to hand the reader for a stored upload. Storage reports the type the CLIENT'S browser gave; when it gave none the wizard
 * stores `application/octet-stream`, which the reader refuses — so a generic or missing type falls back to what the file name says,
 * and only then to PDF (the Articles slot's normal file).
 */
export function pickOcrMimeType(storedType: string | null | undefined, fileMime: string | null): string {
  const stored = (storedType ?? "").trim()
  if (stored && stored !== "application/octet-stream") return stored
  return fileMime || "application/pdf"
}
