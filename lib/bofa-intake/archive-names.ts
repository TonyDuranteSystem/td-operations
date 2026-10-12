/**
 * Bank application intake — naming for the CRM Storage archive (pure, no database).
 *
 * Antonio's layout (2026-10-12), inside the Business area:
 *   Business › BofA › Standalone Applications › <client name>                 (no third party)
 *   Business › BofA › Partner › <partner name> › <client name>                (a partner brought the client)
 * with the six documents and "Application answers.pdf" inside the client folder. The folders "BofA", "Partner" and
 * "Standalone Applications" are his own; `store_ensure_folder_path` finds them by name (any letter case) and only creates
 * one that is missing. The client folder is named with the client's name ONLY: a second application from someone with the
 * same name lands in the same folder and its files get " (2)" (the writer never overwrites).
 */

import { BOFA_DOC_SLOTS } from "./schema"

export const BOFA_ROOT_FOLDER = "BofA"
export const BOFA_PARTNER_FOLDER = "Partner"
export const BOFA_STANDALONE_FOLDER = "Standalone Applications"
export const BOFA_ANSWERS_FILE = "Application answers.pdf"

/** A name the store accepts: no / \ or control characters, whitespace collapsed, bounded. Never throws. */
export function safePart(input: string | null | undefined, fallback: string, max = 120): string {
  // eslint-disable-next-line no-control-regex -- control characters are what the store refuses
  const cleaned = (input ?? "").replace(/[\\/\u0000-\u001f\u007f]+/g, "-").replace(/\s+/g, " ").trim()
  const cut = cleaned.slice(0, max).trim()
  return cut && cut !== "." && cut !== ".." ? cut : fallback
}

/** The client's folder: just their name (never empty, never carrying a character the store refuses). */
export function clientFolderName(fullName: string | null | undefined): string {
  return safePart(fullName, "Applicant", 120)
}

export function folderPath(p: { partner?: string | null; fullName?: string | null }): string[] {
  const client = clientFolderName(p.fullName)
  const partner = (p.partner ?? "").trim()
  return partner
    ? [BOFA_ROOT_FOLDER, BOFA_PARTNER_FOLDER, safePart(partner, "Partner", 120), client]
    : [BOFA_ROOT_FOLDER, BOFA_STANDALONE_FOLDER, client]
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
}

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name)
  return m ? m[1].toLowerCase() : ""
}

export function mimeForName(name: string): string {
  return MIME_BY_EXT[extOf(name)] ?? "application/octet-stream"
}

/** The file's name in Storage: the box it came from ("Passport photo page.pdf"), not the applicant's own file name. */
export function storedFileName(slotKey: string, originalName: string): string {
  const label = BOFA_DOC_SLOTS.find((s) => s.key === slotKey)?.label ?? slotKey
  const ext = extOf(originalName)
  return safePart(ext ? `${label}.${ext}` : label, "Document", 150)
}
