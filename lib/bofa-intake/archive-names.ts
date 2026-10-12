/**
 * Bank application intake — naming for the CRM Storage archive (pure, no database).
 * Layout: Business › BofA › <partner, or "Direct" when no third party brought the client> › <date applicant - company (id)> › the documents + "Application answers.pdf".
 * The folder name carries the request id so two applicants with the same name can never merge into one folder
 * (a merge would make a re-submission look "unchanged" and hide files).
 */

import { BOFA_DOC_SLOTS } from "./schema"

export const BOFA_ROOT_FOLDER = "BofA"
export const BOFA_ANSWERS_FILE = "Application answers.pdf"

/** A name the store accepts: no / \ or control characters, whitespace collapsed, bounded. Never throws. */
export function safePart(input: string | null | undefined, fallback: string, max = 120): string {
  // eslint-disable-next-line no-control-regex -- control characters are what the store refuses
  const cleaned = (input ?? "").replace(/[\\/\u0000-\u001f\u007f]+/g, "-").replace(/\s+/g, " ").trim()
  const cut = cleaned.slice(0, max).trim()
  return cut && cut !== "." && cut !== ".." ? cut : fallback
}

export function applicantFolderName(p: { id: string; fullName?: string | null; company?: string | null; submittedAt?: string | null }): string {
  const date = (p.submittedAt ?? "").slice(0, 10) || "undated"
  const who = safePart(p.fullName, "Applicant", 60)
  const company = p.company ? ` - ${safePart(p.company, "", 60)}` : ""
  return `${date} ${who}${company} (${p.id.replace(/-/g, "").slice(0, 6)})`
}

export function folderPath(p: { id: string; partner?: string | null; fullName?: string | null; company?: string | null; submittedAt?: string | null }): string[] {
  return [BOFA_ROOT_FOLDER, safePart(p.partner, "Direct"), applicantFolderName(p)]
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
